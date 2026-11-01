# 编译托盘启动器：KimiGateway.exe
#
# 只用 Windows 自带的 .NET Framework 编译器，不需要装 SDK、不需要网络。
#   powershell -ExecutionPolicy Bypass -File src\build.ps1
#
# 先输出到 build\，再尝试覆盖根目录的 KimiGateway.exe；
# 如果托盘正在运行（文件被占用），根目录那份保持不动，用新包替换即可。

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$src = Join-Path $root 'src'
$stage = Join-Path $root 'build'
$staged = Join-Path $stage 'KimiGateway.exe'
$target = Join-Path $root 'KimiGateway.exe'

$candidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) {
  Write-Host '[FAIL] 找不到 csc.exe（需要 .NET Framework 4.x）'
  exit 1
}

if (-not (Test-Path $stage)) { New-Item -ItemType Directory -Path $stage | Out-Null }
Write-Host "编译器: $csc"

& $csc `
  /nologo `
  /target:winexe `
  /platform:anycpu `
  /optimize+ `
  /warn:3 `
  "/out:$staged" `
  "/win32icon:$src\assets\icon-on.ico" `
  "/win32manifest:$src\app.manifest" `
  "/resource:$src\assets\icon-on.ico,icon-on.ico" `
  "/resource:$src\assets\icon-off.ico,icon-off.ico" `
  /reference:System.dll `
  /reference:System.Drawing.dll `
  /reference:System.Windows.Forms.dll `
  /reference:System.Web.Extensions.dll `
  "$src\KimiGateway.cs" `
  "$src\Updater.cs"

if ($LASTEXITCODE -ne 0) {
  Write-Host "[FAIL] 编译失败 ($LASTEXITCODE)"
  exit $LASTEXITCODE
}

$info = Get-Item $staged
Write-Host ("[OK] build\{0}  ({1:N0} 字节)" -f $info.Name, $info.Length)

try {
  Copy-Item $staged $target -Force
  Write-Host '[OK] 已复制到根目录 KimiGateway.exe'
} catch {
  Write-Host '[WARN] 根目录 exe 正被占用（托盘在运行？），跳过覆盖。'
  Write-Host '       退出托盘后重新运行本脚本，或直接用 build\KimiGateway.exe。'
}
