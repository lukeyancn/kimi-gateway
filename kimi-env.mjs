// Kimi「第三方模型网关」（BYOK）的启用开关。
//
// Kimi 桌面端把这个入口做成灰度功能，代码里同时校验两件事
// （字符串表里能搜到 byok-availability.json / dev.msh.team）：
//
//   1. %APPDATA%\kimi-desktop\kimi-agent\byok-availability.json
//      内容为 {"revealed":true}，且 revealed 必须是布尔 true（无 BOM）
//   2. dev.msh.team 解析到内网地址（10.x / 172.16-31.x / 192.168.x）
//      —— 靠 hosts 指向 192.168.1.1 满足，不会真的连接这个地址
//
// 标准安装两件都不满足，所以设置里看不到「第三方模型网关」。这个模块负责
// 检查并补齐，全程可逆：hosts 改动前备份，恢复时只删自己加的那行。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';

export const HOST_NAME = 'dev.msh.team';
export const HOST_IP = '192.168.1.1';

// 允许用环境变量覆盖，方便在临时文件上验证增删逻辑。
export const HOSTS_PATH = process.env.KIMI_HOSTS_PATH || 'C:\\Windows\\System32\\drivers\\etc\\hosts';
const BACKUP_SUFFIX = '.bak-kimi-gateway';
const ELEVATE_TIMEOUT = 120_000;

function kimiUserDataDir() {
  if (process.env.KIMI_USER_DATA) return process.env.KIMI_USER_DATA;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'kimi-desktop');
}

export function byokPath() {
  return path.join(kimiUserDataDir(), 'kimi-agent', 'byok-availability.json');
}

// ---------------------------------------------------------------- byok file

export function readByok() {
  const file = byokPath();
  const info = { path: file, exists: false, revealed: false, raw: '', problem: '' };
  try {
    if (!fs.existsSync(file)) return info;
    info.exists = true;
    const buffer = fs.readFileSync(file);
    // 带 BOM 会让 Kimi 的 JSON.parse 直接抛错，等于没开。
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      info.problem = '文件带 UTF-8 BOM，Kimi 读不出来';
      info.raw = buffer.slice(3).toString('utf8').trim().slice(0, 200);
      return info;
    }
    const text = buffer.toString('utf8');
    info.raw = text.trim().slice(0, 200);
    try {
      const parsed = JSON.parse(text);
      // Kimi 用 === true 严格比较，字符串 "true" 不算。
      info.revealed = parsed && parsed.revealed === true;
      if (!info.revealed) info.problem = 'revealed 不是布尔 true';
    } catch {
      info.problem = '内容不是合法 JSON';
    }
  } catch (err) {
    info.problem = `读取失败：${err.message}`;
  }
  return info;
}

export function writeByok() {
  const file = byokPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 无 BOM、无换行，与 Kimi 自己写出来的 17 字节一致。
  fs.writeFileSync(file, '{"revealed":true}', { encoding: 'utf8' });
  return file;
}

