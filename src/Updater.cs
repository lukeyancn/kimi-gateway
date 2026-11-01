// 检查更新：比对 GitHub Releases 里的最新 tag 与本地版本。
//
// 只做"查"和"下载压缩包到下载目录"，不自动替换正在运行的 exe —— 托盘进程
// 锁着自身文件，静默替换容易留下半截状态。替换动作留给用户解压覆盖。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace KimiBridge
{
    internal sealed class ReleaseAsset
    {
        public string Name;
        public string Url;
        public long Size;
    }

    internal sealed class UpdateResult
    {
        public bool Ok;
        public string Error;
        public string Protocols = "";
        public string Tag = "";
        public string HtmlUrl = "";
        public string Notes = "";
        public Version Latest;
        public readonly List<ReleaseAsset> Assets = new List<ReleaseAsset>();
    }

    internal static class Updater
    {
        // 默认仓库；包内 update.json 可以覆盖，换仓库不用重编译。
        public const string DefaultRepo = "lukeyancn/kimi-gateway";
        private const string DefaultApiBase = "https://api.github.com";
        private const int CheckTimeoutMs = 12000;
        private const int DownloadTimeoutMs = 120000;

        public static string AppVersion
        {
            get { return Bridge.AppVersion; }
        }

        public static Version CurrentVersion
        {
            get { return ParseVersion(AppVersion) ?? new Version(0, 0, 0); }
        }

        private static string ConfigPath
        {
            get { return Path.Combine(Bridge.AppDir, "update.json"); }
        }

        private static Dictionary<string, object> ReadConfig()
        {
            try
            {
                if (!File.Exists(ConfigPath)) return null;
                string text = File.ReadAllText(ConfigPath, Encoding.UTF8);
                var serializer = new JavaScriptSerializer();
                return serializer.Deserialize<Dictionary<string, object>>(text);
            }
            catch (Exception err)
            {
                Bridge.WriteTrayLog("update.json unreadable: " + err.Message);
                return null;
            }
        }

        private static string ConfigString(string key)
        {
            var config = ReadConfig();
            if (config == null) return null;
            object value;
            if (!config.TryGetValue(key, out value) || value == null) return null;
            string text = value.ToString().Trim();
            return text.Length > 0 ? text : null;
        }

        public static string Repo
        {
            get { return ConfigString("repo") ?? DefaultRepo; }
        }

        private static string ApiBase
        {
            get { return (ConfigString("apiBase") ?? DefaultApiBase).TrimEnd('/'); }
        }

        private static string AssetHint
        {
            get { return ConfigString("assetHint"); }
        }

        public static Version ParseVersion(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            string value = text.Trim();
            if (value.StartsWith("v", StringComparison.OrdinalIgnoreCase)) value = value.Substring(1);
            int dash = value.IndexOf('-');
            if (dash > 0) value = value.Substring(0, dash);
            int plus = value.IndexOf('+');
            if (plus > 0) value = value.Substring(0, plus);

            string[] parts = value.Split('.');
            if (parts.Length == 0) return null;
            var numbers = new int[4];
            for (int i = 0; i < parts.Length && i < 4; i++)
            {
                int parsed;
                if (!int.TryParse(parts[i], NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return null;
                numbers[i] = parsed;
            }
            return new Version(numbers[0], numbers[1], numbers[2], numbers[3]);
        }

        // 阻塞调用：菜单点下去后放到后台线程跑。
        public static UpdateResult Check()
        {
            var result = new UpdateResult();
            ApplyTls();
            result.Protocols = ServicePointManager.SecurityProtocol.ToString();
            string url = ApiBase + "/repos/" + Repo + "/releases/latest";
            try
            {
                string body = FetchWithFallback(url);
                var serializer = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
                var payload = serializer.Deserialize<Dictionary<string, object>>(body);
                if (payload == null)
                {
                    result.Error = "GitHub 返回了空内容。";
                    return result;
                }

                object tag;
                if (!payload.TryGetValue("tag_name", out tag) || tag == null)
                {
                    result.Error = "GitHub 响应里没有 tag_name。";
                    return result;
                }

                result.Tag = tag.ToString();
                object html;
                if (payload.TryGetValue("html_url", out html) && html != null) result.HtmlUrl = html.ToString();
                object notes;
                if (payload.TryGetValue("body", out notes) && notes != null) result.Notes = notes.ToString();

                Version latest = ParseVersion(result.Tag);
                if (latest == null)
                {
                    result.Error = "看不懂的版本号：" + result.Tag;
                    return result;
                }
                result.Latest = latest;

                object assets;
                if (payload.TryGetValue("assets", out assets))
                {
                    // JavaScriptSerializer hands back ArrayList for arrays
                    // (object[] only when the cast target is an array), so walk
                    // it as a plain enumerable.
                    var list = assets as System.Collections.IEnumerable;
                    if (list != null)
                    {
                        foreach (object item in list)
                        {
                            var map = item as Dictionary<string, object>;
                            if (map == null) continue;
                            var asset = new ReleaseAsset();
                            object name;
                            if (map.TryGetValue("name", out name) && name != null) asset.Name = name.ToString();
                            object dl;
                            if (map.TryGetValue("browser_download_url", out dl) && dl != null) asset.Url = dl.ToString();
                            object size;
                            if (map.TryGetValue("size", out size) && size != null)
                            {
                                long parsed;
                                if (long.TryParse(size.ToString(), out parsed)) asset.Size = parsed;
                            }
                            if (!string.IsNullOrEmpty(asset.Url)) result.Assets.Add(asset);
                        }
                    }
                }

                result.Ok = true;
                return result;
            }
            catch (WebException err)
            {
                var response = err.Response as HttpWebResponse;
                if (response != null)
                {
                    int code = (int)response.StatusCode;
                    string detail = SafeReadBody(response);
                    if (code == 404)
                        result.Error = "仓库或发布不存在（" + Repo + "）。可能还没发布任何版本。";
                    else if (code == 403)
                        result.Error = "GitHub 拒绝访问（HTTP 403）" + (detail.Length > 0 ? "：" + detail : "，多半是接口限流，过几分钟再试。");
                    else
                        result.Error = "GitHub 返回 HTTP " + code + (detail.Length > 0 ? "：" + detail : "");
                }
                else
                {
                    result.Error = err.Status == WebExceptionStatus.Timeout
                        ? "连接 GitHub 超时，检查网络或代理。"
                        : "网络错误：" + err.Message;
                }
                return result;
            }
            catch (Exception err)
            {
                result.Error = err.Message;
                return result;
            }
        }

        // 老 .NET 默认只协商 SSL3/TLS1.0，GitHub 早已拒绝。逐级降低要求地打开新版协议。
        private static void ApplyTls()
        {
            int[] attempts = { 3072 | 12288 /* Tls12|Tls13 */, 3072 /* Tls12 */, 0 /* SystemDefault */ };
            foreach (int value in attempts)
            {
                try
                {
                    ServicePointManager.SecurityProtocol = (SecurityProtocolType)value;
                    return;
                }
                catch
                {
                    // 试下一个
                }
            }
        }

        private static string SafeReadBody(HttpWebResponse response)
        {
            try
            {
                using (Stream stream = response.GetResponseStream())
                {
                    if (stream == null) return "";
                    using (var reader = new StreamReader(stream, Encoding.UTF8))
                    {
                        string text = reader.ReadToEnd();
                        if (text.Length > 300) text = text.Substring(0, 300);
                        try
                        {
                            var serializer = new JavaScriptSerializer();
                            var map = serializer.Deserialize<Dictionary<string, object>>(text);
                            object message;
                            if (map != null && map.TryGetValue("message", out message) && message != null)
                                return message.ToString();
                        }
                        catch
                        {
                            // 原样返回
                        }
                        return text.Replace((char)10, (char)32).Replace((char)13, (char)32).Trim();
                    }
                }
            }
            catch
            {
                return "";
            }
        }

        // 先直连、失败再走系统代理：开着代理软件时出口 IP 常被 GitHub 限流，
        // 而纯代理环境又必须经代理才能出去，两条路都试一遍最稳。
        private static string FetchWithFallback(string url)
        {
            WebException first = null;
            foreach (bool useProxy in new[] { false, true })
            {
                try
                {
                    return HttpGet(url, useProxy);
                }
                catch (WebException err)
                {
                    var response = err.Response as HttpWebResponse;
                    if (response != null && (int)response.StatusCode == 404) throw;
                    if (first == null) first = err;
                }
            }
            throw first ?? new WebException("无法连接 GitHub。");
        }

        private static string HttpGet(string url, bool useProxy)
        {
            var request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "GET";
            request.UserAgent = "KimiModelBridge/" + AppVersion;
            request.Accept = "application/vnd.github+json";
            request.Timeout = CheckTimeoutMs;
            request.ReadWriteTimeout = CheckTimeoutMs;
            request.KeepAlive = false;
            if (!useProxy) request.Proxy = null;

            using (var response = (HttpWebResponse)request.GetResponse())
            using (var stream = response.GetResponseStream())
            {
                if (stream == null) return "";
                using (var reader = new StreamReader(stream, Encoding.UTF8))
                {
                    return reader.ReadToEnd();
                }
            }
        }

        // 优先按 update.json 的 assetHint 选，其次按当前包形态猜。
        public static ReleaseAsset PickAsset(UpdateResult result)
        {
            if (result.Assets.Count == 0) return null;
            string hint = AssetHint;
            if (string.IsNullOrEmpty(hint)) hint = Bridge.BundledNode != null ? "portable" : "share";

            foreach (ReleaseAsset asset in result.Assets)
            {
                if (asset.Name.IndexOf(hint, StringComparison.OrdinalIgnoreCase) >= 0) return asset;
            }
            foreach (ReleaseAsset asset in result.Assets)
            {
                if (asset.Name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)) return asset;
            }
            return result.Assets[0];
        }

        public static string Download(ReleaseAsset asset)
        {
            string downloads = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
            if (!Directory.Exists(downloads)) downloads = Bridge.AppDir;

            string target = Path.Combine(downloads, asset.Name);
            string partial = target + ".part";

            var request = (HttpWebRequest)WebRequest.Create(asset.Url);
            request.Method = "GET";
            request.UserAgent = "KimiModelBridge/" + AppVersion;
            request.Timeout = 20000;
            request.ReadWriteTimeout = DownloadTimeoutMs;
            request.AllowAutoRedirect = true;

            using (var response = (HttpWebResponse)request.GetResponse())
            using (Stream remote = response.GetResponseStream())
            using (var local = new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                if (remote == null) throw new IOException("下载流为空");
                var buffer = new byte[81920];
                int read;
                while ((read = remote.Read(buffer, 0, buffer.Length)) > 0)
                {
                    local.Write(buffer, 0, read);
                }
            }

            if (File.Exists(target)) File.Delete(target);
            File.Move(partial, target);
            return target;
        }

        public static void OpenUrl(string url)
        {
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch (Exception err)
            {
                Bridge.WriteTrayLog("open url failed: " + err.Message);
            }
        }

        public static void ShowInExplorer(string file)
        {
            try
            {
                Process.Start("explorer.exe", "/select,\"" + file + "\"");
            }
            catch (Exception err)
            {
                Bridge.WriteTrayLog("explorer failed: " + err.Message);
            }
        }
    }

    // 有新版本时的对话框：版本对比 + 发布说明 + 下载 / 打开发布页。
    internal sealed class UpdateDialog : Form
    {
        private readonly Label _progress;
        private readonly Button _downloadButton;
        private readonly ReleaseAsset _asset;
        private bool _downloading;

        public UpdateDialog(UpdateResult result)
        {
            SuspendLayout();

            Text = "发现新版本";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(520, 420);
            Font = SystemFonts.MessageBoxFont;
            ShowIcon = false;

            _asset = Updater.PickAsset(result);

            var title = new Label
            {
                Text = "有新版本 " + result.Tag + "（当前 " + Updater.AppVersion + "）",
                Font = new Font(Font.FontFamily, 11.5f, FontStyle.Bold),
                AutoSize = false,
                Location = new Point(20, 18),
                Size = new Size(480, 26),
            };

            string subtitleText = _asset != null
                ? "安装包 " + _asset.Name + ( _asset.Size > 0 ? "（" + FormatSize(_asset.Size) + "）" : "")
                : "该发布没有附压缩包，只能打开网页下载。";
            var subtitle = new Label
            {
                Text = subtitleText,
                ForeColor = Color.FromArgb(110, 110, 118),
                AutoSize = false,
                Location = new Point(20, 46),
                Size = new Size(480, 20),
            };

            string notes = string.IsNullOrEmpty(result.Notes) ? "（这条发布没有写说明）" : NormalizeNotes(result.Notes);
            if (notes.Length > 1800) notes = notes.Substring(0, 1800) + "…";

            var body = new TextBox
            {
                Text = notes,
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                BorderStyle = BorderStyle.FixedSingle,
                BackColor = Color.FromArgb(250, 250, 252),
                Location = new Point(20, 76),
                Size = new Size(480, 240),
                Font = new Font(Font.FontFamily, 9f),
                WordWrap = true,
            };

            _progress = new Label
            {
                Text = "",
                ForeColor = Color.FromArgb(110, 110, 118),
                AutoSize = false,
                Location = new Point(20, 326),
                Size = new Size(480, 20),
            };

            var openButton = new Button
            {
                Text = "打开发布页",
                Location = new Point(20, 366),
                Size = new Size(116, 32),
            };
            openButton.Click += delegate
            {
                if (!string.IsNullOrEmpty(result.HtmlUrl)) Updater.OpenUrl(result.HtmlUrl);
            };

            _downloadButton = new Button
            {
                Text = "下载安装包",
                Location = new Point(268, 366),
                Size = new Size(126, 32),
                Enabled = _asset != null,
            };
            _downloadButton.Click += delegate { StartDownload(); };

            var closeButton = new Button
            {
                Text = "以后再说",
                DialogResult = DialogResult.Cancel,
                Location = new Point(400, 366),
                Size = new Size(100, 32),
            };


            AcceptButton = _downloadButton;
            CancelButton = closeButton;

            Controls.AddRange(new Control[]
            {
                title, subtitle, body, _progress, openButton, _downloadButton, closeButton,
            });

            ResumeLayout(false);
        }

        // TextBox 只认 CRLF；顺带去掉 markdown 标题井号，正文更干净。
        // TextBox 只认 CRLF；顺带去掉 markdown 标题井号，正文更干净。
        private static string NormalizeNotes(string raw)
        {
            char[] breaks = new[] { (char)13, (char)10 };
            string[] lines = raw.Split(breaks, StringSplitOptions.RemoveEmptyEntries);
            var builder = new StringBuilder();
            foreach (string line in lines)
            {
                string text = line.TrimEnd();
                int hashes = 0;
                while (hashes < 6 && hashes < text.Length && text[hashes] == (char)35) hashes++;
                if (hashes > 0 && hashes < text.Length && text[hashes] == (char)32)
                {
                    text = text.Substring(hashes + 1);
                }
                builder.Append(text.Replace("*", "").Replace("`", ""));
                builder.Append(Environment.NewLine);
            }
            return builder.ToString().TrimEnd();
        }

        private static string FormatSize(long bytes)
        {
            if (bytes >= 1024L * 1024) return (bytes / 1048576.0).ToString("0.#") + " MB";
            if (bytes >= 1024) return (bytes / 1024.0).ToString("0.#") + " KB";
            return bytes + " B";
        }

        private void StartDownload()
        {
            if (_downloading || _asset == null) return;
            _downloading = true;
            _downloadButton.Enabled = false;
            _progress.Text = "正在下载 " + _asset.Name + "…";

            ThreadPool.QueueUserWorkItem(delegate
            {
                string error = null;
                string saved = null;
                try
                {
                    saved = Updater.Download(_asset);
                }
                catch (Exception err)
                {
                    error = err.Message;
                    Bridge.WriteTrayLog("update download failed: " + err.Message);
                }

                try
                {
                    BeginInvoke((Action)delegate
                    {
                        _downloading = false;
                        _downloadButton.Enabled = true;
                        if (error == null)
                        {
                            _progress.Text = "已保存到 " + saved;
                            MessageBox.Show(
                                this,
                                "下载完成：\n" + saved + "\n\n退出托盘程序后，把压缩包解压覆盖到原目录即可。",
                                "下载完成",
                                MessageBoxButtons.OK,
                                MessageBoxIcon.Information);
                            Updater.ShowInExplorer(saved);
                        }
                        else
                        {
                            _progress.Text = "下载失败：" + error;
                        }
                    });
                }
                catch
                {
                    // 窗口已关闭
                }
            });
        }
    }
}
