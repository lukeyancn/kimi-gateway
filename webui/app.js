/* Kimi 模型桥 · 控制台 — 无依赖前端 */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const html = document.documentElement;

  const state = {
    data: null,
    range: localStorage.getItem('bridge.range') === 'hours' ? 'hours' : 'minutes',
    theme:
      localStorage.getItem('bridge.theme') ||
      (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
    tests: {},
    seen: new Set(),
    providerSig: '',
    kimiSig: '',
    modelsSig: '',
    chartMeta: null,
    hover: null,
    offline: false,
  };

  html.dataset.theme = state.theme;

  const PROVIDER_PRESETS = [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      protocol: 'responses',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      effortMap: { minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'max' },
    },
    { id: 'openai', name: 'OpenAI', protocol: 'responses', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
    { id: 'openrouter', name: 'OpenRouter', protocol: 'chat', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
    { id: 'qwen', name: 'Qwen', protocol: 'chat', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'DASHSCOPE_API_KEY' },
    { id: 'kimi', name: 'Kimi', protocol: 'chat', baseUrl: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY' },
    { id: 'glm', name: 'GLM', protocol: 'chat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY' },
    { id: 'siliconflow', name: 'SiliconFlow', protocol: 'chat', baseUrl: 'https://api.siliconflow.cn/v1', apiKeyEnv: 'SILICONFLOW_API_KEY' },
    { id: 'ollama', name: 'Ollama', protocol: 'chat', baseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: '' },
  ];

  const CONTEXT_SIZES = [
    [32768, '32K'],
    [65536, '64K'],
    [131072, '128K'],
    [262144, '256K'],
    [524288, '512K'],
    [1000000, '1M'],
    [2000000, '2M'],
  ];
  const OUTPUT_SIZES = [
    [4096, '4K'],
    [8192, '8K'],
    [16384, '16K'],
    [32768, '32K'],
    [65536, '64K'],
    [131072, '128K'],
    [262144, '256K'],
    [393216, '384K'],
  ];

  /* ------------------------------------------------------------- utilities */

  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );

  const numberFmt = new Intl.NumberFormat('zh-CN');

  function fmtNum(n) {
    return numberFmt.format(Math.round(Number(n) || 0));
  }

  function trimZero(text) {
    return text.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  }

  function fmtTokens(n) {
    const value = Math.round(Number(n) || 0);
    if (value >= 1e9) return `${trimZero((value / 1e9).toFixed(2))}B`;
    if (value >= 1e6) return `${trimZero((value / 1e6).toFixed(2))}M`;
    if (value >= 1e3) return `${trimZero((value / 1e3).toFixed(1))}K`;
    return String(value);
  }

  function fmtMs(ms) {
    const value = Math.round(Number(ms) || 0);
    if (value < 1000) return `${value} ms`;
    if (value < 10000) return `${(value / 1000).toFixed(2)} s`;
    return `${(value / 1000).toFixed(1)} s`;
  }

  function fmtUptime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (days > 0) return `${days} 天 ${hours} 小时`;
    if (hours > 0) return `${hours} 小时 ${minutes} 分`;
    if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
    return `${seconds} 秒`;
  }

  function fmtClock(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function fmtBucketLabel(key, range) {
    if (!key) return '';
    if (range === 'hours') return `${key.slice(11, 13)}:00`;
    return key.slice(11, 16);
  }

  function pct(part, total) {
    if (!total) return 0;
    return Math.min(100, Math.round((part / total) * 1000) / 10);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { 'content-type': 'application/json' },
      ...options,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(payload?.error || `请求失败（HTTP ${response.status}）`);
    }
    return payload;
  }

  function toast(title, message = '', type = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="bar"></span><div><strong>${esc(title)}</strong>${
      message ? `<span>${esc(message)}</span>` : ''
    }</div>`;
    $('#toasts').appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 220);
    }, 3200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    }
  }

  /* ------------------------------------------------------------------ icons */

  const ICONS = {
    requests:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h3.6l2.4-7 4 14 2.4-7H21"/></svg>',
    input:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10"/><path d="m8 10 4 4 4-4"/><path d="M5 19h14"/></svg>',
    output:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V10"/><path d="m8 14 4-4 4 4"/><path d="M5 5h14"/></svg>',
    latency:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.2"/><path d="M12 7.6V12l3 1.9"/></svg>',
    copy:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.4"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    eye:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 3l18 18"/><path d="M10.6 6.1A9.9 9.9 0 0 1 12 6c6 0 9.5 6 9.5 6a17.6 17.6 0 0 1-3.3 3.9"/><path d="M6.6 6.9A17.7 17.7 0 0 0 2.5 12S6 18 12 18a9.9 9.9 0 0 0 4.2-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
  };

  /* ------------------------------------------------------------------- KPIs */

  function sparkline(values, color) {
    if (!values || !values.some((v) => v > 0)) return '';
    const w = 96;
    const h = 34;
    const pad = 3;
    const max = Math.max(1, ...values);
    const step = (w - pad * 2) / Math.max(1, values.length - 1);
    const points = values.map((v, i) => [pad + i * step, h - pad - (v / max) * (h - pad * 2)]);
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    const area = `${line} L ${w - pad} ${h - pad} L ${pad} ${h - pad} Z`;
    return `<svg class="spark" style="color:${color}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <path d="${area}" fill="currentColor" opacity=".12"/>
      <path d="${line}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
  }

  function renderKpis() {
    const data = state.data;
    if (!data) return;
    const today = data.metrics.today;
    const minutes = data.metrics.series.minutes;
    const success = today.requests ? (1 - today.errors / today.requests) * 100 : 100;
    const successText = `${success.toFixed(success === 100 ? 0 : 1)}%`;

    const cards = [
      {
        label: '今日请求',
        value: fmtNum(today.requests),
        sub: today.errors ? `<b>${today.errors}</b> 次失败 · 成功率 ${successText}` : `成功率 ${successText}`,
        icon: ICONS.requests,
        spark: sparkline(minutes.map((m) => m.requests), 'var(--accent)'),
      },
      {
        label: '输入 Token',
        value: fmtTokens(today.input),
        sub: today.cached ? `缓存命中 <b>${fmtTokens(today.cached)}</b>` : '按上游返回的 usage 统计',
        icon: ICONS.input,
        spark: sparkline(minutes.map((m) => m.input), 'var(--accent)'),
      },
      {
        label: '输出 Token',
        value: fmtTokens(today.output),
        sub: `平均 <b>${fmtTokens(today.requests ? today.output / today.requests : 0)}</b> / 次`,
        icon: ICONS.output,
        spark: sparkline(minutes.map((m) => m.output), 'var(--cyan)'),
      },
      {
        label: '平均延迟',
        value: today.avgMs ? fmtMs(today.avgMs) : '—',
        sub: `首字 <b>${today.avgTtft ? fmtMs(today.avgTtft) : '—'}</b>`,
        icon: ICONS.latency,
        small: true,
      },
    ];

    $('#kpis').innerHTML = cards
      .map(
        (card) => `<article class="card kpi">
          <div class="kpi-top">
            <span class="kpi-label">${card.label}</span>
            <span class="kpi-icon">${card.icon}</span>
          </div>
          <div class="kpi-value${card.small ? ' small' : ''}">${card.value}</div>
          <div class="kpi-sub">${card.sub}</div>
          ${card.spark || ''}
        </article>`,
      )
      .join('');
  }

  /* ------------------------------------------------------------------ chart */

  const THEME = {
    dark: {
      grid: 'rgba(255,255,255,.055)',
      axis: '#6a7188',
      line: 'rgba(255,255,255,.5)',
      barIn: ['#b18cff', '#7a68ff'],
      barOut: ['#5ad2f4', '#2b8fb8'],
      hover: 'rgba(255,255,255,.06)',
    },
    light: {
      grid: 'rgba(20,23,38,.07)',
      axis: '#8b91a6',
      line: 'rgba(20,23,38,.4)',
      barIn: ['#8b7cff', '#5b4bff'],
      barOut: ['#4cc9f0', '#0b93c4'],
      hover: 'rgba(20,23,38,.04)',
    },
  };

  function niceMax(value) {
    // An empty chart still needs readable ticks: 1 would render 0,1,1,1,1.
    if (!value || value <= 0) return 4;
    const exponent = Math.floor(Math.log10(value));
    const base = 10 ** exponent;
    const n = value / base;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * base;
  }

  function roundTop(ctx, x, y, w, h, r) {
    if (h <= 0.4) return;
    const radius = Math.min(r, h, w / 2);
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fill();
  }

  function drawTraffic() {
    const canvas = $('#trafficChart');
    const data = state.data;
    if (!canvas || !data) return;
    const series = data.metrics.series[state.range];
    const wrap = canvas.parentElement;
    const width = Math.max(240, wrap.clientWidth);
    const height = 260;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const theme = THEME[state.theme] || THEME.dark;
    const padL = 48;
    const padR = 36;
    const padT = 14;
    const padB = 26;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const totals = series.map((d) => d.input + d.output);
    const maxTokens = Math.max(0, ...totals);
    const rawMaxReq = Math.max(1, ...series.map((d) => d.requests));
    const reqTop = Math.max(4, niceMax(rawMaxReq));
    const top = niceMax(maxTokens);
    const slot = plotW / series.length;
    state.chartMeta = { padL, padT, padB, plotW, plotH, slot, series, width };

    // grid + left axis
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';
    const lines = 4;
    for (let i = 0; i <= lines; i++) {
      const y = padT + (plotH / lines) * i;
      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(y) + 0.5);
      ctx.lineTo(padL + plotW, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = theme.axis;
      ctx.textAlign = 'right';
      ctx.fillText(fmtTokens(top - (top / lines) * i), padL - 9, y);
    }

    // x labels
    ctx.textAlign = 'center';
    ctx.fillStyle = theme.axis;
    const labelEvery = state.range === 'hours' ? 4 : 15;
    series.forEach((d, i) => {
      if (i % labelEvery !== 0 && i !== series.length - 1) return;
      const x = padL + slot * i + slot / 2;
      ctx.fillText(fmtBucketLabel(d.t, state.range), x, height - 9);
    });

    // right axis (requests)
    ctx.textAlign = 'left';
    for (let i = 0; i <= lines; i++) {
      const y = padT + (plotH / lines) * i;
      const value = Math.round(reqTop - (reqTop / lines) * i);
      ctx.fillText(String(value), padL + plotW + 9, y);
    }

    if (maxTokens === 0 && series.every((d) => d.requests === 0)) {
      ctx.fillStyle = theme.axis;
      ctx.textAlign = 'center';
      ctx.font = '12px "Segoe UI", system-ui, sans-serif';
      ctx.fillText('还没有流量，去 Kimi 里聊一句试试', padL + plotW / 2, padT + plotH / 2);
      return;
    }

    const gradIn = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    gradIn.addColorStop(0, theme.barIn[0]);
    gradIn.addColorStop(1, theme.barIn[1]);
    const gradOut = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    gradOut.addColorStop(0, theme.barOut[0]);
    gradOut.addColorStop(1, theme.barOut[1]);

    const barW = Math.max(2, Math.min(16, slot * 0.58));
    const baseY = padT + plotH;

    series.forEach((d, i) => {
      const x = padL + slot * i + (slot - barW) / 2;
      const inH = (d.input / top) * plotH;
      const outH = (d.output / top) * plotH;
      if (inH > 0.3) {
        ctx.fillStyle = gradIn;
        roundTop(ctx, x, baseY - inH, barW, inH, 3);
      }
      if (outH > 0.3) {
        ctx.fillStyle = gradOut;
        roundTop(ctx, x, baseY - inH - outH, barW, outH, 3);
      }
    });

    // request line (smooth, secondary axis)
    const linePoints = series.map((d, i) => ({
      x: padL + slot * i + slot / 2,
      y: padT + plotH - (d.requests / reqTop) * plotH * 0.6,
    }));
    ctx.beginPath();
    ctx.moveTo(linePoints[0].x, linePoints[0].y);
    for (let i = 1; i < linePoints.length - 1; i++) {
      const cx = (linePoints[i].x + linePoints[i + 1].x) / 2;
      const cy = (linePoints[i].y + linePoints[i + 1].y) / 2;
      ctx.quadraticCurveTo(linePoints[i].x, linePoints[i].y, cx, cy);
    }
    const lastPoint = linePoints[linePoints.length - 1];
    ctx.lineTo(lastPoint.x, lastPoint.y);
    ctx.strokeStyle = theme.line;
    ctx.globalAlpha = 0.62;
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.globalAlpha = 1;

    // hover
    if (state.hover != null && series[state.hover]) {
      const i = state.hover;
      const d = series[i];
      const x = padL + slot * i;
      ctx.fillStyle = theme.hover;
      ctx.fillRect(x, padT, slot, plotH);
      const cx = x + slot / 2;
      const y = padT + plotH - (d.requests / reqTop) * plotH * 0.6;
      ctx.beginPath();
      ctx.arc(cx, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = theme.line;
      ctx.fill();
    }
  }

  function bindChart() {
    const canvas = $('#trafficChart');
    const tip = $('#chartTip');
    if (!canvas) return;

    canvas.addEventListener('mousemove', (event) => {
      const meta = state.chartMeta;
      if (!meta) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const index = Math.floor((x - meta.padL) / meta.slot);
      if (index < 0 || index >= meta.series.length) {
        hideTip();
        return;
      }
      state.hover = index;
      const d = meta.series[index];
      tip.hidden = false;
      tip.innerHTML = `<div class="tt-time">${esc(fmtBucketLabel(d.t, state.range))}</div>
        <div class="tt-row"><span><i style="background:var(--accent)"></i>输入</span><span>${fmtNum(
          d.input,
        )}</span></div>
        <div class="tt-row"><span><i style="background:var(--cyan)"></i>输出</span><span>${fmtNum(
          d.output,
        )}</span></div>
        <div class="tt-row"><span><i style="background:var(--muted)"></i>请求</span><span>${fmtNum(
          d.requests,
        )}</span></div>`;
      const left = Math.min(Math.max(meta.padL + meta.slot * index + meta.slot / 2, 78), meta.width - 78);
      tip.style.left = `${left}px`;
      tip.style.top = `${meta.padT + 18}px`;
      drawTraffic();
    });

    canvas.addEventListener('mouseleave', hideTip);

    function hideTip() {
      state.hover = null;
      tip.hidden = true;
      drawTraffic();
    }
  }

  /* ------------------------------------------------------------------ usage */

  function renderUsage() {
    const data = state.data;
    if (!data) return;
    const rows = Object.entries(data.metrics.byModel)
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => b.input + b.output - (a.input + a.output));
    const total = rows.reduce((sum, row) => sum + row.input + row.output, 0);
    const container = $('#modelUsage');

    if (!rows.length) {
      container.innerHTML = `<div class="usage-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/></svg>
        还没有调用记录<br />在 Kimi 里选一个模型聊两句
      </div>`;
      return;
    }

    const palette = ['var(--accent)', 'var(--cyan)', 'var(--accent-2)', 'var(--amber)', 'var(--red)'];
    container.innerHTML = rows
      .slice(0, 6)
      .map((row, index) => {
        const tokens = row.input + row.output;
        const share = pct(tokens, total);
        return `<div class="usage-row">
          <div class="usage-head">
            <span class="usage-name">${esc(modelName(row.key))}</span>
            <span class="usage-num">${fmtTokens(tokens)}</span>
          </div>
          <div class="usage-bar"><span style="width:${Math.max(share, tokens ? 2 : 0)}%;background:linear-gradient(90deg,${
            palette[index % palette.length]
          },var(--cyan))"></span></div>
          <div class="usage-meta"><span>${fmtNum(row.requests)} 次请求</span><span>${share}%</span></div>
        </div>`;
      })
      .join('');
  }

  function modelName(exposedId) {
    const model = state.data?.models.find((m) => m.exposedId === exposedId);
    return model?.displayName || exposedId;
  }

  /* -------------------------------------------------------------- providers */

  function providerCard(provider, index) {
    const test = state.tests[provider.id];
    const letter = (provider.name || provider.id || '?').trim().charAt(0).toUpperCase();
    const key = provider.apiKey;
    const stats = provider.models.reduce(
      (acc, model) => {
        const s = state.data?.metrics.byModel[model.exposedId];
        if (s) {
          acc.requests += s.requests;
          acc.tokens += s.input + s.output;
        }
        return acc;
      },
      { requests: 0, tokens: 0 },
    );
    const keyText =
      key.type === 'config' || key.type === 'env'
        ? key.masked || '••••••'
        : key.type === 'env-missing'
          ? '未设置'
          : '使用 Kimi 里的 Token';

    const chips = provider.models
      .slice(0, 2)
      .map((m) => `<span class="model-chip">${esc(m.exposedId)}</span>`)
      .join('');
    const more = provider.models.length > 2 ? `<span class="model-chip">+${provider.models.length - 2}</span>` : '';

    return `<article class="provider-card${provider.enabled ? '' : ' disabled'}">
      <div class="provider-head">
        <div class="provider-avatar" style="--i:${index}">${esc(letter)}</div>
        <div class="provider-id">
          <strong>${esc(provider.name)}</strong>
          <span class="mono">${esc(hostOf(provider.baseUrl))}</span>
        </div>
        <span class="pill">${provider.protocol === 'chat' ? 'chat' : 'responses'}</span>
      </div>

      <div class="kv">
        <span class="kv-label">API Key</span>
        <div class="kv-value">
          <code>${esc(keyText)}</code>
          <button class="btn subtle" data-action="edit-provider" data-id="${esc(provider.id)}">编辑</button>
        </div>
      </div>

      <div class="kv">
        <span class="kv-label">密钥来源</span>
        <div class="kv-value"><span class="src ${key.type}">${esc(key.label)}</span></div>
      </div>

      <div class="kv">
        <span class="kv-label">模型 · ${provider.models.length}</span>
        <div class="model-chips">${chips}${more}</div>
      </div>

      <div class="provider-stats">
        <span><b>${fmtNum(stats.requests)}</b> 次请求</span>
        <span><b>${fmtTokens(stats.tokens)}</b> tokens</span>
      </div>

      ${
        test
          ? `<div class="provider-test ${test.status === 'ok' ? 'ok' : test.status === 'err' ? 'err' : ''}">
              <span class="dot"></span>${test.status === 'running' ? '正在连接上游…' : esc(test.message)}
            </div>`
          : ''
      }

      <div class="provider-actions">
        <button class="btn subtle" data-action="import-models" data-id="${esc(provider.id)}">获取模型</button>
        <button class="btn subtle" data-action="test-provider" data-id="${esc(provider.id)}">测试</button>
        <button class="btn subtle" data-action="toggle-provider" data-id="${esc(provider.id)}">${
          provider.enabled ? '停用' : '启用'
        }</button>
        <button class="btn subtle danger" data-action="delete-provider" data-id="${esc(provider.id)}">删除</button>
      </div>
    </article>`;
  }

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  function renderProviders() {
    const data = state.data;
    if (!data) return;
    const signature = JSON.stringify([
      data.revision,
      data.providers.map((p) => [p.id, p.name, p.enabled, p.protocol, p.baseUrl, p.apiKey.label, p.apiKey.masked, p.models.length]),
      state.tests,
    ]);
    if (signature === state.providerSig) return;
    state.providerSig = signature;

    $('#providers').innerHTML = data.providers.map((p, i) => providerCard(p, i)).join('');
  }

  /* ----------------------------------------------------------------- models */

  function renderModels() {
    const data = state.data;
    if (!data) return;
    const signature = JSON.stringify([
      data.revision,
      data.models.map((m) => [m.exposedId, m.stats?.requests, m.stats?.input, m.stats?.output]),
    ]);
    if (signature === state.modelsSig) return;
    state.modelsSig = signature;

    const tbody = $('#modelsTable tbody');
    if (!data.models.length) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty">还没有模型，先添加一个服务商</div></td></tr>`;
    } else {
      tbody.innerHTML = data.models
        .map((model) => {
          const caps = [];
          if (model.vision) caps.push('<span class="cap vision">视觉</span>');
          if (model.toolUse) caps.push('<span class="cap tool">工具</span>');
          if (model.reasoning) caps.push('<span class="cap reason">思考</span>');
          const stats = model.stats;
          return `<tr class="${model.providerEnabled ? '' : 'dim'}">
            <td>
              <div class="model-name">
                <strong>${esc(model.displayName)}</strong>
                <code data-action="copy" data-text="${esc(model.exposedId)}" title="点击复制">${esc(
                  model.exposedId,
                )}</code>
              </div>
            </td>
            <td>
              <div class="model-name">
                <span style="color:var(--text);font-size:12px">${esc(model.providerName)}</span>
                <code>${esc(model.id)}</code>
              </div>
            </td>
            <td class="num">${fmtTokens(model.contextLength)}</td>
            <td class="num">${fmtTokens(model.maxOutputTokens)}</td>
            <td><div class="caps">${caps.join('') || '<span class="cap">文本</span>'}</div></td>
            <td class="num">${stats ? fmtNum(stats.requests) : '0'}</td>
            <td class="num">
              <strong>${stats ? fmtTokens(stats.input) : '0'}</strong>
              <span style="color:var(--dim)"> / </span>
              ${stats ? fmtTokens(stats.output) : '0'}
            </td>
            <td style="text-align:right">
              <button class="btn subtle" data-action="edit-model" data-id="${esc(model.exposedId)}">编辑</button>
            </td>
          </tr>`;
        })
        .join('');
    }

    const enabled = data.models.filter((m) => m.providerEnabled).length;
    $('#modelCount').textContent = `${enabled} / ${data.models.length} 已启用`;
  }

  /* --------------------------------------------------------------- requests */

  function statusClass(request) {
    if (!request.ok) return 'err';
    if (request.status >= 400) return 'warn';
    return 'ok';
  }

  function renderRequests() {
    const data = state.data;
    if (!data) return;
    const tbody = $('#requestsTable tbody');
    const rows = data.metrics.recent;
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty">暂无请求</div></td></tr>`;
      return;
    }

    tbody.innerHTML = rows
      .slice(0, 14)
      .map((row) => {
        const key = `${row.ts}|${row.model}|${row.status}|${row.ms}`;
        const isNew = !state.seen.has(key);
        state.seen.add(key);
        const cls = statusClass(row);
        return `<tr class="${isNew ? 'row-new' : ''}">
          <td class="t-time">${fmtClock(row.ts)}</td>
          <td><span class="truncate" title="${esc(row.model)}">${esc(modelName(row.model))}</span></td>
          <td><span class="endpoint-tag">${row.endpoint === 'chat' ? '/chat' : '/responses'}</span></td>
          <td><span class="status-code ${cls}">${row.status || '—'}</span></td>
          <td class="num">${fmtMs(row.ms)}</td>
          <td class="num">${row.ttft != null ? fmtMs(row.ttft) : '—'}</td>
          <td class="num">${row.input ? fmtNum(row.input) : '—'}</td>
          <td class="num">${row.output ? fmtNum(row.output) : '—'}</td>
        </tr>`;
      })
      .join('');
  }

  /* ---------------------------------------------------------------- gateway */

  function renderGateway() {
    const data = state.data;
    if (!data) return;
    const g = data.gateway;
    const base = `http://127.0.0.1:${g.port}/v1`;
    $('#gatewayInfo').innerHTML = `
      <div class="gw-row">
        <span class="k">Base URL</span>
        <div class="v">
          <code title="${base}">${base}</code>
          <button class="copy-btn" data-copy="${base}" title="复制">${ICONS.copy}</button>
        </div>
      </div>
      <div class="gw-row"><span class="k">端口</span><div class="v"><code>${g.port}</code></div></div>
      <div class="gw-row"><span class="k">运行时长</span><div class="v"><code id="gwUptime">${fmtUptime(
        g.uptimeMs,
      )}</code></div></div>
      <div class="gw-row">
        <span class="k">配置文件</span>
        <div class="v"><code title="${esc(g.configPath)}">${esc(g.configFile)}</code></div>
      </div>
      <div class="gw-row"><span class="k">服务商 / 模型</span><div class="v"><code>${
        g.enabledProviders
      } / ${g.models}</code></div></div>
      <div class="gw-row"><span class="k">版本</span><div class="v"><code>${esc(g.version)}</code></div></div>
      <div class="gw-steps">
        <span class="k">接入 Kimi</span>
        <ol>
          <li>设置 → 通用 → 模型来源 → 第三方模型网关</li>
          <li>Base URL 填 <code>${base}</code>，Token 随便填</li>
          <li>点「测试连接并导入模型」，然后重启 Kimi</li>
        </ol>
      </div>`;

    $('#brandHost').textContent = `127.0.0.1:${g.port}`;
    $('#footVersion').textContent = `v${g.version}`;
    if (!$('#uptimeText').dataset.filled) {
      $('#uptimeText').textContent = fmtUptime(g.uptimeMs);
      $('#uptimeText').dataset.filled = '1';
    }
  }

  function tickUptime() {
    const data = state.data;
    if (!data) return;
    const ms = Date.now() - new Date(data.gateway.startedAt).getTime();
    const label = fmtUptime(ms);
    $('#uptimeText').textContent = label;
    const gw = $('#gwUptime');
    if (gw) gw.textContent = label;
  }

  /* ------------------------------------------------------------------ banner */

  function renderBanner() {
    const data = state.data;
    if (!data) return;
    const pending = data.sync.pending;
    const banner = $('#syncBanner');
    banner.hidden = !pending;
    $('#syncDot').hidden = !pending;
    if (pending) {
      $('#syncBtn').classList.add('primary');
    }
    $('#statusPill').classList.toggle('offline', state.offline);
    $('#statusText').textContent = state.offline ? '已断开' : '运行中';
  }

  function renderFoot() {
    const data = state.data;
    if (!data) return;
    $('#footUpdated').textContent = `数据更新于 ${fmtClock(Date.now())}`;
    $('#chartSub').textContent = state.range === 'hours' ? '最近 24 小时' : '最近 1 小时';
    const series = data.metrics.series[state.range];
    const sum = series.reduce((acc, d) => acc + d.input + d.output, 0);
    $('#chartTotal').textContent = `区间合计 ${fmtTokens(sum)} tokens`;
  }

  /* ------------------------------------------------------- kimi 外接网关 */

  const CHECK_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>';
  const DOT_ICON =
    '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg>';

  function renderKimiGateway() {
    const info = state.data?.kimiGateway;
    const badge = $('#kimiBadge');
    const stepsEl = $('#kimiSteps');
    const enableBtn = $('#kimiEnableBtn');
    const restartBtn = $('#kimiRestartBtn');
    const hint = $('#kimiHint');
    if (!badge || !stepsEl) return;

    // 页面文件是每次现读的，但接口在网关进程里。刚升级完还没重启服务时，
    // 新界面配旧接口 —— 这里明确提示，而不是一直转圈。
    if (!info) {
      if (state.kimiSig === '__stale__') return;
      state.kimiSig = '__stale__';
      badge.textContent = '需重启服务';
      badge.className = 'pill subtle kimi-badge todo';
      stepsEl.innerHTML = `<div class="kimi-step todo">
        <span class="kimi-step-icon">${DOT_ICON}</span>
        <div class="kimi-step-text">
          <strong>网关还在跑旧版本</strong>
          <span>界面已更新，但后台接口是启动时加载的。托盘右键 → 重启服务 后即可使用。</span>
        </div>
      </div>`;
      if (enableBtn) enableBtn.disabled = true;
      if (restartBtn) restartBtn.disabled = true;
      if (hint) hint.textContent = '';
      return;
    }

    const signature = JSON.stringify([info.ready, info.steps, info.kimi.running, info.kimi.pids.length]);
    if (signature === state.kimiSig) return;
    state.kimiSig = signature;

    badge.textContent = info.ready ? '已启用' : '未启用';
    badge.className = `pill subtle kimi-badge ${info.ready ? 'ready' : 'todo'}`;

    stepsEl.innerHTML = info.steps
      .map(
        (step) => `<div class="kimi-step ${step.done ? 'done' : 'todo'}">
          <span class="kimi-step-icon">${step.done ? CHECK_ICON : DOT_ICON}</span>
          <div class="kimi-step-text">
            <strong>${esc(step.label)}</strong>
            <span>${esc(step.detail)}</span>
          </div>
        </div>`,
      )
      .join('');

    if (enableBtn) {
      enableBtn.innerHTML = info.ready
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>恢复隐藏入口`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M13 3 5 13h5l-1 8 8-10h-5l1-8Z"/></svg>为 Kimi 启用外接网关`;
      enableBtn.classList.toggle('primary', !info.ready);
      enableBtn.classList.toggle('ghost', info.ready);
    }

    if (restartBtn) {
      restartBtn.disabled = !info.kimi.running;
      restartBtn.title = info.kimi.running
        ? `当前 ${info.kimi.pids.length} 个 Kimi 进程，重启后生效`
        : 'Kimi 没有在运行';
    }

    if (hint) {
      const parts = [];
      if (info.ready) {
        parts.push('入口已开启。Kimi 设置 → 通用 → 模型来源 里应能看到「第三方模型网关」。');
      } else {
        parts.push('启用会写入 <b>byok-availability.json</b> 并向 hosts 添加 <code>192.168.1.1 dev.msh.team</code>（Kimi 用它判断在内网，不会真的连接）。');
        parts.push('修改 hosts 需要管理员权限，会弹一次 UAC。');
      }
      if (info.ready && !info.kimi.running) parts.push('Kimi 当前没有运行。');
      hint.innerHTML = parts.join(' ');
    }
  }

  function setKimiBusy(busy) {
    ['#kimiEnableBtn', '#kimiRestartBtn'].forEach((sel) => {
      const el = $(sel);
      if (el) el.disabled = busy || (sel === '#kimiRestartBtn' && !state.data?.kimiGateway?.kimi?.running);
    });
  }

  async function toggleKimiGateway(button) {
    const info = state.data?.kimiGateway;
    if (!info) return;
    const action = info.ready ? 'disable' : 'enable';
    setKimiBusy(true);
    button.classList.add('loading');
    try {
      const result = await api(`/api/kimi/gateway/${action}`, { method: 'POST' });
      state.kimiSig = '';
      if (result.status) {
        state.data.kimiGateway = result.status;
      }
      renderKimiGateway();
      if (result.ok) {
        toast(
          action === 'enable' ? '已启用外接网关' : '已恢复隐藏入口',
          result.notes?.join(' · ') || '',
        );
      }
    } catch (err) {
      state.kimiSig = '';
      toast('操作失败', err.message, 'error');
      refresh();
    } finally {
      button.classList.remove('loading');
      setKimiBusy(false);
    }
  }

  function restartKimi(button) {
    confirmDialog({
      title: '重启 Kimi？',
      message: '会关闭当前所有 Kimi 窗口再重新打开，未发送的草稿可能丢失。',
      confirmText: '重启',
      onConfirm: async () => {
        button.classList.add('loading');
        try {
          const result = await api('/api/kimi/restart', { method: 'POST' });
          toast('Kimi 正在重启', result.exe || '');
        } catch (err) {
          toast('重启失败', err.message, 'error');
        } finally {
          button.classList.remove('loading');
        }
      },
    });
  }

  function render() {
    const data = state.data;
    if (!data) return;
    state.offline = false;
    renderKpis();
    drawTraffic();
    renderUsage();
    renderProviders();
    renderModels();
    renderRequests();
    renderGateway();
    renderKimiGateway();
    renderBanner();
    renderFoot();
  }

  function applyState(data) {
    state.data = data;
    if (data) render();
  }

  /* ------------------------------------------------------------------ fetch */

  let refreshing = false;

  async function refresh({ manual = false } = {}) {
    if (refreshing) return;
    refreshing = true;
    try {
      const data = await api('/api/state');
      const wasOffline = state.offline;
      state.data = data;
      state.offline = false;
      render();
      if (wasOffline && manual) toast('已重新连接');
    } catch (err) {
      state.offline = true;
      const pill = $('#statusPill');
      pill.classList.add('offline');
      $('#statusText').textContent = '已断开';
      if (manual) toast('无法连接网关', err.message, 'error');
    } finally {
      refreshing = false;
    }
  }

  /* ------------------------------------------------------------------ modal */

  function showModal(markup) {
    $('#modalRoot').innerHTML = `<div class="modal-backdrop" data-backdrop="1">${markup}</div>`;
    bindSizeFields($('#modalRoot'));
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    $('#modalRoot').innerHTML = '';
    document.body.style.overflow = '';
  }

  function modalShell({ title, subtitle, body, submitText = '保存并应用', extra = '' }) {
    return `<div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div>
          <h3>${esc(title)}</h3>
          ${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
        </div>
        <button class="icon-btn" type="button" data-close="1" aria-label="关闭">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M6 6l12 12M18 6 6 18"/>
          </svg>
        </button>
      </div>
      <form id="modalForm">
        <div class="modal-body">${body}</div>
        <div class="modal-actions">
          <span class="spacer">${extra}</span>
          <button class="btn ghost" type="button" data-close="1">取消</button>
          <button class="btn primary" type="submit">${esc(submitText)}</button>
        </div>
      </form>
    </div>`;
  }

  function wireModal(onSubmit) {
    const backdrop = $('.modal-backdrop');
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop || event.target.closest('[data-close]')) closeModal();
    });
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') closeModal();
      },
      { once: true },
    );
    const form = $('#modalForm');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      button.classList.add('loading');
      try {
        await onSubmit(form);
      } catch (err) {
        toast('操作失败', err.message, 'error');
      } finally {
        button.classList.remove('loading');
      }
    });
  }

  function presetButtons() {
    const presets = PROVIDER_PRESETS.map(
      (preset) =>
        `<button type="button" class="preset" data-preset="${esc(preset.id)}">${esc(preset.name)}</button>`,
    );
    presets.push('<button type="button" class="preset" data-preset="custom">自定义</button>');
    return presets.join('');
  }

  function parseSize(value) {
    const match = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/,/g, '')
      .match(/^([0-9.]+)\s*([km])?$/);
    if (!match) return '';
    const amount = Number(match[1]) * (match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1);
    return Number.isFinite(amount) && amount > 0 ? String(Math.round(amount)) : '';
  }

  function sizeSelect(name, value, sizes) {
    const current = Number(value) || sizes[0][0];
    const standard = sizes.some(([size]) => size === current);
    const options = sizes.map(
      ([size, label]) =>
        `<option value="${size}"${size === current ? ' selected' : ''}>${esc(label)}</option>`,
    );
    options.push(`<option value="custom"${standard ? '' : ' selected'}>自定义…</option>`);
    return `<div class="size-field" data-size-field>
      <select class="select mono" data-size-select>${options.join('')}</select>
      <input class="input mono" data-size-input value="${standard ? '' : current}" placeholder="300k / 1m / 300000" ${
        standard ? 'hidden' : ''
      } />
      <input type="hidden" name="${name}" value="${current}" data-size-value />
    </div>`;
  }

  function bindSizeFields(root) {
    for (const field of root.querySelectorAll('[data-size-field]')) {
      if (field.dataset.sizeBound) continue;
      field.dataset.sizeBound = '1';
      const select = field.querySelector('[data-size-select]');
      const input = field.querySelector('[data-size-input]');
      const hidden = field.querySelector('[data-size-value]');
      const sync = () => {
        if (select.value === 'custom') {
          input.hidden = false;
          const value = parseSize(input.value);
          if (value) hidden.value = value;
        } else {
          input.hidden = true;
          hidden.value = select.value;
        }
      };
      select.addEventListener('change', () => {
        if (select.value === 'custom') {
          input.hidden = false;
          input.value = hidden.value;
          input.focus();
          input.select();
        } else {
          input.hidden = true;
          hidden.value = select.value;
        }
      });
      input.addEventListener('input', sync);
      sync();
    }
  }

  function modelPickerMarkup() {
    return `<div class="model-picker" data-model-picker>
      <div class="model-picker-head">
        <span data-model-status>还没有模型</span>
        <div class="model-picker-tools">
          <button type="button" class="btn ghost small" data-model-all>全选</button>
          <button type="button" class="btn ghost small" data-model-none>清空</button>
        </div>
      </div>
      <input class="input mono model-picker-search" data-model-search placeholder="搜索模型 ID" autocomplete="off" />
      <div class="model-list" data-model-list><div class="model-empty">还没有模型</div></div>
    </div>`;
  }

  function mountModelPicker(root, { existing = [] } = {}) {
    const picker = root.querySelector('[data-model-picker]');
    if (!picker) return null;
    const list = picker.querySelector('[data-model-list]');
    const status = picker.querySelector('[data-model-status]');
    const search = picker.querySelector('[data-model-search]');
    const existingSet = new Set(existing);
    let models = [];
    let selected = new Set();
    let filter = '';

    const visibleModels = () => models.filter((model) => !filter || model.id.toLowerCase().includes(filter));
    const updateStatus = () => {
      const selectable = models.filter((model) => !existingSet.has(model.id));
      status.textContent = models.length
        ? selectable.length
          ? `共 ${models.length} 个，已选 ${selected.size} 个`
          : `共 ${models.length} 个，已全部添加`
        : '还没有模型';
    };
    const render = () => {
      const visible = visibleModels();
      if (!visible.length) {
        list.innerHTML = `<div class="model-empty">${models.length ? '没有匹配的模型' : '还没有模型'}</div>`;
      } else {
        list.innerHTML = visible
          .map((model) => {
            const added = existingSet.has(model.id);
            return `<label class="model-row${added ? ' added' : ''}">
              <input type="checkbox" value="${esc(model.id)}" ${selected.has(model.id) ? 'checked' : ''} ${added ? 'disabled' : ''} />
              <span class="model-id">${esc(model.id)}</span>
              ${added ? '<span class="added">已添加</span>' : ''}
            </label>`;
          })
          .join('');
      }
      updateStatus();
    };

    picker.addEventListener('change', (event) => {
      const input = event.target.closest('input[type="checkbox"]');
      if (!input) return;
      if (input.checked) selected.add(input.value);
      else selected.delete(input.value);
      updateStatus();
    });
    search.addEventListener('input', () => {
      filter = search.value.trim().toLowerCase();
      render();
    });
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.preventDefault();
    });
    picker.querySelector('[data-model-all]').addEventListener('click', () => {
      for (const model of visibleModels()) {
        if (!existingSet.has(model.id)) selected.add(model.id);
      }
      render();
    });
    picker.querySelector('[data-model-none]').addEventListener('click', () => {
      selected = new Set();
      render();
    });

    render();
    return {
      setModels(next) {
        models = (Array.isArray(next) ? next : [])
          .map((item) => (typeof item === 'string' ? { id: item } : item))
          .filter((item) => item && String(item.id || '').trim())
          .map((item) => ({ id: String(item.id).trim() }));
        const ids = new Set(models.map((model) => model.id));
        selected = new Set(Array.from(selected).filter((id) => ids.has(id) && !existingSet.has(id)));
        render();
      },
      getSelected() {
        return Array.from(selected);
      },
    };
  }

  async function fetchUpstreamModels(payload) {
    const result = await api('/api/discover-models', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!result.ok) throw new Error(result.message || '无法获取模型列表');
    return Array.isArray(result.models) ? result.models : [];
  }

  function openProviderModal(provider) {
    const keyHint =
      provider.apiKey.type === 'config'
        ? `config.json：${provider.apiKey.masked}`
        : provider.apiKey.type === 'env'
          ? `环境变量 ${provider.apiKey.envName}：${provider.apiKey.masked}`
          : provider.apiKey.type === 'env-missing'
            ? `未设置 ${provider.apiKey.envName}`
            : '未配置密钥，使用 Kimi Token';

    showModal(
      modalShell({
        title: `编辑 ${provider.name}`,
        subtitle: '密钥只保存在本机 config.json',
        body: `<div class="form-grid">
          <label class="field span-2"><span>显示名称</span><input class="input" name="name" value="${esc(
            provider.name,
          )}" required /></label>
          <label class="field"><span>ID</span><input class="input mono" name="id" value="${esc(provider.id)}" required /></label>
          <label class="field"><span>协议</span>
            <select class="select" name="protocol">
              <option value="chat"${provider.protocol === 'chat' ? ' selected' : ''}>chat（kimi-*）</option>
              <option value="responses"${provider.protocol !== 'chat' ? ' selected' : ''}>responses（gpt-*）</option>
            </select>
          </label>
          <label class="field span-2"><span>Base URL</span><input class="input mono" name="baseUrl" value="${esc(
            provider.baseUrl,
          )}" required /></label>
          <div class="field span-2">
            <span>API Key</span>
            <div class="key-wrap">
              <input class="input mono" name="apiKey" type="password" placeholder="留空则保持现有密钥" autocomplete="off" />
              <button class="eye" type="button" data-eye="1" aria-label="显示密钥">${ICONS.eye}</button>
            </div>
          </div>
          <label class="field span-2"><span>或使用环境变量名（可选）</span><input class="input mono" name="apiKeyEnv" value="${esc(
            provider.apiKey.envName || '',
          )}" placeholder="例如 DEEPSEEK_API_KEY" /></label>
          <div class="hint span-2">${esc(keyHint)}<br />改协议会重写模型 ID 前缀。模型在下方表里编辑，新增模型点「保存并拉模型」。</div>
        </div>`,
        extra: `<button class="btn subtle" type="button" data-save-models="1">保存并拉模型</button><button class="btn subtle danger" type="button" data-clear-key="1">清除密钥</button>`,
      }),
    );

    const form = $('#modalForm');
    let clearKey = false;
    let openModelsAfterSave = false;

    form.querySelector('button[type="submit"]').addEventListener('click', () => {
      openModelsAfterSave = false;
    });
    $('[data-save-models]').addEventListener('click', () => {
      openModelsAfterSave = true;
      form.requestSubmit();
    });
    $('[data-clear-key]').addEventListener('click', (event) => {
      clearKey = true;
      $('input[name="apiKey"]').value = '';
      $('input[name="apiKeyEnv"]').value = '';
      event.currentTarget.textContent = '将清除，保存后生效';
    });

    $('[data-eye]').addEventListener('click', (event) => {
      const input = $('input[name="apiKey"]');
      input.type = input.type === 'password' ? 'text' : 'password';
      event.currentTarget.innerHTML = input.type === 'password' ? ICONS.eye : ICONS.eyeOff;
    });

    wireModal(async (form) => {
      const data = new FormData(form);
      const patch = {
        name: String(data.get('name') || '').trim(),
        id: String(data.get('id') || '').trim(),
        protocol: String(data.get('protocol') || 'responses'),
        baseUrl: String(data.get('baseUrl') || '').trim(),
      };
      const key = String(data.get('apiKey') || '').trim();
      const env = String(data.get('apiKeyEnv') || '').trim();
      if (key) patch.apiKey = key;
      if (env && env !== (provider.apiKey.envName || '')) patch.apiKeyEnv = env;
      if (clearKey && !key && !env) patch.clearKey = true;
      const next = await api(`/api/providers/${encodeURIComponent(provider.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      applyState(next);
      closeModal();
      if (openModelsAfterSave) {
        const clean = (value) =>
          String(value || '')
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '');
        const wanted = clean(patch.id) || clean(patch.name);
        const updated =
          next.providers.find((item) => item.id === wanted) ||
          next.providers.find((item) => item.id === provider.id) ||
          next.providers.find((item) => item.name === patch.name);
        if (updated) {
          toast('已保存', '正在获取模型');
          openImportModelsModal(updated);
          return;
        }
      }
      toast('已保存', `${patch.name || provider.name} 已更新`);
    });
  }

  function openAddProviderModal() {
    showModal(
      modalShell({
        title: '添加服务商',
        subtitle: 'OpenAI 兼容接口',
        body: `<div class="form-grid">
          <div class="preset-row span-2">${presetButtons()}</div>
          <label class="field"><span>名称</span><input class="input" name="name" placeholder="Qwen" required /></label>
          <label class="field"><span>ID</span><input class="input mono" name="id" placeholder="qwen" /></label>
          <label class="field"><span>协议</span>
            <select class="select" name="protocol">
              <option value="chat">chat（kimi-*）</option>
              <option value="responses" selected>responses（gpt-*）</option>
            </select>
          </label>
          <label class="field"><span>Base URL</span><input class="input mono" name="baseUrl" placeholder="https://api.example.com/v1" required /></label>
          <label class="field"><span>API Key</span><input class="input mono" name="apiKey" type="password" placeholder="sk-..." autocomplete="off" /></label>
          <label class="field"><span>环境变量（可选）</span><input class="input mono" name="apiKeyEnv" placeholder="EXAMPLE_API_KEY" /></label>
          <div class="fetch-row span-2">
            <button class="btn subtle" type="button" id="fetchModelsBtn">拉取模型</button>
            <span class="fetch-status" id="fetchStatus">填 Base URL 和 Key 后拉取</span>
          </div>
          <div class="span-2" id="pickerWrap" hidden>${modelPickerMarkup()}</div>
          <label class="field"><span>手动模型 ID（拉不到时用）</span><input class="input mono" name="manualModelId" placeholder="qwen3-max, qwen3-8b" /></label>
          <label class="field"><span>上下文</span>${sizeSelect('contextLength', 131072, CONTEXT_SIZES)}</label>
          <label class="field"><span>输出上限</span>${sizeSelect('maxOutputTokens', 8192, OUTPUT_SIZES)}</label>
          <div class="field span-2">
            <span>默认能力</span>
            <div class="cap-toggles">
              <label class="toggle-check"><input type="checkbox" name="vision" /><span class="box">${ICONS.check}</span>看图</label>
              <label class="toggle-check"><input type="checkbox" name="toolUse" checked /><span class="box">${ICONS.check}</span>工具调用</label>
              <label class="toggle-check"><input type="checkbox" name="reasoning" checked /><span class="box">${ICONS.check}</span>思考模式</label>
            </div>
          </div>
        </div>`,
        submitText: '添加',
      }),
    );

    const form = $('#modalForm');
    const field = (name) => form.elements.namedItem(name);
    const picker = mountModelPicker($('#pickerWrap'), { existing: [] });
    const pickerWrap = $('#pickerWrap');
    const fetchBtn = $('#fetchModelsBtn');
    const status = $('#fetchStatus');
    let presetEffortMap = null;

    form.querySelector('.preset-row').addEventListener('click', (event) => {
      const button = event.target.closest('[data-preset]');
      if (!button) return;
      for (const item of $$('.preset', form)) item.classList.toggle('active', item === button);
      if (button.dataset.preset === 'custom') {
        for (const name of ['name', 'id', 'baseUrl', 'apiKey', 'apiKeyEnv', 'manualModelId']) {
          field(name).value = '';
        }
        presetEffortMap = null;
        picker.setModels([]);
        pickerWrap.hidden = true;
        status.textContent = '填 Base URL 和 Key 后拉取';
        field('name').focus();
        return;
      }
      const preset = PROVIDER_PRESETS.find((item) => item.id === button.dataset.preset);
      if (!preset) return;
      field('name').value = preset.name;
      field('id').value = preset.id;
      field('protocol').value = preset.protocol;
      field('baseUrl').value = preset.baseUrl;
      field('apiKey').value = '';
      field('apiKeyEnv').value = preset.apiKeyEnv || '';
      field('manualModelId').value = '';
      presetEffortMap = preset.effortMap || null;
      picker.setModels([]);
      pickerWrap.hidden = true;
      status.textContent = '填 Base URL 和 Key 后拉取';
      if (preset.id === 'ollama') fetchBtn.focus();
      else field('apiKey').focus();
    });

    field('baseUrl').addEventListener('input', () => {
      if (pickerWrap.hidden) return;
      picker.setModels([]);
      pickerWrap.hidden = true;
      status.textContent = 'Base URL 已修改，重新拉取';
    });

    fetchBtn.addEventListener('click', async () => {
      if (fetchBtn.classList.contains('loading')) return;
      const baseUrl = field('baseUrl').value.trim();
      if (!baseUrl) {
        toast('先填 Base URL');
        field('baseUrl').focus();
        return;
      }
      fetchBtn.classList.add('loading');
      picker.setModels([]);
      pickerWrap.hidden = true;
      status.textContent = '正在拉取…';
      try {
        const models = await fetchUpstreamModels({
          baseUrl,
          apiKey: field('apiKey').value.trim(),
          apiKeyEnv: field('apiKeyEnv').value.trim(),
        });
        if (!document.body.contains(pickerWrap)) return;
        picker.setModels(models);
        pickerWrap.hidden = false;
        status.textContent = models.length ? `获取到 ${models.length} 个` : '没有拉到模型，可手动填';
      } catch (err) {
        status.textContent = err.message;
        toast('获取失败', err.message, 'error');
      } finally {
        fetchBtn.classList.remove('loading');
      }
    });

    wireModal(async (f) => {
      const data = new FormData(f);
      const selected = picker.getSelected();
      const manualIds = String(data.get('manualModelId') || '')
        .split(/[,\n]+/)
        .map((id) => id.trim())
        .filter(Boolean);
      const ids = Array.from(new Set([...selected, ...manualIds]));
      if (ids.length === 0) throw new Error('先拉取并勾选模型，或手动填一个模型 ID');
      const payload = {
        name: String(data.get('name') || '').trim(),
        id: String(data.get('id') || '').trim(),
        protocol: String(data.get('protocol') || 'chat'),
        baseUrl: String(data.get('baseUrl') || '').trim(),
        apiKey: String(data.get('apiKey') || '').trim(),
        apiKeyEnv: String(data.get('apiKeyEnv') || '').trim(),
        models: ids.map((id) => ({ id })),
        contextLength: Number(data.get('contextLength')) || 131072,
        maxOutputTokens: Number(data.get('maxOutputTokens')) || 8192,
        vision: data.get('vision') === 'on',
        toolUse: data.get('toolUse') === 'on',
        reasoning: data.get('reasoning') === 'on',
        ...(presetEffortMap ? { effortMap: presetEffortMap } : {}),
      };
      const next = await api('/api/providers', { method: 'POST', body: JSON.stringify(payload) });
      applyState(next);
      closeModal();
      toast(`已添加 ${ids.length} 个模型`, '同步到 Kimi 后生效');
    });
  }

  function openImportModelsModal(provider) {
    showModal(
      modalShell({
        title: `获取 ${provider.name} 的模型`,
        subtitle: provider.baseUrl,
        body: `<div class="form-grid">
          <label class="field"><span>上下文</span>${sizeSelect('contextLength', 131072, CONTEXT_SIZES)}</label>
          <label class="field"><span>输出上限</span>${sizeSelect('maxOutputTokens', 8192, OUTPUT_SIZES)}</label>
          <div class="field span-2">
            <span>默认能力</span>
            <div class="cap-toggles">
              <label class="toggle-check"><input type="checkbox" name="vision" /><span class="box">${ICONS.check}</span>看图</label>
              <label class="toggle-check"><input type="checkbox" name="toolUse" checked /><span class="box">${ICONS.check}</span>工具调用</label>
              <label class="toggle-check"><input type="checkbox" name="reasoning" checked /><span class="box">${ICONS.check}</span>思考模式</label>
            </div>
          </div>
          <div class="span-2" id="importPicker">${modelPickerMarkup()}</div>
          <label class="field span-2"><span>手动模型 ID（拉不到时用）</span><input class="input mono" name="manualModelId" placeholder="qwen3-max, qwen3-8b" /></label>
        </div>`,
        submitText: '添加选中模型',
        extra: '<button class="btn subtle" type="button" id="reloadModels">重新拉取</button>',
      }),
    );

    const pickerRoot = $('#importPicker');
    const picker = mountModelPicker(pickerRoot, { existing: provider.models.map((model) => model.id) });
    const pickerStatus = pickerRoot.querySelector('[data-model-status]');
    const reload = $('#reloadModels');
    let loading = false;

    const load = async () => {
      if (loading) return;
      loading = true;
      reload.classList.add('loading');
      pickerStatus.textContent = '正在拉取…';
      try {
        const models = await fetchUpstreamModels({ providerId: provider.id });
        if (!document.body.contains(pickerRoot)) return;
        picker.setModels(models);
      } catch (err) {
        pickerStatus.textContent = err.message;
        toast('获取失败', err.message, 'error');
      } finally {
        loading = false;
        reload.classList.remove('loading');
      }
    };

    reload.addEventListener('click', load);
    load();

    wireModal(async (f) => {
      const data = new FormData(f);
      const manualIds = String(data.get('manualModelId') || '')
        .split(/[,\n]+/)
        .map((id) => id.trim())
        .filter(Boolean);
      const ids = Array.from(new Set([...picker.getSelected(), ...manualIds]));
      if (ids.length === 0) throw new Error('先勾选模型，或手动填一个模型 ID');
      const next = await api(`/api/providers/${encodeURIComponent(provider.id)}/models`, {
        method: 'POST',
        body: JSON.stringify({
          models: ids.map((id) => ({ id })),
          defaults: {
            contextLength: Number(data.get('contextLength')) || 131072,
            maxOutputTokens: Number(data.get('maxOutputTokens')) || 8192,
            vision: data.get('vision') === 'on',
            toolUse: data.get('toolUse') === 'on',
            reasoning: data.get('reasoning') === 'on',
          },
        }),
      });
      applyState(next);
      closeModal();
      toast(`已添加 ${ids.length} 个模型`, '同步到 Kimi 后生效');
    });
  }

  function openModelModal(model) {
    showModal(
      modalShell({
        title: `编辑 ${model.displayName}`,
        subtitle: '同步到 Kimi 并重启后生效',
        body: `<div class="form-grid">
          <label class="field span-2"><span>显示名称</span><input class="input" name="displayName" value="${esc(
            model.displayName,
          )}" /></label>
          <label class="field"><span>上游模型 ID</span><input class="input mono" name="id" value="${esc(
            model.id,
          )}" required /></label>
          <div class="field"><span>服务商</span><input class="input" value="${esc(model.providerName)}" disabled /></div>
          <label class="field span-2"><span>Kimi 模型 ID</span><input class="input mono" name="exposedId" value="${esc(
            model.exposedId,
          )}" required /></label>
          <div class="hint span-2">Kimi ID 前缀：<b>${
            model.protocol === 'chat' ? 'kimi-' : 'gpt- / codex-'
          }</b>。修改后需要同步到 Kimi。</div>
          <label class="field"><span>上下文</span>${sizeSelect('contextLength', model.contextLength, CONTEXT_SIZES)}</label>
          <label class="field"><span>输出上限</span>${sizeSelect('maxOutputTokens', model.maxOutputTokens, OUTPUT_SIZES)}</label>
          <div class="field span-2">
            <span>能力</span>
            <div class="cap-toggles">
              <label class="toggle-check"><input type="checkbox" name="vision" ${
                model.vision ? 'checked' : ''
              } /><span class="box">${ICONS.check}</span>看图</label>
              <label class="toggle-check"><input type="checkbox" name="toolUse" ${
                model.toolUse ? 'checked' : ''
              } /><span class="box">${ICONS.check}</span>工具调用</label>
              <label class="toggle-check"><input type="checkbox" name="reasoning" ${
                model.reasoning ? 'checked' : ''
              } /><span class="box">${ICONS.check}</span>思考模式</label>
            </div>
          </div>
          <label class="field"><span>思考强度（逗号分隔）</span><input class="input mono" name="efforts" value="${esc(
            model.efforts.join(', '),
          )}" placeholder="low, high, max" /></label>
          <label class="field"><span>默认思考强度</span><input class="input mono" name="defaultEffort" value="${esc(
            model.defaultEffort,
          )}" placeholder="high" /></label>
        </div>`,
      }),
    );

    wireModal(async (form) => {
      const data = new FormData(form);
      const efforts = String(data.get('efforts') || '')
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const next = await api(`/api/models/${encodeURIComponent(model.exposedId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          id: String(data.get('id') || '').trim(),
          exposedId: String(data.get('exposedId') || '').trim(),
          displayName: String(data.get('displayName') || '').trim(),
          contextLength: Number(data.get('contextLength')) || model.contextLength,
          maxOutputTokens: Number(data.get('maxOutputTokens')) || model.maxOutputTokens,
          vision: data.get('vision') === 'on',
          toolUse: data.get('toolUse') === 'on',
          reasoning: data.get('reasoning') === 'on',
          efforts,
          defaultEffort: String(data.get('defaultEffort') || '').trim(),
        }),
      });
      applyState(next);
      closeModal();
      toast('模型已更新', '同步到 Kimi 后重启生效');
    });
  }

  function confirmDialog({ title, message, confirmText = '确认', onConfirm }) {
    showModal(`<div class="modal" role="dialog" aria-modal="true" style="width:min(420px,100%)">
      <div class="modal-head">
        <div><h3>${esc(title)}</h3><p>${esc(message)}</p></div>
        <button class="icon-btn" type="button" data-close="1" aria-label="关闭">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" type="button" data-close="1">取消</button>
        <button class="btn danger" type="button" id="confirmBtn" style="border-color:color-mix(in srgb,var(--red) 40%,transparent)">${esc(
          confirmText,
        )}</button>
      </div>
    </div>`);
    const backdrop = $('.modal-backdrop');
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop || event.target.closest('[data-close]')) closeModal();
    });
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') closeModal();
      },
      { once: true },
    );
    $('#confirmBtn').addEventListener('click', async (event) => {
      event.currentTarget.classList.add('loading');
      try {
        await onConfirm();
        closeModal();
      } catch (err) {
        event.currentTarget.classList.remove('loading');
        toast('操作失败', err.message, 'error');
      }
    });
  }

  /* ---------------------------------------------------------------- actions */

  function findProvider(id) {
    return state.data?.providers.find((p) => p.id === id);
  }

  async function testProvider(id) {
    const provider = findProvider(id);
    if (!provider) return;
    state.tests[id] = { status: 'running', message: '' };
    renderProviders();
    try {
      const result = await api(`/api/providers/${encodeURIComponent(id)}/test`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      state.tests[id] = {
        status: result.ok ? 'ok' : 'err',
        message: `${fmtMs(result.ms)} · ${result.message}`,
      };
      toast(result.ok ? '连接正常' : '连接失败', `${provider.name} · ${result.message}`, result.ok ? 'ok' : 'error');
    } catch (err) {
      state.tests[id] = { status: 'err', message: err.message };
      toast('测试失败', err.message, 'error');
    }
    renderProviders();
  }

  async function toggleProvider(provider) {
    const next = await api(`/api/providers/${encodeURIComponent(provider.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !provider.enabled }),
    });
    applyState(next);
    toast(provider.enabled ? '已停用' : '已启用', provider.name);
  }

  function deleteProvider(provider) {
    confirmDialog({
      title: `删除 ${provider.name}？`,
      message: '会从 config.json 中移除该服务商及其模型，无法撤销。',
      confirmText: '删除',
      onConfirm: async () => {
        const next = await api(`/api/providers/${encodeURIComponent(provider.id)}`, { method: 'DELETE' });
        applyState(next);
        toast('已删除', provider.name);
      },
    });
  }

  // 同步前确保入口已开启（仅在用户勾了「同步时自动启用」时）。
  // 失败不阻断同步：模型清单照样写回去，入口稍后还能手动开。
  async function ensureKimiGateway() {
    const auto = $('#kimiAutoSync');
    if (!auto || !auto.checked) return null;
    const info = state.data?.kimiGateway;
    if (!info || info.ready) return null;
    try {
      const result = await api('/api/kimi/gateway/enable', { method: 'POST' });
      state.kimiSig = '';
      if (result.status) state.data.kimiGateway = result.status;
      renderKimiGateway();
      return result.ok ? '已自动启用外接网关' : null;
    } catch {
      return null;
    }
  }

  async function runSync(button) {
    if (!button) return;
    button.classList.add('loading');
    try {
      const enabled = await ensureKimiGateway();
      const result = await api('/api/sync', { method: 'POST' });
      applyState(result.state);
      const first = String(result.output || '')
        .split('\n')
        .filter(Boolean)
        .slice(0, 2)
        .join(' · ');
      const detail = [enabled, first].filter(Boolean).join(' · ');
      toast('已同步到 Kimi', detail || '重启 Kimi 后生效');
    } catch (err) {
      toast('同步失败', err.message, 'error');
    } finally {
      button.classList.remove('loading');
    }
  }

  function resetMetrics() {
    confirmDialog({
      title: '重置统计？',
      message: '会清空累计请求、token 与延迟数据，不影响配置。',
      confirmText: '重置',
      onConfirm: async () => {
        const result = await api('/api/metrics/reset', { method: 'POST' });
        applyState(result.state);
        toast('统计已重置');
      },
    });
  }

  document.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action], [data-copy]');
    if (!target) return;
    const action = target.dataset.action;

    if (target.dataset.copy) {
      const ok = await copyText(target.dataset.copy);
      toast(ok ? '已复制' : '复制失败', target.dataset.copy);
      return;
    }

    if (action === 'copy') {
      const text = target.dataset.text;
      const ok = await copyText(text);
      if (ok) {
        target.classList.add('copied');
        setTimeout(() => target.classList.remove('copied'), 900);
        toast('已复制模型 ID', text);
      }
      return;
    }

    if (action === 'add-provider') return openAddProviderModal();

    if (action === 'edit-provider') {
      const provider = findProvider(target.dataset.id);
      if (provider) openProviderModal(provider);
      return;
    }

    if (action === 'import-models') {
      const provider = findProvider(target.dataset.id);
      if (provider) openImportModelsModal(provider);
      return;
    }

    if (action === 'test-provider') return testProvider(target.dataset.id);

    if (action === 'toggle-provider') {
      const provider = findProvider(target.dataset.id);
      if (!provider) return;
      try {
        await toggleProvider(provider);
      } catch (err) {
        toast('操作失败', err.message, 'error');
      }
      return;
    }

    if (action === 'delete-provider') {
      const provider = findProvider(target.dataset.id);
      if (provider) deleteProvider(provider);
      return;
    }

    if (action === 'edit-model') {
      const model = state.data?.models.find((m) => m.exposedId === target.dataset.id);
      if (model) openModelModal(model);
      return;
    }

    if (action === 'sync') return runSync(target);

    if (action === 'reset-metrics') return resetMetrics();

    if (action === 'copy-base') {
      const base = `http://127.0.0.1:${state.data.gateway.port}/v1`;
      const ok = await copyText(base);
      toast(ok ? '已复制 Base URL' : '复制失败', base);
    }
  });

  // ---- Kimi 外接网关 ----
  const kimiAuto = $('#kimiAutoSync');
  if (kimiAuto) {
    kimiAuto.checked = localStorage.getItem('kimi.autoEnable') === '1';
    kimiAuto.addEventListener('change', () => {
      localStorage.setItem('kimi.autoEnable', kimiAuto.checked ? '1' : '0');
      toast(
        kimiAuto.checked ? '已开启自动启用' : '已关闭自动启用',
        kimiAuto.checked ? '点「同步到 Kimi」时会先补齐入口条件' : '',
      );
    });
  }

  const kimiEnable = $('#kimiEnableBtn');
  if (kimiEnable) kimiEnable.addEventListener('click', () => toggleKimiGateway(kimiEnable));

  const kimiRestart = $('#kimiRestartBtn');
  if (kimiRestart) kimiRestart.addEventListener('click', () => restartKimi(kimiRestart));

  $('#themeBtn').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    html.dataset.theme = state.theme;
    localStorage.setItem('bridge.theme', state.theme);
    drawTraffic();
  });

  $('#refreshBtn').addEventListener('click', (event) => {
    const button = event.currentTarget;
    button.classList.add('loading');
    refresh({ manual: true }).finally(() => {
      setTimeout(() => button.classList.remove('loading'), 260);
    });
  });

  $('#syncBtn').addEventListener('click', (event) => runSync(event.currentTarget));

  $('#rangeTabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-range]');
    if (!button) return;
    state.range = button.dataset.range;
    localStorage.setItem('bridge.range', state.range);
    $$('#rangeTabs button').forEach((b) => b.classList.toggle('active', b === button));
    state.hover = null;
    $('#chartTip').hidden = true;
    drawTraffic();
    renderFoot();
  });

  /* ------------------------------------------------------------------- boot */

  const themeParam = new URLSearchParams(location.search).get('theme');
  if (themeParam === 'dark' || themeParam === 'light') {
    state.theme = themeParam;
    html.dataset.theme = themeParam;
  }

  $$('#rangeTabs button').forEach((button) => {
    button.classList.toggle('active', button.dataset.range === state.range);
  });

  bindChart();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 2500);
  setInterval(tickUptime, 1000);
  window.addEventListener('resize', () => drawTraffic());

  refresh({ manual: false });
})();