export function removeByok() {
  const file = byokPath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// -------------------------------------------------------------------- hosts

export function isPrivateIp(ip) {
  const parts = String(ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

function parseHostsLine(line) {
  const hash = line.indexOf('#');
  if (hash === 0) return null; // 整行注释
  const body = (hash > 0 ? line.slice(0, hash) : line).trim();
  if (!body) return null;
  const tokens = body.split(/\s+/);
  if (tokens.length < 2) return null;
  return { ip: tokens[0], names: tokens.slice(1).map((n) => n.toLowerCase()) };
}

export function readHosts() {
  const info = { path: HOSTS_PATH, exists: false, entries: [], active: null, writable: false, backup: null, problem: '' };
  try {
    info.exists = fs.existsSync(HOSTS_PATH);
    if (!info.exists) {
      info.problem = '找不到 hosts 文件';
      return info;
    }
    const text = fs.readFileSync(HOSTS_PATH, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const parsed = parseHostsLine(line);
      if (!parsed) continue;
      if (parsed.names.includes(HOST_NAME)) info.entries.push(parsed);
    }
    // 系统解析按文件顺序取第一条匹配，这里也以第一条为准，
    // 避免「后面有一条内网地址」被误判成可用。
    info.active = info.entries[0] || null;
    info.backup = `${HOSTS_PATH}${BACKUP_SUFFIX}`;
    info.hasBackup = fs.existsSync(info.backup);
    try {
      fs.accessSync(HOSTS_PATH, fs.constants.W_OK);
      info.writable = true;
    } catch {
      info.writable = false;
    }
  } catch (err) {
    info.problem = `读取失败：${err.message}`;
  }
  return info;
}

function rewriteHosts(text) {
  const kept = [];
  let removed = 0;
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseHostsLine(line);
    if (parsed && parsed.names.includes(HOST_NAME)) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  // 去掉尾部空行，再补我们这一行和结尾换行。
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  kept.push(`${HOST_IP} ${HOST_NAME}`);
  return { text: `${kept.join('\r\n')}\r\n`, removed };
}

function removeHostsEntry(text) {
  const kept = [];
  let removed = 0;
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseHostsLine(line);
    if (parsed && parsed.names.includes(HOST_NAME)) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  return { text: kept.length ? `${kept.join('\r\n')}\r\n` : '', removed };
}

function flushDns() {
  // 失败不算错：Kimi 启动时会重新查询，缓存最多影响一小会儿。
  try {
    execFile('ipconfig', ['/flushdns'], { windowsHide: true }, () => {});
  } catch {
    /* ignore */
  }
}

// 提权脚本：自提权后按 Action 改写 hosts，结果写进 result 文件供校验。
const ELEVATED_SCRIPT = `param([string]$Action, [string]$ResultFile, [string]$HostsPath)
$ErrorActionPreference = 'Stop'
$hosts = $HostsPath
$backup = $hosts + '.bak-kimi-gateway'
$name = 'dev.msh.team'
$ip = '192.168.1.1'
$crlf = [string][char]13 + [string][char]10

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  $childArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$PSCommandPath,
                 '-Action',$Action,'-ResultFile',$ResultFile,'-HostsPath',$HostsPath)
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $childArgs -Verb RunAs -Wait -PassThru -WindowStyle Hidden
  exit $p.ExitCode
}

try {
  if (-not (Test-Path $backup)) { Copy-Item -LiteralPath $hosts -Destination $backup -Force }

  $lines = New-Object System.Collections.ArrayList
  foreach ($line in @(Get-Content -LiteralPath $hosts -Encoding UTF8)) { [void]$lines.Add([string]$line) }

  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    $body = [string]$lines[$i]
    $hash = $body.IndexOf('#')
    if ($hash -eq 0) { continue }
    if ($hash -gt 0) { $body = $body.Substring(0, $hash) }
    $tokens = @($body.Trim() -split '\\s+')
    if ($tokens.Count -lt 2) { continue }
    $names = @($tokens[1..($tokens.Count - 1)])
    if ($names -contains $name) { $lines.RemoveAt($i) }
  }

  while ($lines.Count -gt 0 -and ([string]$lines[$lines.Count - 1]).Trim() -eq '') { $lines.RemoveAt($lines.Count - 1) }
  if ($Action -eq 'add') { [void]$lines.Add($ip + ' ' + $name) }

  $out = ''
  if ($lines.Count -gt 0) { $out = ($lines -join $crlf) + $crlf }
  [System.IO.File]::WriteAllText($hosts, $out, (New-Object System.Text.UTF8Encoding($false)))

  ipconfig /flushdns | Out-Null
  Set-Content -LiteralPath $ResultFile -Value 'ok' -Encoding ASCII
  exit 0
} catch {
  Set-Content -LiteralPath $ResultFile -Value ('error: ' + $_.Exception.Message) -Encoding UTF8
  exit 1
}
`;

function runElevated(action) {
  const script = path.join(os.tmpdir(), 'kimi-gateway-hosts.ps1');
  const resultFile = path.join(os.tmpdir(), 'kimi-gateway-hosts.result');
  try {
    // PowerShell 5.1 读 UTF-8 需要 BOM，否则中文会乱码。
    fs.writeFileSync(script, `\uFEFF${ELEVATED_SCRIPT}`, 'utf8');
    if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);

    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action, '-ResultFile', resultFile, '-HostsPath', HOSTS_PATH],
      { windowsHide: true, timeout: ELEVATE_TIMEOUT, encoding: 'utf8' },
    );

    let detail = '';
    try {
      if (fs.existsSync(resultFile)) detail = fs.readFileSync(resultFile, 'utf8').trim();
    } catch {
      /* ignore */
    }

    if (result.error) {
      if (result.error.code === 'ETIMEDOUT') return { ok: false, message: '提权操作超时（可能一直没点“是”）' };
      return { ok: false, message: result.error.message };
    }
    if (detail.startsWith('error:')) {
      const raw = detail.slice(6).trim();
      // PowerShell 的原始异常对用户没意义，翻成人话。
      if (/拒绝|denied|UnauthorizedAccess/i.test(raw)) {
        return { ok: false, message: 'hosts 写入被拒绝：可能取消了 UAC 提权，或该文件被设为只读' };
      }
      return { ok: false, message: raw };
    }
    if (result.status !== 0 && !detail.startsWith('ok')) {
      return { ok: false, message: (result.stderr || '').trim() || '提权写入失败（可能取消了 UAC）' };
    }
    return { ok: true, message: '' };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    try {
      if (fs.existsSync(script)) fs.unlinkSync(script);
      if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);
    } catch {
      /* 留在 temp 里也无害 */
    }
  }
}

