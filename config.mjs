// Shared config validation for the bridge and the admin API.
//
// buildProviders() is the single place that turns config.json providers into
// runtime provider/model objects. It throws Error with a human message; the
// bridge exits on startup, the admin API returns the message as a 400.

export function sanitizeId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeProtocol(value) {
  return String(value || '').toLowerCase() === 'chat' ? 'chat' : 'responses';
}

export function normalizeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function normalizeBaseUrl(value) {
  const base = String(value || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    throw new Error(`baseUrl 必须以 http:// 或 https:// 开头（当前："${value}"）`);
  }
  return base;
}

export function defaultExposedId(provider, model) {
  const prefix = provider.protocol === 'chat' ? 'kimi-' : 'gpt-';
  const providerId = sanitizeId(provider.id);
  const modelId = sanitizeId(model.id);
  let tail = !providerId || modelId.toLowerCase().startsWith(providerId.toLowerCase())
    ? modelId
    : `${providerId}-${modelId}`;
  if (tail.toLowerCase().startsWith(prefix)) tail = tail.slice(prefix.length);
  return `${prefix}${tail}`;
}

export function buildProviders(rawProviders) {
  if (!Array.isArray(rawProviders)) {
    throw new Error('config.providers 必须是数组');
  }
  const providers = [];
  const modelMap = new Map();

  for (const rawProvider of rawProviders) {
    if (!rawProvider || typeof rawProvider !== 'object') throw new Error('服务商配置必须是对象');
    const protocol = normalizeProtocol(rawProvider.protocol);
    const provider = {
      id: sanitizeId(rawProvider.id) || `provider-${providers.length + 1}`,
      name: String(rawProvider.name || rawProvider.id || 'Provider'),
      protocol,
      baseUrl: normalizeBaseUrl(rawProvider.baseUrl),
      apiKey: typeof rawProvider.apiKey === 'string' ? rawProvider.apiKey.trim() : '',
      apiKeyEnv: typeof rawProvider.apiKeyEnv === 'string' ? rawProvider.apiKeyEnv.trim() : '',
      headers: rawProvider.headers && typeof rawProvider.headers === 'object' ? { ...rawProvider.headers } : {},
      effortMap:
        rawProvider.effortMap && typeof rawProvider.effortMap === 'object' ? { ...rawProvider.effortMap } : null,
      streamUsage: rawProvider.streamUsage !== false,
      enabled: rawProvider.enabled !== false,
      models: [],
    };
    if (!Array.isArray(rawProvider.models) || rawProvider.models.length === 0) {
      throw new Error(`服务商 "${provider.id}" 没有任何模型`);
    }

    const seen = [];
    for (const rawModel of rawProvider.models) {
      if (!rawModel || typeof rawModel.id !== 'string' || !rawModel.id.trim()) {
        throw new Error(`服务商 "${provider.id}" 有模型缺少 id`);
      }
      const exposedId = String(rawModel.exposedId || defaultExposedId(provider, rawModel)).trim();
      const validPrefix = protocol === 'chat' ? /^kimi-/ : /^(gpt-|codex-)/;
      if (!validPrefix.test(exposedId)) {
        throw new Error(
          `模型 "${rawModel.id}"：exposedId "${exposedId}" 必须以 ${protocol === 'chat' ? 'kimi-' : 'gpt- 或 codex-'} 开头`,
        );
      }
      if (seen.includes(exposedId)) throw new Error(`服务商 "${provider.id}" 内 exposedId 重复："${exposedId}"`);
      seen.push(exposedId);
      if (provider.enabled && modelMap.has(exposedId)) throw new Error(`exposedId 重复："${exposedId}"`);

      const model = {
        id: rawModel.id.trim(),
        exposedId,
        displayName: String(rawModel.displayName || exposedId),
        contextLength: normalizeNumber(rawModel.contextLength, 128000),
        maxOutputTokens: normalizeNumber(rawModel.maxOutputTokens, 8192),
        vision: rawModel.vision === true,
        toolUse: rawModel.toolUse !== false,
        reasoning: rawModel.reasoning !== false,
        efforts: Array.isArray(rawModel.efforts) ? rawModel.efforts.map(String) : [],
        defaultEffort: typeof rawModel.defaultEffort === 'string' ? rawModel.defaultEffort : '',
        protocol,
        provider,
      };
      provider.models.push(model);
      if (provider.enabled) modelMap.set(exposedId, model);
    }
    providers.push(provider);
  }

  const enabled = providers.filter((p) => p.enabled);
  return {
    providers: enabled,
    allProviders: providers,
    modelMap,
  };
}

// "sk-EXAMPLE0000000000000000000000" -> "sk-EXAM••••••0000"
export function maskKey(key) {
  const value = String(key || '');
  if (!value) return '';
  if (value.length <= 10) return `${value.slice(0, 2)}••••`;
  return `${value.slice(0, 6)}••••••${value.slice(-4)}`;
}

