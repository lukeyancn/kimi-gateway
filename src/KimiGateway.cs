// Kimi 模型桥 · 托盘启动器
//
// 双击运行 → 托盘常驻 + 拉起 node proxy.mjs；退出时带走子进程。
// 右键菜单：打开控制台 / 启动 / 停止 / 重启 / 开机自启 / 配置目录 / 日志 / 退出。
//
// 编译：src\build.ps1（依赖 Windows 自带的 .NET Framework csc.exe，无需 SDK）

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using WinTimer = System.Windows.Forms.Timer;

[assembly: AssemblyVersion("1.1.0.0")]
[assembly: AssemblyFileVersion("1.1.0.0")]
[assembly: AssemblyTitle("Kimi 模型桥")]
[assembly: AssemblyProduct("Kimi 模型桥")]
[assembly: AssemblyDescription("把 OpenAI 兼容模型接进 Kimi 的本地网关")]

namespace KimiBridge
{
    // ---------------------------------------------------------------- service

    internal static class Bridge
    {
        public const string MutexName = "KimiModelBridge.Tray.SingleInstance";
        public const string DisplayName = "Kimi 模型桥";

        // 版本号唯一来源：改这里，同时改程序集属性与 proxy.mjs 的 VERSION。
        // src/pack.py 会做一致性校验。
        public const string AppVersion = "1.1.0";

        private static readonly object Gate = new object();
        private static readonly object LogGate = new object();
        private static Process _child;
        private static IntPtr _job = IntPtr.Zero;

        public static string AppDir
        {
            get { return Path.GetDirectoryName(Application.ExecutablePath); }
        }

        public static string ProxyPath
        {
            get { return Path.Combine(AppDir, "proxy.mjs"); }
        }

        public static string ConfigPath
        {
            get { return Path.Combine(AppDir, "config.json"); }
        }

        public static string LogPath
        {
            get { return Path.Combine(AppDir, "proxy.out.log"); }
        }

        public static string TrayLogPath
        {
            get { return Path.Combine(AppDir, "tray.log"); }
        }

        public static string NodePath
        {
            get { return ResolveNode(); }
        }

        // A bundled runtime wins over any system install, so the portable
        // package behaves identically on machines without Node.js.
        public static string BundledNode
        {
            get
            {
                string a = Path.Combine(AppDir, "node.exe");
                if (File.Exists(a)) return a;
                string b = Path.Combine(AppDir, "runtime", "node.exe");
                if (File.Exists(b)) return b;
                return null;
            }
        }

        private static string ResolveNode()
        {
            string bundled = BundledNode;
            if (bundled != null) return bundled;

            // Literal install locations first: the ProgramFiles variable is not
            // always inherited (services, some launchers), but the default
            // Node.js install path is stable across machines.
            var candidates = new List<string>
            {
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Program Files (x86)\nodejs\node.exe",
            };
            string pf = Environment.GetEnvironmentVariable("ProgramFiles");
            string pf86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)");
            string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            if (!string.IsNullOrEmpty(pf)) candidates.Add(Path.Combine(pf, "nodejs", "node.exe"));
            if (!string.IsNullOrEmpty(pf86)) candidates.Add(Path.Combine(pf86, "nodejs", "node.exe"));
            if (!string.IsNullOrEmpty(local)) candidates.Add(Path.Combine(local, "Programs", "nodejs", "node.exe"));

            foreach (string path in candidates)
            {
                if (File.Exists(path)) return path;
            }

            try
            {
                var info = new ProcessStartInfo("where.exe", "node.exe")
                {
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    CreateNoWindow = true,
                };
                using (Process p = Process.Start(info))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(2000);
                    foreach (string line in output.Split('\n'))
                    {
                        string trimmed = line.Trim();
                        if (trimmed.Length > 0 && File.Exists(trimmed)) return trimmed;
                    }
                }
            }
            catch
            {
                // fall through: caller reports the missing runtime
            }

            try
            {
                using (RegistryKey key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Node.js"))
                {
                    if (key != null)
                    {
                        object dir = key.GetValue("InstallPath");
                        if (dir != null)
                        {
                            string exe = Path.Combine(dir.ToString(), "node.exe");
                            if (File.Exists(exe)) return exe;
                        }
                    }
                }
            }
            catch
            {
                // registry unavailable
            }
            return null;
        }

