// Rolling metrics for the bridge: totals, per-model, per-minute/hour/day
// buckets and a short recent-request feed. Persisted to metrics.json with a
// debounced write so a restart keeps the day's numbers.

import fs from 'node:fs';

const MINUTE = 60_000;
const KEEP_MINUTES = 60 * 24 * 2;
const KEEP_HOURS = 24 * 45;
const KEEP_DAYS = 90;
const RECENT_LIMIT = 200;

function emptyBucket() {
  return { requests: 0, errors: 0, input: 0, output: 0, cached: 0, durationMs: 0, ttftMs: 0, ttftCount: 0 };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function hourKey(date) {
  return `${dayKey(date)}T${pad(date.getHours())}`;
}

export function minuteKey(date) {
  return `${hourKey(date)}:${pad(date.getMinutes())}`;
}

function addTo(target, evt) {
  target.requests += 1;
  if (!evt.ok) target.errors += 1;
  target.input += evt.input;
  target.output += evt.output;
  target.cached += evt.cached;
  target.durationMs += evt.ms;
  if (typeof evt.ttft === 'number') {
    target.ttftMs += evt.ttft;
    target.ttftCount += 1;
  }
}

function pickBucket(bucket) {
  if (!bucket) {
    return { requests: 0, errors: 0, input: 0, output: 0, cached: 0, durationMs: 0, ttftMs: 0, ttftCount: 0 };
  }
  const { requests, errors, input, output, cached, durationMs, ttftMs, ttftCount } = bucket;
  return {
    requests,
    errors,
    input,
    output,
    cached,
    durationMs,
    ttftMs: ttftMs || 0,
    ttftCount: ttftCount || 0,
  };
}

export class MetricsStore {
  constructor(file) {
    this.file = file;
    this.recentLimit = RECENT_LIMIT;
    this.state = this.#load();
    this.saveTimer = null;
    this.recordsSincePrune = 0;
  }

  #load() {
    const base = { createdAt: new Date().toISOString(), totals: emptyBucket(), byModel: {}, minutes: {}, hours: {}, days: {}, recent: [] };
    if (!this.file || !fs.existsSync(this.file)) return base;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        createdAt: parsed.createdAt || base.createdAt,
        totals: { ...emptyBucket(), ...(parsed.totals || {}) },
        byModel: parsed.byModel && typeof parsed.byModel === 'object' ? parsed.byModel : {},
        minutes: parsed.minutes && typeof parsed.minutes === 'object' ? parsed.minutes : {},
        hours: parsed.hours && typeof parsed.hours === 'object' ? parsed.hours : {},
        days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
        recent: Array.isArray(parsed.recent) ? parsed.recent.slice(0, RECENT_LIMIT) : [],
      };
    } catch (err) {
      console.error(`[metrics] 读取 ${this.file} 失败，从零开始：${err.message}`);
      return base;
    }
  }

  record(evt) {
    const date = new Date(evt.ts || Date.now());
    const input = Number(evt.input) || 0;
    const output = Number(evt.output) || 0;
    const cached = Number(evt.cached) || 0;
    const normalized = {
      ts: date.getTime(),
      model: String(evt.model || 'unknown'),
      provider: String(evt.provider || ''),
      endpoint: String(evt.endpoint || ''),
      status: Number(evt.status) || 0,
      ms: Number(evt.ms) || 0,
      ttft: typeof evt.ttft === 'number' ? evt.ttft : null,
      stream: evt.stream === true,
      input,
      output,
      cached,
      ok: evt.ok !== false,
      error: evt.error ? String(evt.error).slice(0, 200) : '',
    };

    const mk = minuteKey(date);
    const hk = hourKey(date);
    const dk = dayKey(date);

    addTo(this.state.totals, normalized);
    addTo((this.state.minutes[mk] ||= emptyBucket()), normalized);
    addTo((this.state.hours[hk] ||= emptyBucket()), normalized);
    addTo((this.state.days[dk] ||= emptyBucket()), normalized);

    const model = (this.state.byModel[normalized.model] ||= { ...emptyBucket(), lastAt: 0, provider: '' });
    addTo(model, normalized);
    model.lastAt = normalized.ts;
    if (normalized.provider) model.provider = normalized.provider;

    this.state.recent.unshift(normalized);
    if (this.state.recent.length > this.recentLimit) this.state.recent.length = this.recentLimit;

    if (++this.recordsSincePrune >= 100) {
      this.recordsSincePrune = 0;
      this.#prune(date);
    }
    this.scheduleSave();
  }

  #prune(now) {
    const minuteFloor = minuteKey(new Date(now.getTime() - KEEP_MINUTES * MINUTE));
    for (const key of Object.keys(this.state.minutes)) {
      if (key < minuteFloor) delete this.state.minutes[key];
    }
    const hourFloor = hourKey(new Date(now.getTime() - KEEP_HOURS * 3_600_000));
    for (const key of Object.keys(this.state.hours)) {
      if (key < hourFloor) delete this.state.hours[key];
    }
    const dayFloor = dayKey(new Date(now.getTime() - KEEP_DAYS * 86_400_000));
    for (const key of Object.keys(this.state.days)) {
      if (key < dayFloor) delete this.state.days[key];
    }
  }

  snapshot() {
    const now = new Date();
    const minutes = [];
    for (let i = 59; i >= 0; i--) {
      const date = new Date(now.getTime() - i * MINUTE);
      const key = minuteKey(date);
      minutes.push({ t: key, ...pickBucket(this.state.minutes[key]) });
    }
    const hours = [];
    for (let i = 23; i >= 0; i--) {
      const date = new Date(now.getTime() - i * 3_600_000);
      const key = hourKey(date);
      hours.push({ t: key, ...pickBucket(this.state.hours[key]) });
    }

    const total = this.state.totals;
    const totals = {
      ...pickBucket(total),
      ttftMs: total.ttftMs,
      ttftCount: total.ttftCount,
      avgMs: total.requests ? Math.round(total.durationMs / total.requests) : 0,
      avgTtft: total.ttftCount ? Math.round(total.ttftMs / total.ttftCount) : null,
    };
    const todayBucket = this.state.days[dayKey(now)];
    const today = {
      ...pickBucket(todayBucket),
      avgMs: todayBucket && todayBucket.requests ? Math.round(todayBucket.durationMs / todayBucket.requests) : 0,
      avgTtft: todayBucket && todayBucket.ttftCount ? Math.round(todayBucket.ttftMs / todayBucket.ttftCount) : null,
    };

    const byModel = {};
    for (const [key, value] of Object.entries(this.state.byModel)) {
      byModel[key] = {
        ...pickBucket(value),
        avgMs: value.requests ? Math.round(value.durationMs / value.requests) : 0,
        avgTtft: value.ttftCount ? Math.round(value.ttftMs / value.ttftCount) : null,
        lastAt: value.lastAt,
        provider: value.provider,
      };
    }

    return {
      createdAt: this.state.createdAt,
      totals,
      today,
      byModel,
      series: { minutes, hours },
      recent: this.state.recent.slice(0, 80),
      updatedAt: new Date().toISOString(),
    };
  }

  reset() {
    const createdAt = new Date().toISOString();
    this.state = { createdAt, totals: emptyBucket(), byModel: {}, minutes: {}, hours: {}, days: {}, recent: [] };
    this.saveNow();
  }

  scheduleSave() {
    if (!this.file) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 2000);
    this.saveTimer.unref?.();
  }

  saveNow() {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[metrics] 写入 ${this.file} 失败：${err.message}`);
    }
  }
}
