// Local OpenAI-compatible bridge for Kimi's third-party model gateway (BYOK),
// with a built-in admin console at http://127.0.0.1:<port>/
//
// Kimi only accepts exposed model ids beginning with:
//   gpt- / codex-  -> Kimi calls /v1/responses
//   kimi-          -> Kimi calls /v1/chat/completions
//
// config.json describes providers and models. The bridge rewrites the exposed
// model id to the provider's real model id, injects that provider's API key,
// forwards the request, and records token usage for the dashboard.
//
// Run: node proxy.mjs
// Env: KIMI_GATEWAY_CONFIG  (default: config.json next to this file)
//      KIMI_GATEWAY_METRICS (default: metrics.json next to this file)
//      KIMI_GATEWAY_PORT    (overrides config.port)

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProviders } from './config.mjs';
import { MetricsStore } from './metrics.mjs';
import { createAdminApi } from './admin-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.KIMI_GATEWAY_CONFIG || path.join(__dirname, 'config.json');
const METRICS_PATH = process.env.KIMI_GATEWAY_METRICS || path.join(__dirname, 'metrics.json');
const LOG_PATH = process.env.KIMI_GATEWAY_LOG || path.join(__dirname, 'proxy.out.log');
const HOST = '127.0.0.1';
const VERSION = '1.0.0';
const USER_AGENT = 'KimiModelBridge/1.0';
const STARTED_AT = Date.now();

let logStream = null;
try {
  if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 5 * 1024 * 1024) fs.truncateSync(LOG_PATH, 0);
  logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
} catch {
  logStream = null;
}

// Console plus a rolling file log, so the gateway keeps a trace even when it
// is started hidden by the VBS launcher.
function log(message) {
  console.log(message);
  try {
    logStream?.write(`${new Date().toISOString()} ${message}\n`);
  } catch {
    /* ignore disk errors */
  }
}

let config;
let providers = [];
let modelMap = new Map();

function readConfigFile() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function applyConfig(raw) {
  const built = buildProviders(raw.providers);
  config = raw;
  providers = built.providers;
  modelMap = built.modelMap;
}

function fail(message) {
  console.error(`[bridge] 配置错误：${message}`);
  process.exit(1);
}

try {
  applyConfig(readConfigFile());
} catch (err) {
  fail(err.message);
}

const PORT = Number(process.env.KIMI_GATEWAY_PORT || config.port || 8787);
const metrics = new MetricsStore(METRICS_PATH);

function normalizeEffort(provider, value) {
  if (typeof value !== 'string') return value;
  const v = value.trim().toLowerCase();
  if (provider.effortMap && Object.prototype.hasOwnProperty.call(provider.effortMap, v)) {
    return String(provider.effortMap[v]);
  }
  if (v === 'minimal' || v === 'none') return 'low';
  if (v === 'xhigh' || v === 'extra-high') return 'high';
  return v;
}

function applyEffort(body, provider) {
  if (body.reasoning && typeof body.reasoning === 'object' && typeof body.reasoning.effort === 'string') {
    body.reasoning.effort = normalizeEffort(provider, body.reasoning.effort);
  }
  if (typeof body.reasoning_effort === 'string') {
    body.reasoning_effort = normalizeEffort(provider, body.reasoning_effort);
  }
}

function providerAuth(provider, req) {
  const incoming = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const fromEnv = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : '';
  let auth = provider.apiKey || fromEnv || incoming;
  if (!auth) return '';
  if (!/^Bearer\s+/i.test(auth)) auth = `Bearer ${auth}`;
  return auth;
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractUsage(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const usage = obj.usage || (obj.response && obj.response.usage) || null;
  if (!usage || typeof usage !== 'object') return null;
  const input = numberOrNull(usage.input_tokens ?? usage.prompt_tokens);
  const output = numberOrNull(usage.output_tokens ?? usage.completion_tokens);
  if (input == null && output == null) return null;
  const details = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const outDetails = usage.output_tokens_details || usage.completion_tokens_details || {};
  return {
    input: input || 0,
    output: output || 0,
    cached: numberOrNull(details.cached_tokens) || 0,
    reasoning: numberOrNull(outDetails.reasoning_tokens) || 0,
  };
}

// Parses an SSE byte stream just enough to find the final usage payload.
// Never alters the bytes that go to the client.
function createUsageCollector() {
  let buffer = '';
  let usage = null;
  let failure = '';
  return {
    push(chunk) {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          const found = extractUsage(obj);
          if (found) usage = found;
          if (obj.type === 'response.failed' || obj.type === 'error') {
            failure = String(obj.response?.error?.message || obj.error?.message || obj.message || '').slice(0, 200);
          }
        } catch {
          /* ignore non-JSON keep-alive frames */
        }
      }
    },
    result() {
      return { usage, failure };
    },
  };
}

