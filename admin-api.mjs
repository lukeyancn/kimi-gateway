// Admin API for the local bridge UI. Everything here is only reachable from
// 127.0.0.1: the server binds loopback, and these routes are mounted on the
// same listener as the OpenAI-compatible endpoints.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  buildProviders,
  sanitizeId,
  defaultExposedId,
  normalizeProtocol,
  normalizeBaseUrl,
  maskKey,
} from './config.mjs';

const MAX_BODY = 1024 * 1024;
const TEST_TIMEOUT = 30_000;
const DISCOVER_TIMEOUT = 20_000;

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function extractErrorMessage(text) {
  try {
    const parsed = JSON.parse(text);
    return String(parsed?.error?.message || parsed?.message || parsed?.error || text).slice(0, 240);
  } catch {
    return String(text || '').trim().slice(0, 240);
  }
}

function pickNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function networkError(err, timeoutSeconds) {
  if (err?.name === 'AbortError') return `超时（${timeoutSeconds}s）`;
  const detail = String(err?.cause?.message || err?.cause?.code || err?.code || '').trim();
  if (/bad port/i.test(detail)) return '端口不可用';
  if (/ECONNREFUSED/i.test(detail)) return '连接被拒绝';
  if (/ENOTFOUND/i.test(detail)) return '域名解析失败';
  if (/ETIMEDOUT/i.test(detail)) return '连接超时';
  if (detail) return `连接失败（${detail.slice(0, 80)}）`;
  return '连接失败';
}

function providerKey(provider) {
  const explicit = typeof provider?.apiKey === 'string' ? provider.apiKey.trim() : '';
  if (explicit) return explicit;
  const env = typeof provider?.apiKeyEnv === 'string' ? provider.apiKeyEnv.trim() : '';
  return env ? String(process.env[env] || '').trim() : '';
}

function keyHeader(key) {
  if (!key) return {};
  return { authorization: /^Bearer\s+/i.test(key) ? key : `Bearer ${key}` };
}