        // Shipped packages carry no config.json (it holds API keys). A blank
        // one lets the gateway boot straight into an empty WebUI instead of
        // exiting with a config error.
        public static string EnsureConfig()
        {
            try
            {
                if (File.Exists(ConfigPath)) return null;
                const string template = "{\n  \"port\": 8787,\n  \"providers\": []\n}\n";
                File.WriteAllText(ConfigPath, template, new UTF8Encoding(false));
                WriteTrayLog("created empty config.json");
                return null;
            }
            catch (Exception err)
            {
                WriteTrayLog("ensure config failed: " + err.Message);
                return err.Message;
            }
        }

        // Port is re-read on every use so editing config.json takes effect on
        // the next restart instead of needing a relaunch of the tray app.
        public static int ReadPort()
        {
            try
            {
                string text = File.ReadAllText(ConfigPath);
                Match match = Regex.Match(text, "\"port\"\\s*:\\s*(\\d+)");
                if (match.Success)
                {
                    int port;
                    if (int.TryParse(match.Groups[1].Value, out port) && port > 0 && port < 65536) return port;
                }
            }
            catch
            {
                // keep the default
            }
            return 8787;
        }

        public static string BaseUrl
        {
            get { return "http://127.0.0.1:" + ReadPort() + "/v1"; }
        }

        public static string ConsoleUrl
        {
            get { return "http://127.0.0.1:" + ReadPort() + "/"; }
        }

        public static bool IsHealthy()
        {
            return ProbeHealth(ReadPort());
        }

