// Rebuild Kimi's local BYOK model list from config.json.
// Run: node apply-kimi-settings.mjs
// Then restart Kimi.
//
// This creates/updates the model list in:
//   byok-providers.json
//   daimon-share/daimon/config.json
//   daimon-share/daimon/runtime/kimi-code/config.toml
//
// Existing provider credentials (the encrypted Kimi BYOK token) are preserved.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.env.KIMI_GATEWAY_CONFIG || path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const providers = Array.isArray(config.providers) ? config.providers : [];
if (providers.length === 0) {
  throw new Error('config.json: providers must be a non-empty array');
}

const port = Number(config.port) > 0 ? Number(config.port) : 8787;
const localBase = `http://127.0.0.1:${port}/v1`;

function normalizeEfforts(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function generateModels() {
  const generated = [];
  for (const provider of providers) {
    const protocol = String(provider.protocol || 'responses').toLowerCase() === 'chat' ? 'chat' : 'responses';
    const providerId = protocol === 'chat' ? 'byok-kth-kimi' : 'byok-kth-resp';
    const family = protocol === 'chat' ? 'kimi' : 'gpt';
    for (const model of provider.models || []) {
      if (!model || !model.id || !model.exposedId) continue;
      const capabilities = [];
      if (model.toolUse !== false) capabilities.push('tool_use');
      if (model.reasoning !== false) capabilities.push('thinking');
      if (model.vision === true) capabilities.push('image_in');
      generated.push({
        alias: `${providerId}/${model.exposedId}`,
        providerId,
        model: String(model.exposedId),
        displayName: String(model.displayName || model.exposedId),
        family,
        protocol,
        maxContextSize: Number(model.contextLength) > 0 ? Number(model.contextLength) : 128000,
        maxOutputSize: Number(model.maxOutputTokens) > 0 ? Number(model.maxOutputTokens) : 8192,
        capabilities,
        supportEfforts: normalizeEfforts(model.efforts),
        defaultEffort: typeof model.defaultEffort === 'string' ? model.defaultEffort : '',
      });
    }
  }
  return generated;
}

const generated = generateModels();
if (generated.length === 0) throw new Error('config.json: no usable models');

const userData = process.env.KIMI_USER_DATA || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'kimi-desktop');
const daimonDir = path.join(userData, 'daimon-share', 'daimon');
const byokPath = path.join(daimonDir, 'byok-providers.json');
const daimonConfigPath = path.join(daimonDir, 'config.json');
const tomlPath = path.join(daimonDir, 'runtime', 'kimi-code', 'config.toml');