export function createAdminApi(options) {
  const { configPath, metrics, getRuntime, reload, version, startedAt, applyScript, port } = options;

  let syncPending = false;
  let lastSyncedAt = null;
  let lastSyncOutput = '';
  let writeQueue = Promise.resolve();

  function readConfig() {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  function writeConfig(cfg) {
    if (fs.existsSync(configPath)) {
      try {
        fs.copyFileSync(configPath, `${configPath}.bak`);
      } catch {
        /* best effort */
      }
    }
    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
    fs.renameSync(tmp, configPath);
  }

  function apiKeyState(provider) {
    if (typeof provider.apiKey === 'string' && provider.apiKey.trim()) {
      return { type: 'config', label: 'config.json', masked: maskKey(provider.apiKey.trim()) };
    }
    const env = typeof provider.apiKeyEnv === 'string' ? provider.apiKeyEnv.trim() : '';
    if (env) {
      const value = process.env[env];
      if (value) return { type: 'env', label: `环境变量 ${env}`, masked: maskKey(value), envName: env };
      return { type: 'env-missing', label: `环境变量 ${env} 未设置`, masked: '', envName: env };
    }
    return { type: 'passthrough', label: 'Kimi 透传', masked: '' };
  }

  function buildState() {
    const cfg = readConfig();
    const runtime = getRuntime();
    const loadedIds = new Set(runtime.providers.map((p) => p.id));
    const snapshot = metrics.snapshot();

    const providers = (cfg.providers || []).map((provider) => {
      const key = apiKeyState(provider);
      return {
        id: sanitizeId(provider.id),
        name: provider.name || provider.id,
        protocol: normalizeProtocol(provider.protocol),
        baseUrl: provider.baseUrl,
        enabled: provider.enabled !== false,
        loaded: loadedIds.has(sanitizeId(provider.id)),
        apiKey: key,
        effortMap: provider.effortMap || null,
        streamUsage: provider.streamUsage !== false,
        models: (provider.models || []).map((model) => ({
          id: model.id,
          exposedId: model.exposedId,
          displayName: model.displayName || model.exposedId,
          contextLength: model.contextLength,
          maxOutputTokens: model.maxOutputTokens,
          vision: model.vision === true,
          toolUse: model.toolUse !== false,
          reasoning: model.reasoning !== false,
          efforts: Array.isArray(model.efforts) ? model.efforts : [],
          defaultEffort: model.defaultEffort || '',
        })),
      };
    });

    const models = [];
    for (const provider of providers) {
      for (const model of provider.models) {
        const stats = snapshot.byModel[model.exposedId] || null;
        models.push({
          ...model,
          providerId: provider.id,
          providerName: provider.name,
          protocol: provider.protocol,
          providerEnabled: provider.enabled,
          stats,
        });
      }
    }

    const revision = crypto
      .createHash('sha1')
      .update(JSON.stringify(cfg))
      .digest('hex')
      .slice(0, 12);

    return {
      gateway: {
        port,
        version,
        startedAt: new Date(startedAt).toISOString(),
        uptimeMs: Date.now() - startedAt,
        configPath,
        configFile: path.basename(configPath),
        node: process.version,
        enabledProviders: runtime.providers.length,
        models: runtime.modelMap.size,
      },
      providers,
      models,
      metrics: snapshot,
      sync: { pending: syncPending, lastSyncedAt, lastOutput: lastSyncOutput },
      revision,
    };
  }

  function mutation(fn, { structural = false } = {}) {
    const run = writeQueue.then(async () => {
      const cfg = readConfig();
      const result = fn(cfg) || {};
      buildProviders(cfg.providers);
      writeConfig(cfg);
      reload();
      if (structural || result.structural) syncPending = true;
      return buildState();
    });
    writeQueue = run.catch(() => {});
    return run;
  }

  function locateProvider(cfg, id) {
    const target = (cfg.providers || []).find((p) => sanitizeId(p.id) === sanitizeId(id));
    if (!target) throw Object.assign(new Error('找不到该服务商'), { status: 404 });
    return target;
  }

  function locateModel(cfg, exposedId) {
    for (const provider of cfg.providers || []) {
      const model = (provider.models || []).find((m) => String(m.exposedId) === String(exposedId));
      if (model) return { provider, model };
    }
    throw Object.assign(new Error('找不到该模型'), { status: 404 });
  }

  async function testProvider(provider, modelId) {
    const models = provider.models || [];
    const model = models.find((m) => m.id === modelId) || models[0];
    if (!model) return { ok: false, message: '该服务商没有可测试的模型' };

    const key = providerKey(provider);
    const protocol = normalizeProtocol(provider.protocol);
    const base = String(provider.baseUrl || '').replace(/\/+$/, '');
    const url = `${base}${protocol === 'chat' ? '/chat/completions' : '/responses'}`;
    const body =
      protocol === 'chat'
        ? { model: model.id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false }
        : { model: model.id, input: 'ping', max_output_tokens: 16, stream: false };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT);
    const t0 = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...(provider.headers || {}),
          ...keyHeader(key),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const ms = Date.now() - t0;
      if (!response.ok) {
        return { ok: false, status: response.status, ms, message: extractErrorMessage(text) };
      }
      return { ok: true, status: response.status, ms, message: `${model.id} 响应正常` };
    } catch (err) {
      const ms = Date.now() - t0;
      return { ok: false, status: 0, ms, message: networkError(err, TEST_TIMEOUT / 1000) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function discoverModels(input) {
    const base = normalizeBaseUrl(input.baseUrl);
    const url = /\/models$/i.test(base) ? base : `${base}/models`;
    const key = String(input.apiKey || '').trim() || providerKey(input);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCOVER_TIMEOUT);
    const t0 = Date.now();
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          ...(input.headers || {}),
          ...keyHeader(key),
          accept: 'application/json',
        },
        signal: controller.signal,
      });
      const text = await response.text();
      const ms = Date.now() - t0;
      if (!response.ok) {
        return { ok: false, status: response.status, ms, message: extractErrorMessage(text) };
      }

      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return { ok: false, status: response.status, ms, message: '上游 /models 返回的不是 JSON' };
      }

      const rows = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data)
          ? payload.data
          : Array.isArray(payload?.models)
            ? payload.models
            : [];
      const seen = new Set();
      const models = [];
      for (const row of rows) {
        const id = String(typeof row === 'string' ? row : row?.id || row?.name || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        models.push({ id });
      }
      models.sort((a, b) => a.id.localeCompare(b.id));
      return { ok: true, status: response.status, ms, models };
    } catch (err) {
      const ms = Date.now() - t0;
      return { ok: false, status: 0, ms, message: networkError(err, DISCOVER_TIMEOUT / 1000) };
    } finally {
      clearTimeout(timer);
    }
  }

  function runSync() {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(applyScript)) {
        reject(new Error(`找不到 ${path.basename(applyScript)}`));
        return;
      }
      const child = spawn(process.execPath, [applyScript], {
        cwd: path.dirname(applyScript),
        env: { ...process.env, KIMI_GATEWAY_CONFIG: configPath },
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('同步超时'));
      }, 30_000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || `同步脚本退出码 ${code}`));
      });
    });
  }

  async function handle(req, res, url) {
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/api/state') {
      sendJson(res, 200, buildState());
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true, uptimeMs: Date.now() - startedAt });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/discover-models') {
      try {
        const body = await readBody(req);
        const provider = body.providerId ? locateProvider(readConfig(), body.providerId) : null;
        const baseUrl = String(body.baseUrl || provider?.baseUrl || '').trim();
        const directKey = String(body.apiKey || '').trim();
        const envName = String(body.apiKeyEnv || '').trim();
        const envKey = envName ? String(process.env[envName] || '').trim() : '';
        const key = directKey || envKey || providerKey(provider || {});
        const result = await discoverModels({
          baseUrl,
          apiKey: key,
          headers: {
            ...(provider?.headers || {}),
            ...(body.headers && typeof body.headers === 'object' ? body.headers : {}),
          },
        });
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, err.status || 400, { error: err.message });
      }
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/providers') {
      try {
        const body = await readBody(req);
        const name = String(body.name || '').trim();
        if (!name) throw Object.assign(new Error('请填写服务商名称'), { status: 400 });
        const protocol = normalizeProtocol(body.protocol);
        const baseUrl = String(body.baseUrl || '').trim();
        if (!baseUrl) throw Object.assign(new Error('请填写 Base URL'), { status: 400 });

        const requested = Array.isArray(body.models)
          ? body.models
          : body.modelId
            ? [{ id: body.modelId }]
            : [];
        if (requested.length === 0) throw Object.assign(new Error('请先选择模型'), { status: 400 });

        const state = await mutation((cfg) => {
          cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
          const wanted = sanitizeId(body.id) || sanitizeId(name) || `provider-${cfg.providers.length + 1}`;
          let id = wanted;
          let suffix = 2;
          while (cfg.providers.some((p) => sanitizeId(p.id) === id)) {
            id = `${wanted}-${suffix++}`;
          }

          const provider = {
            id,
            name,
            protocol,
            baseUrl,
            enabled: true,
            models: [],
          };
          if (body.apiKey) provider.apiKey = String(body.apiKey).trim();
          else if (body.apiKeyEnv) provider.apiKeyEnv = String(body.apiKeyEnv).trim();
          if (body.headers && typeof body.headers === 'object') provider.headers = { ...body.headers };
          if (body.effortMap && typeof body.effortMap === 'object') provider.effortMap = { ...body.effortMap };
          if (body.streamUsage === false) provider.streamUsage = false;

          const seen = new Set();
          for (const item of requested) {
            const raw = typeof item === 'string' ? { id: item } : item || {};
            const modelId = String(raw.id || '').trim();
            if (!modelId || seen.has(modelId)) continue;
            seen.add(modelId);
            const single = requested.length === 1;
            const exposedId =
              String(raw.exposedId || (single ? body.exposedId : '') || '').trim() ||
              defaultExposedId({ id, protocol }, { id: modelId });
            const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
            provider.models.push({
              id: modelId,
              exposedId,
              displayName: String(raw.displayName || body.displayName || modelId),
              contextLength: pickNumber(raw.contextLength ?? body.contextLength, 128000),
              maxOutputTokens: pickNumber(raw.maxOutputTokens ?? body.maxOutputTokens, 8192),
              vision: bool(raw.vision, body.vision === true),
              toolUse: bool(raw.toolUse, body.toolUse !== false),
              reasoning: bool(raw.reasoning, body.reasoning !== false),
              efforts: Array.isArray(raw.efforts)
                ? raw.efforts.map(String)
                : Array.isArray(body.efforts)
                  ? body.efforts.map(String)
                  : [],
              defaultEffort: String(raw.defaultEffort ?? body.defaultEffort ?? ''),
            });
          }
          if (provider.models.length === 0) throw Object.assign(new Error('没有有效的模型 ID'), { status: 400 });
          cfg.providers.push(provider);
          return { structural: true };
        });
        sendJson(res, 200, state);
      } catch (err) {
        sendJson(res, err.status || 400, { error: err.message });
      }
      return true;
    }

    const providerMatch = pathname.match(/^\/api\/providers\/([^/]+)$/);
    if (providerMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const id = decodeURIComponent(providerMatch[1]);
      try {
        if (req.method === 'DELETE') {
          const state = await mutation((cfg) => {
            const before = cfg.providers.length;
            cfg.providers = (cfg.providers || []).filter((p) => sanitizeId(p.id) !== sanitizeId(id));
            if (cfg.providers.length === before) throw Object.assign(new Error('找不到该服务商'), { status: 404 });
            return { structural: true };
          });
          syncPending = true;
          sendJson(res, 200, state);
          return true;
        }

        const body = await readBody(req);
        const state = await mutation((cfg) => {
          const provider = locateProvider(cfg, id);
          let structural = false;
          if (typeof body.name === 'string' && body.name.trim()) provider.name = body.name.trim();
          if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) provider.baseUrl = body.baseUrl.trim();
          if (typeof body.id === 'string' && body.id.trim()) {
            const nextId = sanitizeId(body.id);
            if (!nextId) throw Object.assign(new Error('服务商 ID 不能为空'), { status: 400 });
            if (nextId !== sanitizeId(provider.id)) {
              if ((cfg.providers || []).some((p) => p !== provider && sanitizeId(p.id) === nextId)) {
                throw Object.assign(new Error('这个服务商 ID 已经被占用了'), { status: 400 });
              }
              provider.id = nextId;
              structural = true;
            }
          }
          if (typeof body.protocol === 'string') {
            const nextProtocol = normalizeProtocol(body.protocol);
            if (nextProtocol !== normalizeProtocol(provider.protocol)) {
              provider.protocol = nextProtocol;
              const prefix = nextProtocol === 'chat' ? 'kimi-' : 'gpt-';
              for (const model of provider.models || []) {
                const tail = String(model.exposedId || '').replace(/^(gpt-|codex-|kimi-)/i, '');
                model.exposedId = tail
                  ? `${prefix}${tail}`
                  : defaultExposedId(provider, { id: model.id });
              }
              structural = true;
            }
          }
          if (typeof body.enabled === 'boolean') {
            if (provider.enabled !== body.enabled) structural = true;
            provider.enabled = body.enabled;
          }

          if (body.apiKey !== undefined) {
            const key = String(body.apiKey || '').trim();
            if (key) {
              provider.apiKey = key;
              delete provider.apiKeyEnv;
            } else if (!body.keepKey) {
              delete provider.apiKey;
            }
          }
          if (body.apiKeyEnv !== undefined) {
            const env = String(body.apiKeyEnv || '').trim();
            if (env) {
              provider.apiKeyEnv = env;
              delete provider.apiKey;
            }
          }
          if (body.clearKey === true) {
            delete provider.apiKey;
            delete provider.apiKeyEnv;
          }
          if (typeof body.streamUsage === 'boolean') provider.streamUsage = body.streamUsage;
          return { structural };
        });
        sendJson(res, 200, state);
      } catch (err) {
        sendJson(res, err.status || 400, { error: err.message });
      }
      return true;
    }

    const modelsMatch = pathname.match(/^\/api\/providers\/([^/]+)\/models$/);
    if (modelsMatch && req.method === 'POST') {
      try {
        const id = decodeURIComponent(modelsMatch[1]);
        const body = await readBody(req);
        const requested = Array.isArray(body.models) ? body.models : [];
        if (requested.length === 0) throw Object.assign(new Error('请先选择模型'), { status: 400 });

        const state = await mutation((cfg) => {
          const provider = locateProvider(cfg, id);
          provider.models = Array.isArray(provider.models) ? provider.models : [];
          const existing = new Set(provider.models.map((model) => String(model.id)));
          const defaults = body.defaults && typeof body.defaults === 'object' ? body.defaults : {};
          const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
          let added = 0;

          for (const item of requested) {
            const raw = typeof item === 'string' ? { id: item } : item || {};
            const modelId = String(raw.id || '').trim();
            if (!modelId || existing.has(modelId)) continue;
            existing.add(modelId);

            const exposedId =
              String(raw.exposedId || '').trim() ||
              defaultExposedId(
                { id: sanitizeId(provider.id), protocol: normalizeProtocol(provider.protocol) },
                { id: modelId },
              );
            provider.models.push({
              id: modelId,
              exposedId,
              displayName: String(raw.displayName || modelId),
              contextLength: pickNumber(raw.contextLength ?? defaults.contextLength, 128000),
              maxOutputTokens: pickNumber(raw.maxOutputTokens ?? defaults.maxOutputTokens, 8192),
              vision: bool(raw.vision, defaults.vision === true),
              toolUse: bool(raw.toolUse, defaults.toolUse !== false),
              reasoning: bool(raw.reasoning, defaults.reasoning !== false),
              efforts: Array.isArray(raw.efforts)
                ? raw.efforts.map(String)
                : Array.isArray(defaults.efforts)
                  ? defaults.efforts.map(String)
                  : [],
              defaultEffort: String(raw.defaultEffort ?? defaults.defaultEffort ?? ''),
            });
            added += 1;
          }

          if (added === 0) throw Object.assign(new Error('没有新模型可添加'), { status: 400 });
          return { structural: true };
        });
        sendJson(res, 200, state);
      } catch (err) {
        sendJson(res, err.status || 400, { error: err.message });
      }
      return true;
    }

    const testMatch = pathname.match(/^\/api\/providers\/([^/]+)\/test$/);
    if (testMatch && req.method === 'POST') {
      try {
        const id = decodeURIComponent(testMatch[1]);
        const body = await readBody(req).catch(() => ({}));
        const cfg = readConfig();
        const provider = locateProvider(cfg, id);
        const result = await testProvider(provider, body.modelId);
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, err.status || 400, { error: err.message });
      }
      return true;
    }

    const modelMatch = pathname.match(/^\/api\/models\/(.+)$/);
    if (modelMatch && req.method === 'PATCH') {
      try {
        const exposedId = decodeURIComponent(modelMatch[1]);
        const body = await readBody(req);
        const state = await mutation((cfg) => {
          const { provider, model } = locateModel(cfg, exposedId);
          if (typeof body.id === 'string' && body.id.trim()) model.id = body.id.trim();
          if (typeof body.exposedId === 'string' && body.exposedId.trim()) {
            const nextExposedId = body.exposedId.trim();
            if (nextExposedId !== model.exposedId) {
              const validPrefix =
                normalizeProtocol(provider.protocol) === 'chat' ? /^kimi-/ : /^(gpt-|codex-)/;
              if (!validPrefix.test(nextExposedId)) {
                throw Object.assign(
                  new Error(
                    normalizeProtocol(provider.protocol) === 'chat'
                      ? 'Kimi 模型 ID 必须以 kimi- 开头'
                      : 'Kimi 模型 ID 必须以 gpt- 或 codex- 开头',
                  ),
                  { status: 400 },
                );
              }
              for (const other of cfg.providers || []) {
                for (const item of other.models || []) {
                  if (item !== model && String(item.exposedId) === nextExposedId) {
                    throw Object.assign(new Error(`Kimi 模型 ID 已存在：${nextExposedId}`), { status: 400 });
                  }
                }
              }
              model.exposedId = nextExposedId;
            }
          }
          if (typeof body.displayName === 'string' && body.displayName.trim()) model.displayName = body.displayName.trim();
          if (body.contextLength !== undefined) model.contextLength = pickNumber(body.contextLength, model.contextLength);
          if (body.maxOutputTokens !== undefined)
            model.maxOutputTokens = pickNumber(body.maxOutputTokens, model.maxOutputTokens);
          if (typeof body.vision === 'boolean') model.vision = body.vision;
          if (typeof body.toolUse === 'boolean') model.toolUse = body.toolUse;
          if (typeof body.reasoning === 'boolean') model.reasoning = body.reasoning;
          if (Array.isArray(body.efforts)) model.efforts = body.efforts.map(String).filter(Boolean);
          if (typeof body.defaultEffort === 'string') model.defaultEffort = body.defaultEffort;
          return { structural: true };
        });
        sendJson(res, 200, state);
      } catch (err) {
        sendJson(res, err.status || 400, { error: err.message });
      }
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/sync') {
      try {
        const output = await runSync();
        syncPending = false;
        lastSyncedAt = new Date().toISOString();
        lastSyncOutput = output;
        sendJson(res, 200, { ok: true, output, state: buildState() });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/metrics/reset') {
      metrics.reset();
      sendJson(res, 200, { ok: true, state: buildState() });
      return true;
    }

    return false;
  }

  return { handle, buildState };
}