        public static bool ProbeHealth(int port)
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/health");
                request.Timeout = 1200;
                request.ReadWriteTimeout = 1200;
                request.Proxy = null;
                request.KeepAlive = false;
                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    return (int)response.StatusCode == 200;
                }
            }
            catch
            {
                return false;
            }
        }

        public static bool OwnsChild
        {
            get
            {
                lock (Gate)
                {
                    try
                    {
                        return _child != null && !_child.HasExited;
                    }
                    catch
                    {
                        return false;
                    }
                }
            }
        }

        public static int ChildPid
        {
            get
            {
                lock (Gate)
                {
                    try
                    {
                        return _child != null && !_child.HasExited ? _child.Id : 0;
                    }
                    catch
                    {
                        return 0;
                    }
                }
            }
        }

        // Returns null on success, otherwise a human readable failure reason.
        public static string Start(bool force)
        {
            lock (Gate)
            {
                if (!force && IsHealthy()) return null;

                if (!File.Exists(ProxyPath)) return "找不到 proxy.mjs，exe 需要和它是同一个目录。";

                EnsureConfig();

                string node = ResolveNode();
                if (node == null)
                    return "找不到 node.exe。请安装 Node.js（https://nodejs.org），或把 node.exe 放到本程序同目录。";

                if (OwnsChild) return null;

                try
                {
                    string log = LogPath;
                    if (File.Exists(log) && new FileInfo(log).Length > 5 * 1024 * 1024) File.Delete(log);
                }
                catch
                {
                    // a locked log is not worth failing the start
                }

                var info = new ProcessStartInfo(node, "\"" + ProxyPath + "\"")
                {
                    WorkingDirectory = AppDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };

                try
                {
                    _child = Process.Start(info);
                }
                catch (Exception err)
                {
                    WriteTrayLog("start failed: " + err.Message);
                    return "启动 node 失败：" + err.Message;
                }

                if (_child == null) return "启动 node 失败：进程没有创建。";

                _child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args)
                {
                    if (args.Data != null) AppendProxyLog("proxy.out.log", args.Data);
                };
                _child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
                {
                    if (args.Data != null) AppendProxyLog("proxy.err.log", args.Data);
                };
                _child.BeginOutputReadLine();
                _child.BeginErrorReadLine();

                AttachToJob(_child);
                WriteTrayLog("started node pid=" + _child.Id + " port=" + ReadPort());
                return null;
            }
        }

        public static void Stop(bool killOrphans)
        {
            Process child;
            lock (Gate)
            {
                child = _child;
                _child = null;
            }

            if (child != null)
            {
                try
                {
                    if (!child.HasExited) child.Kill();
                    child.WaitForExit(4000);
                }
                catch
                {
                    // already gone
                }
            }

            if (killOrphans) KillProxyProcesses(0);
            WriteTrayLog("stopped");
        }

        public static int StopAndWait()
        {
            Stop(true);
            for (int i = 0; i < 20; i++)
            {
                if (!IsHealthy()) return i * 150;
                Thread.Sleep(150);
            }
            return -1;
        }

        // Finds the node.exe that owns our port. netstat instead of WMI: the
        // WMI query can block for tens of seconds on cold machines.
        public static List<int> FindProxyProcesses()
        {
            var found = new List<int>();
            int port = ReadPort();
            try
            {
                var info = new ProcessStartInfo("netstat.exe", "-ano -p TCP")
                {
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    CreateNoWindow = true,
                };
                using (Process p = Process.Start(info))
                {
                    if (p == null) return found;
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(5000);
                    foreach (string line in output.Split('\n'))
                    {
                        string trimmed = line.Trim();
                        if (trimmed.Length == 0) continue;
                        if (trimmed.IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) < 0) continue;
                        string[] parts = trimmed.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                        if (parts.Length < 5) continue;
                        if (!parts[1].EndsWith(":" + port, StringComparison.Ordinal)) continue;
                        int pid;
                        if (!int.TryParse(parts[parts.Length - 1], out pid)) continue;
                        if (pid == Process.GetCurrentProcess().Id) continue;
                        if (!IsNode(pid)) continue;
                        if (!found.Contains(pid)) found.Add(pid);
                    }
                }
            }
            catch
            {
                // netstat missing: caller just falls back to the child handle
            }
            return found;
        }

        private static bool IsNode(int pid)
        {
            try
            {
                using (Process p = Process.GetProcessById(pid))
                {
                    return string.Equals(p.ProcessName, "node", StringComparison.OrdinalIgnoreCase);
                }
            }
            catch
            {
                return false;
            }
        }

        public static int KillProxyProcesses(int exceptPid)
        {
            int killed = 0;
            foreach (int pid in FindProxyProcesses())
            {
                if (pid == exceptPid || pid == Process.GetCurrentProcess().Id) continue;
                try
                {
                    using (Process p = Process.GetProcessById(pid))
                    {
                        p.Kill();
                        p.WaitForExit(3000);
                        killed++;
                        WriteTrayLog("killed orphan node pid=" + pid);
                    }
                }
                catch
                {
                    // raced with another shutdown
                }
            }
            return killed;
        }

        public static void WriteTrayLog(string message)
        {
            try
            {
                string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine;
                lock (LogGate) File.AppendAllText(TrayLogPath, line, Encoding.UTF8);
            }
            catch
            {
                // logging must never break the launcher
            }
        }

        private static void AppendProxyLog(string fileName, string message)
        {
            try
            {
                string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine;
                lock (LogGate) File.AppendAllText(Path.Combine(AppDir, fileName), line, Encoding.UTF8);
            }
            catch
            {
                // logging must never break the launcher
            }
        }

        // Last few error lines, used when a start attempt dies immediately.
        public static string TailLog(int lines)
        {
            try
            {
                if (!File.Exists(LogPath)) return "";
                string[] all = File.ReadAllLines(LogPath);
                int take = Math.Min(lines, all.Length);
                var builder = new StringBuilder();
                for (int i = all.Length - take; i < all.Length; i++)
                {
                    builder.AppendLine(all[i]);
                }
                return builder.ToString().Trim();
            }
            catch
            {
                return "";
            }
        }

        // ------------------------------------------------------------- job object
        // Keeps the node child from outliving a crashed/force-killed tray app.

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x2000;

        private static void AttachToJob(Process child)
        {
            try
            {
                if (_job == IntPtr.Zero)
                {
                    _job = CreateJobObject(IntPtr.Zero, null);
                    if (_job != IntPtr.Zero)
                    {
                        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                        info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
                        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                        IntPtr buffer = Marshal.AllocHGlobal(size);
                        try
                        {
                            Marshal.StructureToPtr(info, buffer, false);
                            SetInformationJobObject(_job, JobObjectExtendedLimitInformation, buffer, (uint)size);
                        }
                        finally
                        {
                            Marshal.FreeHGlobal(buffer);
                        }
                    }
                }
                if (_job != IntPtr.Zero) AssignProcessToJobObject(_job, child.Handle);
            }
            catch
            {
                // non-fatal: explicit kill on exit still covers the normal path
            }
        }
    }

    // --------------------------------------------------------------- tray menu

    internal class TrayApp : ApplicationContext
    {
        private readonly NotifyIcon _tray;
        private readonly ContextMenuStrip _menu;
        private readonly Control _pump;

        private readonly ToolStripMenuItem _statusItem;
        private readonly ToolStripMenuItem _openItem;
        private readonly ToolStripMenuItem _copyItem;
        private readonly ToolStripMenuItem _startItem;
        private readonly ToolStripMenuItem _stopItem;
        private readonly ToolStripMenuItem _restartItem;
        private readonly ToolStripMenuItem _autoItem;
        private readonly ToolStripMenuItem _folderItem;
        private readonly ToolStripMenuItem _logItem;
        private readonly ToolStripMenuItem _updateItem;
        private readonly ToolStripMenuItem _quitItem;

        private readonly Icon _iconOn;
        private readonly Icon _iconOff;
        private readonly WinTimer _poll;
        private readonly WinTimer _deferred;
        private readonly WinTimer _restartTimer;

        private bool _healthy;
        private bool _busy;
        private bool _checking;
        private bool _intentQuit;
        private int _autoRestarts;
        private DateTime _restartWindow = DateTime.MinValue;
        private Action _deferredAction;

        public TrayApp()
        {
            _iconOn = LoadIcon("icon-on.ico") ?? SystemIcons.Application;
            _iconOff = LoadIcon("icon-off.ico") ?? SystemIcons.Application;

            // A handle-only control: lets worker threads marshal back onto the
            // UI thread without creating a visible window.
            _pump = new Control();
            _pump.CreateControl();
            IntPtr unused = _pump.Handle;
            GC.KeepAlive(unused);

            _statusItem = new ToolStripMenuItem("正在检查…") { Enabled = false };
            _statusItem.Font = new Font(_statusItem.Font, FontStyle.Bold);

            _openItem = new ToolStripMenuItem("打开 WebUI", null, delegate { OpenConsole(); });
            _openItem.Font = new Font(_openItem.Font, FontStyle.Bold);
            _copyItem = new ToolStripMenuItem("复制 Base URL", null, delegate { CopyBaseUrl(); });

            _startItem = new ToolStripMenuItem("启动服务", null, delegate { StartService(false); });
            _stopItem = new ToolStripMenuItem("停止服务", null, delegate { StopService(); });
            _restartItem = new ToolStripMenuItem("重启服务", null, delegate { RestartService(); });

            _autoItem = new ToolStripMenuItem("开机自启", null, delegate { ToggleAutostart(); });
            _autoItem.CheckOnClick = false;

            _folderItem = new ToolStripMenuItem("打开配置目录", null, delegate { OpenFolder(); });
            _logItem = new ToolStripMenuItem("查看日志", null, delegate { OpenLog(); });
            _updateItem = new ToolStripMenuItem("检查更新…", null, delegate { CheckForUpdates(); });
            _quitItem = new ToolStripMenuItem("退出", null, delegate { QuitApp(); });

            _menu = new ContextMenuStrip();
            _menu.Items.Add(_statusItem);
            _menu.Items.Add(new ToolStripSeparator());
            _menu.Items.Add(_openItem);
            _menu.Items.Add(_copyItem);
            _menu.Items.Add(new ToolStripSeparator());
            _menu.Items.Add(_startItem);
            _menu.Items.Add(_stopItem);
            _menu.Items.Add(_restartItem);
            _menu.Items.Add(new ToolStripSeparator());
            _menu.Items.Add(_autoItem);
            _menu.Items.Add(_folderItem);
            _menu.Items.Add(_logItem);
            _menu.Items.Add(_updateItem);
            _menu.Items.Add(new ToolStripSeparator());
            _menu.Items.Add(_quitItem);

            _tray = new NotifyIcon();
            _tray.Icon = _iconOff;
            _tray.Text = Bridge.DisplayName;
            _tray.ContextMenuStrip = _menu;
            _tray.Visible = true;
            _tray.DoubleClick += delegate { OpenConsole(); };
            _tray.BalloonTipClicked += delegate { OpenConsole(); };

            _poll = new WinTimer();
            _poll.Interval = 3000;
            _poll.Tick += delegate { Refresh(true); };
            _poll.Start();

            _deferred = new WinTimer();
            _deferred.Interval = 400;
            _deferred.Tick += delegate
            {
                _deferred.Stop();
                Action action = _deferredAction;
                _deferredAction = null;
                if (action != null) action();
            };

            _restartTimer = new WinTimer();
            _restartTimer.Interval = 2500;
            _restartTimer.Tick += delegate
            {
                _restartTimer.Stop();
                if (_intentQuit) return;
                if (Bridge.IsHealthy()) return;
                Bridge.WriteTrayLog("auto-restarting after unexpected exit");
                StartService(true);
            };

            EnsureAutostartShortcut();
            UpdateUi();

            // Launching the exe means "make the gateway available".
            _deferredAction = delegate { StartService(false); };
            _deferred.Start();
        }

        // ------------------------------------------------------------ lifecycle

        private static Icon LoadIcon(string name)
        {
            try
            {
                Assembly asm = Assembly.GetExecutingAssembly();
                using (Stream stream = asm.GetManifestResourceStream(name))
                {
                    if (stream == null) return null;
                    return new Icon(stream);
                }
            }
            catch
            {
                return null;
            }
        }

        private void StartService(bool auto)
        {
            if (_busy) return;
            _busy = true;

            if (Bridge.IsHealthy())
            {
                // Port already answered (another launcher, or a leftover node).
                _busy = false;
                Refresh(false);
                if (!auto) ShowBalloon("服务已经在运行", "端口 " + Bridge.ReadPort() + " 已有网关在响应。");
                return;
            }

            string error = Bridge.Start(false);
            _busy = false;

            if (error != null)
            {
                Bridge.WriteTrayLog("start error: " + error);
                _tray.Icon = _iconOff;
                ShowBalloon("启动失败", error);
                UpdateUi();
                return;
            }

            // Give node a moment to bind the port, then report the real result.
            WaitForHealth(6000, delegate(bool ok)
            {
                if (ok)
                {
                    _autoRestarts = 0;
                    if (!auto) ShowBalloon("已启动", "控制台：127.0.0.1:" + Bridge.ReadPort());
                }
                else
                {
                    string tail = Bridge.TailLog(3);
                    ShowBalloon("服务没有起来", tail.Length > 0 ? tail : "端口 " + Bridge.ReadPort() + " 无响应，点开日志看看。");
                }
                Refresh(false);
            });
        }

        private void StopService()
        {
            if (_busy) return;
            _busy = true;
            Bridge.Stop(true);
            _busy = false;
            Refresh(false);
        }

        private void RestartService()
        {
            if (_busy) return;
            _busy = true;
            Bridge.Stop(true);
            string error = Bridge.Start(false);
            _busy = false;
            if (error != null)
            {
                ShowBalloon("重启失败", error);
                Refresh(false);
                return;
            }
            WaitForHealth(6000, delegate(bool ok)
            {
                if (ok) ShowBalloon("已重启", "端口 " + Bridge.ReadPort());
                else ShowBalloon("重启后没有响应", Bridge.TailLog(3));
                Refresh(false);
            });
        }

        private void QuitApp()
        {
            _intentQuit = true;
            _poll.Stop();
            _restartTimer.Stop();
            _tray.Visible = false;
            Bridge.Stop(true);
            _tray.Dispose();
            ExitThread();
        }

        // --------------------------------------------------------------- state

        private void Refresh(bool deep)
        {
            if (_busy || _checking) return;
            _checking = true;
            ThreadPool.QueueUserWorkItem(delegate
            {
                bool ok = Bridge.IsHealthy();
                bool owns = Bridge.OwnsChild;
                Post(delegate
                {
                    _checking = false;
                    bool wasHealthy = _healthy;
                    _healthy = ok;
                    UpdateUi();

                    if (wasHealthy && !ok && !_busy && !_intentQuit && deep)
                    {
                        bool ownsNow = owns;
                        if (ownsNow || _autoRestarts < 3) ScheduleAutoRestart(!ownsNow);
                    }
                });
            });
        }

        private void ScheduleAutoRestart(bool notify)
        {
            if (DateTime.MinValue.Equals(_restartWindow) ||
                (DateTime.Now - _restartWindow).TotalMinutes > 10)
            {
                _restartWindow = DateTime.Now;
                _autoRestarts = 0;
            }
            _autoRestarts++;
            if (_autoRestarts > 3) return;
            if (notify) ShowBalloon("服务已停止", "正在自动重启…");
            _restartTimer.Stop();
            _restartTimer.Start();
        }

        private void UpdateUi()
        {
            bool running = _healthy;
            int port = Bridge.ReadPort();

            _tray.Icon = running ? _iconOn : _iconOff;
            _tray.Text = running
                ? Bridge.DisplayName + " · 运行中 :" + port
                : Bridge.DisplayName + " · 已停止";

            string version = "v" + Bridge.AppVersion;
            _statusItem.Text = running
                ? "● 运行中 · 端口 " + port + " · " + version
                : "○ 已停止 · 端口 " + port + " · " + version;
            _statusItem.ForeColor = running ? Color.FromArgb(22, 140, 90) : Color.FromArgb(120, 120, 130);

            _openItem.Enabled = running;
            _copyItem.Enabled = running;
            _startItem.Enabled = !running;
            _stopItem.Enabled = running;
            _restartItem.Enabled = true;

            bool auto = File.Exists(StartupShortcutPath);
            _autoItem.Checked = auto;
            _autoItem.Text = auto ? "开机自启（已开启）" : "开机自启（已关闭）";
        }

        private void WaitForHealth(int timeoutMs, Action<bool> done)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                int waited = 0;
                bool ok = false;
                while (waited < timeoutMs)
                {
                    if (Bridge.IsHealthy())
                    {
                        ok = true;
                        break;
                    }
                    Thread.Sleep(250);
                    waited += 250;
                }
                Post(delegate { done(ok); });
            });
        }

        private void Post(Action action)
        {
            try
            {
                if (_pump.IsDisposed || !_pump.IsHandleCreated) return;
                _pump.BeginInvoke(action);
            }
            catch
            {
                // shutting down
            }
        }

        // ------------------------------------------------------------- actions

        private void OpenConsole()
        {
            try
            {
                Process.Start(new ProcessStartInfo(Bridge.ConsoleUrl) { UseShellExecute = true });
            }
            catch (Exception err)
            {
                ShowBalloon("打不开浏览器", err.Message);
            }
        }

        private void CopyBaseUrl()
        {
            try
            {
                Clipboard.SetText(Bridge.BaseUrl);
                ShowBalloon("已复制", Bridge.BaseUrl);
            }
            catch (Exception err)
            {
                ShowBalloon("复制失败", err.Message);
            }
        }

        private void OpenFolder()
        {
            try
            {
                Process.Start(new ProcessStartInfo("explorer.exe", "\"" + Bridge.AppDir + "\"") { UseShellExecute = true });
            }
            catch (Exception err)
            {
                ShowBalloon("打不开目录", err.Message);
            }
        }

        private void OpenLog()
        {
            try
            {
                if (!File.Exists(Bridge.LogPath))
                {
                    ShowBalloon("还没有日志", "服务启动后才会生成 proxy.out.log。");
                    return;
                }
                Process.Start(new ProcessStartInfo("notepad.exe", "\"" + Bridge.LogPath + "\"") { UseShellExecute = true });
            }
            catch (Exception err)
            {
                ShowBalloon("打不开日志", err.Message);
            }
        }

        // ------------------------------------------------------------- updates

        private void CheckForUpdates()
        {
            _updateItem.Enabled = false;
            _updateItem.Text = "正在检查更新…";

            ThreadPool.QueueUserWorkItem(delegate
            {
                UpdateResult result = Updater.Check();
                Post(delegate
                {
                    _updateItem.Enabled = true;
                    _updateItem.Text = "检查更新…";
                    ReportUpdate(result);
                });
            });
        }

        private void ReportUpdate(UpdateResult result)
        {
            if (!result.Ok)
            {
                Bridge.WriteTrayLog("update check failed: " + result.Error);
                MessageBox.Show(
                    "检查更新失败：" + Environment.NewLine + result.Error,
                    "检查更新",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return;
            }

            if (result.Latest <= Updater.CurrentVersion)
            {
                MessageBox.Show(
                    "已经是最新版本 v" + Updater.AppVersion + "。" + Environment.NewLine + Environment.NewLine +
                        "仓库：" + Updater.Repo,
                    "检查更新",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                return;
            }

            using (var dialog = new UpdateDialog(result))
            {
                dialog.ShowDialog();
            }
        }

        private void ShowBalloon(string title, string text)
        {
            try
            {
                if (text != null && text.Length > 240) text = text.Substring(0, 237) + "…";
                _tray.BalloonTipTitle = title;
                _tray.BalloonTipText = string.IsNullOrEmpty(text) ? " " : text;
                _tray.BalloonTipIcon = ToolTipIcon.None;
                _tray.ShowBalloonTip(4000);
            }
            catch
            {
                // notifications can be disabled by policy
            }
        }

        // ------------------------------------------------------------ autostart

        private static string StartupShortcutPath
        {
            get
            {
                string startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
                return Path.Combine(startup, "Kimi 模型桥.lnk");
            }
        }

        private static string LegacyStartupScript
        {
            get
            {
                string startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
                return Path.Combine(startup, "KimiDeepSeekProxy.vbs");
            }
        }

        // Replaces the old VBS entry with a shortcut to this exe.
        private static void EnsureAutostartShortcut()
        {
            try
            {
                if (File.Exists(LegacyStartupScript)) File.Delete(LegacyStartupScript);
                if (!File.Exists(StartupShortcutPath)) CreateShortcut();
            }
            catch
            {
                // non-fatal
            }
        }

        private static void CreateShortcut()
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) throw new InvalidOperationException("WScript.Shell 不可用");
            object shell = Activator.CreateInstance(shellType);
            object shortcut = shellType.InvokeMember(
                "CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { StartupShortcutPath });
            Type link = shortcut.GetType();
            link.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { Application.ExecutablePath });
            link.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { Bridge.AppDir });
            link.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut,
                new object[] { Application.ExecutablePath + ",0" });
            link.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut,
                new object[] { "Kimi 模型桥 · 本地多供应商网关" });
            link.InvokeMember("WindowStyle", BindingFlags.SetProperty, null, shortcut, new object[] { 7 });
            link.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        }

        private void ToggleAutostart()
        {
            try
            {
                if (File.Exists(StartupShortcutPath))
                {
                    File.Delete(StartupShortcutPath);
                    ShowBalloon("已关闭开机自启", "下次登录不会再自动启动。");
                }
                else
                {
                    CreateShortcut();
                    ShowBalloon("已开启开机自启", "已加入启动文件夹：" + StartupShortcutPath);
                }
            }
            catch (Exception err)
            {
                ShowBalloon("设置失败", err.Message);
            }
            UpdateUi();
        }
    }

    // ------------------------------------------------------------------ entry

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (Array.IndexOf(args, "--selftest") >= 0) return SelfTest();
            if (Array.IndexOf(args, "--probe") >= 0) return Probe();
            if (Array.IndexOf(args, "--check-update") >= 0) return CheckUpdateConsole(args);
            if (Array.IndexOf(args, "--render-update") >= 0)
            {
                // 离屏渲染对话框到 PNG，不显示在桌面上（避免截屏带走其他窗口）。
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                UpdateResult shot = Updater.Check();
                if (!shot.Ok)
                {
                    File.WriteAllText(Path.Combine(Bridge.AppDir, "render-update.log"), "check failed: " + shot.Error);
                    return 1;
                }
                using (var dialog = new UpdateDialog(shot))
                {
                    dialog.CreateControl();
                    dialog.Show();          // 需要句柄才能绘制，随即藏到屏外
                    dialog.Location = new Point(-4000, -4000);
                    Application.DoEvents();
                    using (var bmp = new Bitmap(dialog.Width, dialog.Height))
                    {
                        dialog.DrawToBitmap(bmp, new Rectangle(0, 0, dialog.Width, dialog.Height));
                        bmp.Save(Path.Combine(Bridge.AppDir, "update-dialog.png"), System.Drawing.Imaging.ImageFormat.Png);
                    }
                    dialog.Hide();
                }
                return 0;
            }

            if (Array.IndexOf(args, "--show-update") >= 0)
            {
                // 仅用于人工核对弹窗排版：查一次并直接显示对话框，不起托盘。
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                UpdateResult preview = Updater.Check();
                if (!preview.Ok)
                {
                    MessageBox.Show(preview.Error, "检查更新失败");
                    return 1;
                }
                using (var dialog = new UpdateDialog(preview))
                {
                    dialog.ShowDialog();
                }
                return 0;
            }

            bool created;
            using (var mutex = new Mutex(true, Bridge.MutexName, out created))
            {
                if (!created)
                {
                    // Second launch: the user wants to see the console, not a
                    // second tray icon.
                    try
                    {
                        Process.Start(new ProcessStartInfo(Bridge.ConsoleUrl) { UseShellExecute = true });
                    }
                    catch
                    {
                        // nothing else to do
                    }
                    return 0;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayApp());
                GC.KeepAlive(mutex);
            }
            return 0;
        }

        // 命令行跑一次更新检查，结果写 update-check.log（供打包验证使用）。
        private static int CheckUpdateConsole(string[] args)
        {
            var report = new StringBuilder();
            try
            {
                report.AppendLine("current=" + Updater.AppVersion);
                report.AppendLine("clr=" + Environment.Version);
                report.AppendLine("repo=" + Updater.Repo);
                UpdateResult result = Updater.Check();
                report.AppendLine("protocols=" + System.Net.ServicePointManager.SecurityProtocol);
                report.AppendLine("ok=" + result.Ok);
                report.AppendLine("error=" + (result.Error ?? ""));
                report.AppendLine("tag=" + result.Tag);
                report.AppendLine("latest=" + (result.Latest != null ? result.Latest.ToString() : ""));
                report.AppendLine("newer=" + (result.Latest != null && result.Latest > Updater.CurrentVersion));
                report.AppendLine("notesLen=" + (result.Notes == null ? 0 : result.Notes.Length));
                report.AppendLine("assets=" + result.Assets.Count);
                ReleaseAsset picked = Updater.PickAsset(result);
                report.AppendLine("picked=" + (picked != null ? picked.Name : "none"));
                report.AppendLine("htmlUrl=" + result.HtmlUrl);

                if (Array.IndexOf(args, "--download-test") >= 0 && picked != null)
                {
                    string saved = Updater.Download(picked);
                    report.AppendLine("downloaded=" + saved);
                    report.AppendLine("downloadedBytes=" + (File.Exists(saved) ? new FileInfo(saved).Length : -1));
                    try { File.Delete(saved); report.AppendLine("cleanup=deleted"); }
                    catch (Exception derr) { report.AppendLine("cleanup=failed " + derr.Message); }
                }
            }
            catch (Exception err)
            {
                report.AppendLine("exception=" + err);
            }
            try
            {
                File.WriteAllText(Path.Combine(Bridge.AppDir, "update-check.log"), report.ToString(), Encoding.UTF8);
            }
            catch
            {
                // nothing to do
            }
            return 0;
        }

        // Reports what the launcher resolved, without binding a port or
        // touching a running instance. Used to verify packaged layouts.
        private static int Probe()
        {
            var report = new StringBuilder();
            string seedError = Bridge.EnsureConfig();
            report.AppendLine("appDir=" + Bridge.AppDir);
            report.AppendLine("proxy=" + Bridge.ProxyPath + (File.Exists(Bridge.ProxyPath) ? " (found)" : " (MISSING)"));
            report.AppendLine("config=" + Bridge.ConfigPath + (File.Exists(Bridge.ConfigPath) ? " (found)" : " (MISSING)"));
            report.AppendLine("seedError=" + (seedError ?? "none"));
            string bundled = Bridge.BundledNode;
            report.AppendLine("bundledNode=" + (bundled ?? "none"));
            string node = Bridge.NodePath;
            report.AppendLine("resolvedNode=" + (node ?? "MISSING"));
            report.AppendLine("usedBundled=" + (node != null && bundled != null && node == bundled));
            report.AppendLine("port=" + Bridge.ReadPort());
            report.AppendLine("webui=" + (File.Exists(Path.Combine(Bridge.AppDir, "webui", "index.html")) ? "found" : "MISSING"));
            report.AppendLine("applyScript=" + (File.Exists(Path.Combine(Bridge.AppDir, "apply-kimi-settings.mjs")) ? "found" : "MISSING"));
            try
            {
                File.WriteAllText(Path.Combine(Bridge.AppDir, "probe.log"), report.ToString(), Encoding.UTF8);
            }
            catch
            {
                // nothing to do
            }
            return 0;
        }

        // Headless verification of the start/stop plumbing (no UI).
        private static int SelfTest()
        {
            var report = new StringBuilder();
            try
            {
                report.AppendLine("appDir=" + Bridge.AppDir);
                report.AppendLine("node=" + (Bridge.NodePath ?? "MISSING"));
                report.AppendLine("port=" + Bridge.ReadPort());
                report.AppendLine("healthyBefore=" + Bridge.IsHealthy());

                Bridge.KillProxyProcesses(0);
                Thread.Sleep(600);

                string error = Bridge.Start(true);
                report.AppendLine("startError=" + (error ?? "none"));

                bool up = false;
                for (int i = 0; i < 40; i++)
                {
                    if (Bridge.IsHealthy())
                    {
                        up = true;
                        break;
                    }
                    Thread.Sleep(250);
                }
                report.AppendLine("healthyAfterStart=" + up);
                report.AppendLine("childPid=" + Bridge.ChildPid);

                int took = Bridge.StopAndWait();
                report.AppendLine("stopTookMs=" + (took < 0 ? "TIMEOUT" : took.ToString()));
                report.AppendLine("healthyAfterStop=" + Bridge.IsHealthy());
                report.AppendLine("orphansLeft=" + Bridge.FindProxyProcesses().Count);
                report.AppendLine("result=" + (up && !Bridge.IsHealthy() && Bridge.FindProxyProcesses().Count == 0 ? "PASS" : "FAIL"));
            }
            catch (Exception err)
            {
                report.AppendLine("exception=" + err);
                report.AppendLine("result=FAIL");
            }

            try
            {
                File.WriteAllText(Path.Combine(Bridge.AppDir, "selftest.log"), report.ToString(), Encoding.UTF8);
            }
            catch
            {
                // nothing to do
            }
            return 0;
        }
    }
}