function writeHostsDirect(action) {
  const text = fs.readFileSync(HOSTS_PATH, 'utf8');
  const next = action === 'add' ? rewriteHosts(text).text : removeHostsEntry(text).text;
  fs.writeFileSync(HOSTS_PATH, next, 'utf8');
}

// 直接写优先，没权限再走提权。返回 { changed, elevated, message }。
function applyHosts(action) {
  const before = readHosts();
  const needsWork = action === 'add' ? !before.active || !isPrivateIp(before.active.ip) : before.entries.length > 0;
  if (!needsWork) return { changed: false, elevated: false, message: '' };

  try {
    writeHostsDirect(action);
    flushDns();
    return { changed: true, elevated: false, message: '' };
  } catch (err) {
    if (err.code !== 'EACCES' && err.code !== 'EPERM') {
      return { changed: false, elevated: false, message: `写入 hosts 失败：${err.message}` };
    }
  }

  const elevated = runElevated(action);
  if (!elevated.ok) return { changed: false, elevated: true, message: elevated.message };
  flushDns();
  return { changed: true, elevated: true, message: '' };
}

// ------------------------------------------------------------------- status

// /api/state 每 2.5 秒轮询一次，而查进程要拉起 PowerShell（约 2 秒）。
// 一律走缓存 + 后台刷新：首次返回空，下一次轮询就有数据，绝不阻塞接口。
let procCache = { at: 0, value: [], refreshing: false };
const PROC_TTL = 10_000;
const PS_QUERY =
  "Get-Process -Name 'Kimi' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id.ToString() + '|' + $_.Path }";

function parseProcesses(stdout) {
  if (!stdout) return [];
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, ...rest] = line.split('|');
      return { pid: Number(id), path: rest.join('|') };
    })
    .filter((p) => Number.isFinite(p.pid));
}

function refreshProcesses() {
  if (procCache.refreshing) return;
  procCache.refreshing = true;
  execFile('powershell.exe', ['-NoProfile', '-Command', PS_QUERY], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
    procCache = { at: Date.now(), value: err ? procCache.value : parseProcesses(stdout), refreshing: false };
  });
}

function kimiProcesses() {
  if (Date.now() - procCache.at >= PROC_TTL) refreshProcesses();
  return procCache.value;
}

// 重启 Kimi 需要准确的进程信息，这里同步查一次。
function kimiProcessesSync() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', PS_QUERY], {
    windowsHide: true,
    timeout: 8000,
    encoding: 'utf8',
  });
  if (result.status !== 0) return procCache.value;
  procCache = { at: Date.now(), value: parseProcesses(result.stdout), refreshing: false };
  return procCache.value;
}