function recordReject({ model, endpoint, status, message, startedAt }) {
  metrics.record({
    ts: Date.now(),
    model: model || 'unknown',
    provider: '',
    endpoint,
    status,
    ms: Date.now() - startedAt,
    ok: false,
    error: message,
  });
}

function handleModels(req, res) {
  const now = Math.floor(Date.now() / 1000);
  const data = [...modelMap.values()].map((model) => ({
    id: model.exposedId,
    object: 'model',
    created: now,
    owned_by: model.provider.id,
    display_name: model.displayName,
    context_length: model.contextLength,
    max_completion_tokens_limit: model.maxOutputTokens,
    supports_tool_call: model.toolUse,
    supports_reasoning: model.reasoning,
    supports_image_in: model.vision,
  }));
  sendJson(res, 200, { object: 'list', data });
}

function handleUi(res) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kimi Model Bridge</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #0f1115; color: #e6e8ee; }
  main { max-width: 980px; margin: 0 auto; padding: 40px 20px 60px; }
  h1 { font-size: 28px; margin: 0 0 6px; }
  .sub { color: #8b93a7; margin-bottom: 28px; }
  .badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; background: #1b1f2a; color: #9aa4bb; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #e05252; }
  .dot.ok { background: #33c47a; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin-top: 18px; }
  .card { background: #161a22; border: 1px solid #242a36; border-radius: 14px; padding: 18px; }
  .card h2 { font-size: 16px; margin: 0 0 4px; }
  .muted { color: #8b93a7; font-size: 12px; }
  .model { border-top: 1px solid #242a36; padding: 12px 0 2px; margin-top: 10px; }
  .model:first-of-type { border-top: 0; margin-top: 0; padding-top: 4px; }
  .row { display: flex; justify-content: space-between; gap: 12px; }
  code { font-family: ui-monospace, Consolas, monospace; color: #9fd1ff; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chip { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #202634; color: #b9c3d9; }
  .chip.ok { background: #173528; color: #83e0ac; }
  a { color: #7cc4ff; }
  .foot { margin-top: 28px; color: #6f778a; font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>Kimi Model Bridge</h1>
  <div class="sub">本地模型网关 · <span id="health" class="badge"><span class="dot"></span><span>检查中...</span></span></div>
  <div class="muted">当前端口 <code id="port">8787</code> · <a href="/v1/providers" target="_blank">查看原始配置 JSON</a></div>
  <div id="providers" class="grid"></div>
  <div class="foot">修改 config.json 后，请在托盘菜单里选择“重启服务”。此页面不会显示 API Key。</div>
</main>
<script>
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
fetch('/health').then(function (r) { return r.json(); }).then(function (h) {
  document.getElementById('port').textContent = h.port;
  const badge = document.getElementById('health');
  badge.innerHTML = '';
  const dot = el('span', 'dot ok');
  const text = el('span', null, '运行中 · ' + h.providers + ' 个供应商 / ' + h.models + ' 个模型');
  badge.appendChild(dot); badge.appendChild(text);
}).catch(function () {
  const badge = document.getElementById('health');
  badge.innerHTML = '';
  badge.appendChild(el('span', 'dot'));
  badge.appendChild(el('span', null, '网关未运行'));
});
fetch('/v1/providers').then(function (r) { return r.json(); }).then(function (data) {
  const root = document.getElementById('providers');
  data.providers.forEach(function (p) {
    const card = el('div', 'card');
    card.appendChild(el('h2', null, p.name));
    card.appendChild(el('div', 'muted', p.protocol + ' · ' + p.baseUrl));
    p.models.forEach(function (m) {
      const box = el('div', 'model');
      const row = el('div', 'row');
      row.appendChild(el('code', null, m.exposedId));
      row.appendChild(el('span', 'muted', Math.round(m.contextLength / 1024) + 'k ctx'));
      box.appendChild(row);
      box.appendChild(el('div', 'muted', m.displayName + ' → ' + m.id));
      const chips = el('div', 'chips');
      if (m.vision) chips.appendChild(el('span', 'chip ok', '图片'));
      if (m.toolUse) chips.appendChild(el('span', 'chip ok', '工具'));
      if (m.reasoning) chips.appendChild(el('span', 'chip ok', '思考'));
      if (m.efforts && m.efforts.length) chips.appendChild(el('span', 'chip', m.efforts.join(' / ')));
      box.appendChild(chips);
      card.appendChild(box);
    });
    root.appendChild(card);
  });
}).catch(function (err) {
  document.getElementById('providers').textContent = '读取配置失败: ' + err;
});
</script>
</body>
</html>`;
  const body = Buffer.from(html);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function handleProviders(req, res) {
  const data = providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    models: provider.models.map((model) => ({
      id: model.id,
      exposedId: model.exposedId,
      displayName: model.displayName,
      contextLength: model.contextLength,
      maxOutputTokens: model.maxOutputTokens,
      vision: model.vision,
      toolUse: model.toolUse,
      reasoning: model.reasoning,
      efforts: model.efforts,
      defaultEffort: model.defaultEffort,
    })),
  }));
  sendJson(res, 200, { providers: data });
}

function relayUpstream(upstream, res, context) {
  const { model, provider, endpoint, startedAt } = context;
  const contentType = String(upstream.headers['content-type'] || '');
  const isStream = /text\/event-stream/i.test(contentType);
  const collector = isStream ? createUsageCollector() : null;
  const jsonChunks = [];
  let jsonBytes = 0;
  let ttft = null;
  let recorded = false;

  const finish = (ok, message) => {
    if (recorded) return;
    recorded = true;

    let usage = collector ? collector.result().usage : null;
    let failure = collector ? collector.result().failure : '';
    if (!isStream) {
      try {
        const text = Buffer.concat(jsonChunks).toString('utf8');
        const parsed = JSON.parse(text);
        usage = extractUsage(parsed);
        if (!ok) failure = failure || String(parsed?.error?.message || '').slice(0, 200);
      } catch {
        /* non-JSON body, nothing to read */
      }
    }

    metrics.record({
      ts: Date.now(),
      model: model.exposedId,
      provider: provider.id,
      endpoint,
      status: upstream.statusCode || 0,
      ms: Date.now() - startedAt,
      ttft,
      stream: isStream,
      ok,
      error: message || failure || '',
      ...(usage || {}),
    });
  };

  upstream.on('data', (chunk) => {
    if (ttft == null) ttft = Date.now() - startedAt;
    if (collector) collector.push(chunk);
    else if (jsonBytes < 4 * 1024 * 1024) {
      jsonChunks.push(chunk);
      jsonBytes += chunk.length;
    }
    const flushed = res.write(chunk);
    if (!flushed) {
      upstream.pause();
      res.once('drain', () => upstream.resume());
    }
  });

  upstream.on('end', () => {
    if (!res.writableEnded) res.end();
    finish(true);
  });

  upstream.on('error', (err) => {
    if (!res.headersSent) {
      sendJson(res, 502, { error: { message: `上游请求失败：${err.message}`, type: 'upstream_error' } });
    } else if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    finish(false, err.message);
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      try {
        upstream.destroy();
      } catch {
        /* ignore */
      }
      finish((upstream.statusCode || 200) < 400, '客户端提前断开');
    }
  });
}

function requestUpstream(urlString, headers, body, res, context) {
  let target;
  try {
    target = new URL(urlString);
  } catch {
    recordReject({
      model: context.model.exposedId,
      endpoint: context.endpoint,
      status: 500,
      message: `无效的上游地址：${urlString}`,
      startedAt: context.startedAt,
    });
    return sendJson(res, 500, { error: { message: `无效的上游地址：${urlString}`, type: 'bridge_error' } });
  }
  const transport = target.protocol === 'http:' ? http : https;
  const upstreamReq = transport.request(
    {
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers,
      timeout: 600000,
    },
    (upstream) => {
      const outHeaders = { ...upstream.headers };
      delete outHeaders['transfer-encoding'];
      delete outHeaders.connection;
      delete outHeaders['content-length'];
      outHeaders['cache-control'] = 'no-store';
      res.writeHead(upstream.statusCode || 502, outHeaders);
      relayUpstream(upstream, res, context);
    },
  );
  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('上游超时')));
  upstreamReq.on('error', (err) => {
    log(`[proxy] ${context.model.exposedId}: ${err.message}`);
    if (!res.headersSent) {
      recordReject({
        model: context.model.exposedId,
        endpoint: context.endpoint,
        status: 502,
        message: err.message,
        startedAt: context.startedAt,
      });
      sendJson(res, 502, { error: { message: `上游请求失败：${err.message}`, type: 'upstream_error' } });
    } else if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      try {
        upstreamReq.destroy();
      } catch {
        /* ignore */
      }
    }
  });
  upstreamReq.end(body);
}

function handleProxy(req, res, endpoint) {
  const startedAt = Date.now();
  const chunks = [];
  let size = 0;
  const MAX = 20 * 1024 * 1024;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX) {
      req.destroy(new Error('请求体过大'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      recordReject({ endpoint, status: 400, message: '请求体不是合法 JSON', startedAt });
      return sendJson(res, 400, { error: { message: 'Invalid JSON request body', type: 'invalid_request_error' } });
    }
    const requested = body?.model;
    const model = modelMap.get(String(requested || ''));
    if (!model) {
      recordReject({
        model: String(requested || 'unknown'),
        endpoint,
        status: 400,
        message: `未知模型 ${requested}`,
        startedAt,
      });
      return sendJson(res, 400, {
        error: {
          message: `Unknown model "${requested}". Add it to config.json and restart the gateway, then re-import models in Kimi.`,
          type: 'invalid_request_error',
        },
      });
    }
    if (model.protocol !== endpoint) {
      recordReject({
        model: model.exposedId,
        endpoint,
        status: 400,
        message: '协议与端点不匹配',
        startedAt,
      });
      return sendJson(res, 400, {
        error: {
          message: `Model "${model.exposedId}" uses the ${model.protocol} protocol; this endpoint is ${endpoint}. Exposed ids must start with ${model.protocol === 'chat' ? 'kimi-' : 'gpt-/codex-'}.`,
          type: 'invalid_request_error',
        },
      });
    }
    const provider = model.provider;
    const auth = providerAuth(provider, req);
    if (!auth) {
      recordReject({
        model: model.exposedId,
        endpoint,
        status: 401,
        message: '缺少 API Key',
        startedAt,
      });
      return sendJson(res, 401, {
        error: {
          message: `No API key for provider "${provider.id}". Set provider.apiKey or provider.apiKeyEnv in config.json.`,
          type: 'invalid_request_error',
        },
      });
    }

    body.model = model.id;
    applyEffort(body, provider);
    if (body.stream === true && provider.protocol === 'chat' && provider.streamUsage !== false) {
      body.stream_options = { include_usage: true, ...(body.stream_options || {}) };
    }

    const payload = Buffer.from(JSON.stringify(body));
    const upstreamPath = provider.protocol === 'chat' ? '/chat/completions' : '/responses';
    const url = `${provider.baseUrl}${upstreamPath}`;
    const headers = {
      ...provider.headers,
      authorization: auth,
      'content-type': 'application/json',
      accept: req.headers.accept || (provider.protocol === 'responses' ? 'text/event-stream' : 'application/json'),
      'content-length': payload.length,
      'user-agent': USER_AGENT,
    };
    log(`[proxy] ${model.exposedId} -> ${provider.id}/${model.id} (${provider.protocol})`);
    requestUpstream(url, headers, payload, res, { model, provider, endpoint, startedAt });
  });
}

// ---------------------------------------------------------------- static UI

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/admin': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

function serveStatic(res, pathname) {
  const entry = STATIC_FILES[pathname];
  if (!entry) return false;
  const [file, type] = entry;
  const full = path.join(__dirname, 'webui', file);
  try {
    const body = fs.readFileSync(full);
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`无法读取界面文件：${err.message}`);
  }
  return true;
}

const admin = createAdminApi({
  configPath: CONFIG_PATH,
  metrics,
  port: PORT,
  version: VERSION,
  startedAt: STARTED_AT,
  applyScript: path.join(__dirname, 'apply-kimi-settings.mjs'),
  getRuntime: () => ({ providers, modelMap }),
  reload: () => {
    const raw = readConfigFile();
    applyConfig(raw);
    log(`[bridge] 配置已热重载：${providers.length} 个服务商 / ${modelMap.size} 个模型`);
    for (const provider of providers) {
      log(
        `[bridge] provider=${provider.id} protocol=${provider.protocol} base=${provider.baseUrl} models=${provider.models
          .map((m) => m.exposedId)
          .join(',')}`,
      );
    }
  },
});

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || '/', `http://${HOST}`);
  } catch {
    return sendJson(res, 400, { error: { message: 'Bad request URL', type: 'invalid_request_error' } });
  }
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/')) log(`[req] ${req.method} ${pathname}`);

  if (pathname === '/' || pathname === '/admin' || pathname === '/index.html' || STATIC_FILES[pathname]) {
    if (req.method === 'GET' && serveStatic(res, pathname)) return;
  }

  if (pathname.startsWith('/api/')) {
    try {
      if (await admin.handle(req, res, url)) return;
    } catch (err) {
      console.error(`[admin] ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      return;
    }
    return sendJson(res, 404, { error: { message: `未知接口 ${pathname}`, type: 'not_found' } });
  }

  if (req.method === 'GET' && (pathname === '/health' || pathname === '/v1/health')) {
    return sendJson(res, 200, {
      ok: true,
      service: 'kimi-model-bridge',
      version: VERSION,
      port: PORT,
      providers: providers.length,
      models: modelMap.size,
      uptimeMs: Date.now() - STARTED_AT,
    });
  }
  if (req.method === 'GET' && (pathname === '/ui' || pathname === '/')) {
    return handleUi(res);
  }
  if (req.method === 'GET' && (pathname === '/models' || pathname === '/v1/models')) {
    return handleModels(req, res);
  }
  if (req.method === 'GET' && (pathname === '/v1/providers' || pathname === '/providers')) {
    return handleProviders(req, res);
  }
  if (req.method === 'POST' && (pathname === '/chat/completions' || pathname === '/v1/chat/completions')) {
    return handleProxy(req, res, 'chat');
  }
  if (req.method === 'POST' && (pathname === '/responses' || pathname === '/v1/responses')) {
    return handleProxy(req, res, 'responses');
  }
  return sendJson(res, 404, { error: { message: `Not found: ${req.method} ${pathname}`, type: 'invalid_request_error' } });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[bridge] 端口 ${PORT} 已被占用，可能已经有一个网关在运行。`);
  } else {
    console.error(`[bridge] 监听失败：${err.message}`);
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  log(`[bridge] listening on http://${HOST}:${PORT}/v1`);
  log(`[bridge] 管理界面 http://${HOST}:${PORT}/`);
  for (const provider of providers) {
    log(
      `[bridge] provider=${provider.id} protocol=${provider.protocol} base=${provider.baseUrl} models=${provider.models
        .map((m) => m.exposedId)
        .join(',')}`,
    );
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    metrics.saveNow();
    process.exit(0);
  });
}