function backup(file) {
  if (!fs.existsSync(file)) return;
  fs.copyFileSync(file, file + '.bak');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function profileModel(model) {
  return {
    alias: model.alias,
    providerId: model.providerId,
    model: model.model,
    displayName: model.displayName,
    family: model.family,
    maxContextSize: model.maxContextSize,
    maxOutputSize: model.maxOutputSize,
    capabilities: [...model.capabilities],
    ...(model.supportEfforts.length > 0 ? { supportEfforts: [...model.supportEfforts] } : {}),
    ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
  };
}

function daimonModel(model) {
  return {
    provider: model.providerId,
    model: model.model,
    maxContextSize: model.maxContextSize,
    maxOutputSize: model.maxOutputSize,
    capabilities: [...model.capabilities],
    ...(model.supportEfforts.length > 0 ? { supportEfforts: [...model.supportEfforts] } : {}),
    ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
  };
}

let profileCount = 0;
if (fs.existsSync(byokPath)) {
  backup(byokPath);
  const byok = readJson(byokPath);
  for (const profiles of Object.values(byok.profiles || {})) {
    for (const profile of Object.values(profiles || {})) {
      profile.models = generated.map(profileModel);
      profile.baseUrl = localBase;
      profile.revision = crypto.randomUUID();
      profile.lastCheckedAt = new Date().toISOString();
      profile.delisted = [];
      delete profile.pending;
      profileCount++;
    }
  }
  writeJson(byokPath, byok);
}

let daimonCount = 0;
if (fs.existsSync(daimonConfigPath)) {
  backup(daimonConfigPath);
  const cfg = readJson(daimonConfigPath);
  cfg.model = cfg.model || {};
  cfg.model.providers = cfg.model.providers || {};
  cfg.model.models = cfg.model.models || {};
  const usedProviders = new Set(generated.map((model) => model.providerId));
  for (const key of Object.keys(cfg.model.providers)) {
    if (key.startsWith('byok-kth-') && !usedProviders.has(key)) delete cfg.model.providers[key];
  }
  for (const providerId of usedProviders) {
    cfg.model.providers[providerId] = {
      type: providerId === 'byok-kth-kimi' ? 'openai' : 'openai_responses',
      baseUrl: localBase,
      credential: 'byokKth',
    };
  }
  for (const key of Object.keys(cfg.model.models)) {
    if (key.startsWith('byok-kth-')) delete cfg.model.models[key];
  }
  for (const model of generated) {
    cfg.model.models[model.alias] = daimonModel(model);
    daimonCount++;
  }
  writeJson(daimonConfigPath, cfg);
}

let tomlCount = 0;
if (fs.existsSync(tomlPath)) {
  backup(tomlPath);
  const original = fs.readFileSync(tomlPath, 'utf8');
  const tokenMatch = original.match(/\[providers\.byok-kth-(?:resp|kimi)\][\s\S]*?api_key\s*=\s*"([^"]+)"/);
  const token = tokenMatch ? tokenMatch[1] : 'local';

  const kept = [];
  let skip = false;
  for (const line of original.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]/);
    if (section) {
      skip = /^providers\.byok-kth/.test(section[1]) || /^models\."?byok-kth/.test(section[1]);
      if (skip) continue;
    }
    if (!skip) kept.push(line);
  }

  const append = [];
  const usedProviders = new Set(generated.map((model) => model.providerId));
  if (usedProviders.has('byok-kth-kimi')) {
    append.push(
      '[providers.byok-kth-kimi]',
      'type = "openai"',
      `api_key = "${token.replace(/"/g, '\\"')}"`,
      `base_url = "${localBase}"`,
      '',
    );
  }
  if (usedProviders.has('byok-kth-resp')) {
    append.push(
      '[providers.byok-kth-resp]',
      'type = "openai_responses"',
      `api_key = "${token.replace(/"/g, '\\"')}"`,
      `base_url = "${localBase}"`,
      '',
    );
  }
  for (const model of generated) {
    append.push(
      `[models."${model.alias}"]`,
      `provider = "${model.providerId}"`,
      `model = "${model.model}"`,
      `max_context_size = ${model.maxContextSize}`,
      `max_output_size = ${model.maxOutputSize}`,
      `capabilities = [ ${model.capabilities.map((name) => `"${name}"`).join(', ')} ]`,
    );
    if (model.supportEfforts.length > 0) {
      append.push(`support_efforts = [ ${model.supportEfforts.map((name) => `"${name}"`).join(', ')} ]`);
    }
    if (model.defaultEffort) append.push(`default_effort = "${model.defaultEffort}"`);
    append.push('');
    tomlCount++;
  }
  const keptText = kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  fs.writeFileSync(tomlPath, `${keptText}\n\n${append.join('\n')}`);
}

console.log('Rebuilt Kimi BYOK model list:');
console.log(`  port: ${port}`);
console.log(`  configured providers: ${providers.length}`);
console.log(`  configured models: ${generated.length}`);
console.log(`  profiles updated: ${profileCount}`);
console.log(`  daimon models written: ${daimonCount}`);
console.log(`  config.toml model sections: ${tomlCount}`);
console.log('');
console.log('Restart Kimi to reload the model list.');