export function getStatus() {
  const byok = readByok();
  const hosts = readHosts();
  const hostOk = Boolean(hosts.active && isPrivateIp(hosts.active.ip));
  const procs = kimiProcesses();

  const steps = [];
  if (!byok.revealed) {
    steps.push({
      key: 'byok',
      done: false,
      label: '开关文件',
      detail: byok.exists ? byok.problem || '内容不是 {"revealed":true}' : 'byok-availability.json 尚未创建',
    });
  } else {
    steps.push({ key: 'byok', done: true, label: '开关文件', detail: 'byok-availability.json 已开启' });
  }
  if (hostOk) {
    steps.push({ key: 'hosts', done: true, label: '域名指向', detail: `${HOST_NAME} → ${hosts.active.ip}（内网地址）` });
  } else if (hosts.active) {
    steps.push({ key: 'hosts', done: false, label: '域名指向', detail: `${HOST_NAME} → ${hosts.active.ip}，不是内网地址` });
  } else {
    steps.push({ key: 'hosts', done: false, label: '域名指向', detail: `hosts 里没有 ${HOST_NAME}` });
  }

  return {
    ready: byok.revealed && hostOk,
    byok,
    hosts: {
      path: hosts.path,
      entries: hosts.entries,
      active: hosts.active,
      writable: hosts.writable,
      hasBackup: Boolean(hosts.hasBackup),
      backupPath: hosts.backup,
      problem: hosts.problem,
    },
    host: { name: HOST_NAME, ip: HOST_IP },
    kimi: { running: procs.length > 0, pids: procs.map((p) => p.pid), path: procs[0]?.path || '' },
    steps,
  };
}

export function enable() {
  const notes = [];
  let changed = false;

  const byok = readByok();
  if (!byok.revealed) {
    try {
      writeByok();
      changed = true;
      notes.push('已写入 byok-availability.json');
    } catch (err) {
      return { ok: false, error: `写入 ${byok.path} 失败：${err.message}`, status: getStatus() };
    }
  }

  const hosts = applyHosts('add');
  if (hosts.message) {
    return { ok: false, error: hosts.message, elevated: hosts.elevated, status: getStatus() };
  }
  if (hosts.changed) {
    changed = true;
    notes.push(hosts.elevated ? '已在管理员权限下写入 hosts（已提示 UAC）' : '已写入 hosts');
  }

  const status = getStatus();
  if (!status.ready) {
    return { ok: false, error: '写入完成但仍未就绪，请检查 hosts 权限', status };
  }
  return { ok: true, changed, notes, elevated: hosts.elevated, status };
}

export function disable() {
  const notes = [];
  let changed = false;

  const hosts = applyHosts('remove');
  if (hosts.message) {
    return { ok: false, error: hosts.message, elevated: hosts.elevated, status: getStatus() };
  }
  if (hosts.changed) {
    changed = true;
    notes.push('已从 hosts 移除');
  }

  try {
    if (fs.existsSync(byokPath())) {
      removeByok();
      changed = true;
      notes.push('已删除 byok-availability.json');
    }
  } catch (err) {
    return { ok: false, error: `删除开关文件失败：${err.message}`, status: getStatus() };
  }

  return { ok: true, changed, notes, elevated: hosts.elevated, status: getStatus() };
}

// 启用后必须重启 Kimi 才会重新做探测；先全部关掉再拉起，避免只重启渲染进程。
export function restartKimi() {
  const procs = kimiProcessesSync();
  if (procs.length === 0) return { ok: false, error: 'Kimi 没有在运行' };
  const exe = procs.find((p) => p.path)?.path;
  if (!exe) return { ok: false, error: '拿不到 Kimi 的可执行文件路径' };

  const script = path.join(os.tmpdir(), 'kimi-gateway-restart.ps1');
  const body = `$exe = '${exe.replace(/'/g, "''")}'
Get-Process -Name 'Kimi' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Process -Name 'Kimi' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
Start-Sleep -Milliseconds 800
Start-Process -FilePath $exe
`;
  try {
    fs.writeFileSync(script, `\uFEFF${body}`, 'utf8');
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, timeout: 40_000, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || '').trim() || `重启脚本退出码 ${result.status}` };
    }
    return { ok: true, restarted: procs.length, exe };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try {
      if (fs.existsSync(script)) fs.unlinkSync(script);
    } catch {
      /* ignore */
    }
  }
}
