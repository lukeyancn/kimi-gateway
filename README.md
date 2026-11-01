# Kimi 模型桥

把任意 OpenAI 兼容模型接进 Kimi 的「第三方模型网关」。

本地 Node 反代 + 托盘 EXE + WebUI。只监听 `127.0.0.1`，Kimi 里不用保存各家的 Key。

## 启动

双击 `KimiGateway.exe`，托盘常驻，网关自动启动。

右键托盘：

- 打开 WebUI
- 复制 Base URL
- 启动 / 停止 / 重启服务
- 开机自启
- 打开配置目录
- 查看日志
- 检查更新
- 退出

桌面和启动文件夹里都有快捷方式。旧 BAT / CMD / VBS 已删除，`src/build.ps1` 只用来重编译 EXE。

重启按钮只重启本地 `node proxy.mjs`，不会动 Kimi 本体，也不会重启网络。

## 检查更新

托盘右键 → 检查更新，读取 GitHub Releases 的最新 tag 和本机版本比较：

- 有新版本：弹窗显示版本号、安装包大小和更新说明，可以直接下载压缩包到 `Downloads`，或打开发布页
- 已是最新：提示当前版本
- 仓库读取失败 / 没有发布：给出具体原因

检查地址来自包内的 `update.json`，改仓库不用重编译：

```json
{ "repo": "lukeyancn/ds-in-kimi", "assetHint": "portable" }
```

`assetHint` 决定「下载安装包」优先挑哪个资产（`portable` / `share`），找不到就退到第一个 zip。

只做检查和下载，不自动替换正在运行的 exe —— 托盘进程锁着自身文件，静默替换容易留下半截状态。下载完成后退出托盘、解压覆盖即可。

## 接入 Kimi

Kimi → 设置 → 通用 → 模型来源 → 第三方模型网关：

- Base URL：`http://127.0.0.1:8787/v1`
- Token：随便填一个非空值，例如 `local`
- 点「测试连接并导入模型」，然后重启 Kimi

## WebUI

`http://127.0.0.1:8787/`

- **服务商**：新增、完整编辑（名称 / ID / 协议 / Base URL / Key）、测试、停用、删除；编辑里点「保存并拉模型」可以直接补模型
- **获取模型**：直接拉取上游 `/models`，勾选后批量导入；已经在列表里的会标灰
- **模型**：改上游模型 ID、Kimi ID、显示名、上下文、输出上限、图片 / 工具 / 思考能力
- **同步到 Kimi**：模型清单有变化时点一下，然后重启 Kimi
- **流量 / 用量 / 最近请求**：看请求和 token 消耗

## 常用供应商

新增服务商顶部有预设：

`DeepSeek`、`OpenAI`、`OpenRouter`、`Qwen`、`Kimi`、`GLM`、`SiliconFlow`、`Ollama`

不想用预设就点「自定义」，名称、ID、协议、Base URL、Key 都可以自己填。

选预设 → 填 Key（Ollama 不用）→ 拉取模型 → 勾选 → 添加。

上下文和输出上限都是下拉框，最后一项「自定义…」可以直接填 `300k`、`1m` 或 `300000`：

- 上下文常用：32K / 64K / 128K / 256K / 512K / 1M / 2M
- 输出常用：4K / 8K / 16K / 32K / 64K / 128K / 256K / 384K

上游没有 `/models` 接口时，在「手动模型 ID」里填 ID 也能添加，多个用逗号分隔。

## 配置

一般用 WebUI 就行。也可以直接改 `config.json`：

```json
{
  "id": "deepseek",
  "name": "DeepSeek",
  "protocol": "responses",
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-...",
  "models": [
    {
      "id": "deepseek-flash",
      "exposedId": "gpt-deepseek-flash",
      "contextLength": 1000000,
      "maxOutputTokens": 16384,
      "vision": true
    }
  ]
}
```

几个规则：

- `protocol: "responses"` 的 `exposedId` 以 `gpt-` 或 `codex-` 开头
- `protocol: "chat"` 的 `exposedId` 以 `kimi-` 开头
- Key 优先级：`apiKey` > `apiKeyEnv` > Kimi 里的 Token
- 改完手工配置后，点 WebUI 的「同步到 Kimi」，再重启 Kimi

## 当前模型

- `gpt-deepseek-flash`：DeepSeek V4.1 Flash，1M 上下文，支持图片、工具、思考
- `gpt-deepseek-v4-pro`：DeepSeek V4 Pro，1M 上下文，纯文本，支持工具、思考

默认输出上限 16K。需要长输出时在 WebUI 里改成 384K，同步并重启 Kimi。

## 日志

- `proxy.out.log` / `proxy.err.log`：请求方法、路径、模型、错误，不记录提示词和 Key
- `tray.log`：托盘启动器的启动 / 停止 / 自动重启记录
- 托盘菜单「查看日志」直接打开

## 重新编译 EXE

```powershell
powershell -ExecutionPolicy Bypass -File "D:\!Mine\plays\ds-in-kimi\src\build.ps1"
```

需要 .NET Framework 的 `csc.exe`（Windows 自带）。编译前先退出托盘程序。

## 打包与发布

```powershell
# 编译 + 生成 personal / share / portable 三个包到 dist\
python src\pack.py

# 建仓库、推源码、打 tag v1.0.0、上传 share 与 portable
$env:GITHUB_TOKEN = "ghp_xxx"
python src\publish.py
```

`publish.py` 会先检查 `config.json`、`metrics.json`、`backup/` 是否被 git 忽略，只要有一个会带着 Key 进公开仓库就直接退出。

token 需要 `Contents` + `Administration` 读写（细粒度），或 classic 的 `repo`。推送时 token 只出现在当次命令行里，不会写进 `.git/config`。

版本号有三处：`proxy.mjs` 的 `VERSION`、`src/KimiGateway.cs` 的 `AppVersion` 和 `AssemblyVersion`。`pack.py` 会校验三者一致，不一致直接报错。

源码在 `src/KimiGateway.cs`，网关在 `proxy.mjs`，前端在 `webui/`。

## 回滚

1. Kimi 设置里「断开连接」
2. 托盘右键退出
3. 删除启动文件夹的 `Kimi 模型桥.lnk`
4. 还原 `C:\Windows\System32\drivers\etc\hosts.bak-before-kimi-deepseek`
5. 删除 `byok-availability.json`
6. 重启 Kimi

## 安全

- `config.json` 可能含明文 Key，别直接分享整个目录
- 推荐用 `apiKeyEnv` + Windows 用户环境变量
- WebUI 没有登录，只在本机监听，不要映射到局域网或公网
