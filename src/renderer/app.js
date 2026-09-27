'use strict';

const $ = (id) => document.getElementById(id);
const fmtTime = (ts) => {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
};
const fmtDuration = (sec) => {
  if (!sec && sec !== 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
};

let status = { running: false, base: '', port: 8787 };
let config = {};
let overview = null;
let series = [];
let lastCompleted = null;
let seenKeys = new Set();
let events = [];
let adminSrc = '';
let usage = null;          // 最近一次取到的用量快照
let usagePeriod = 'day';   // day | month | year
let usageError = '';       // 取数失败时的可读原因
let usageFetchedAt = 0;    // 节流用

// ---------------------------------------------------------------------------
// 数据刷新
// ---------------------------------------------------------------------------

async function refreshStatus() {
  status = await window.gw.status();
  $('endpoint').textContent = `${status.host}:${status.port}`;
  $('dot').className = 'dot' + (status.running ? ' on' : status.lastError ? ' err' : '');

  $('btn-start').disabled = status.running;
  $('btn-stop').disabled = !status.running;
  $('btn-restart').disabled = !status.running;

  if (status.running && status.base !== adminSrc) {
    adminSrc = status.base;
    const wv = $('adminview');
    if (wv) wv.src = `${status.base}/admin/`;
  }
}

async function refreshOverview() {
  if (!status.running) return;
  const ov = await window.gw.overview();
  if (!ov) return;
  overview = ov;

  const m = ov.metrics || {};
  const completed = m.completed || 0;

  if (lastCompleted !== null) {
    const delta = Math.max(0, completed - lastCompleted);
    const fresh = [];
    for (const ev of m.recent || []) {
      const key = `${ev.time}-${ev.path}-${ev.status}-${ev.duration_ms}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        fresh.push(ev);
      }
    }
    const avg = fresh.length ? Math.round(fresh.reduce((a, b) => a + b.duration_ms, 0) / fresh.length) : 0;
    series.push({ count: delta, avg, errors: fresh.filter((e) => !e.ok).length });
    if (series.length > 150) series.shift();
    for (const ev of fresh) events.push(ev);
    if (events.length > 1000) events.splice(0, events.length - 1000);
  } else {
    for (const ev of m.recent || []) seenKeys.add(`${ev.time}-${ev.path}-${ev.status}-${ev.duration_ms}`);
  }
  lastCompleted = completed;

  renderKpis(m, ov);
  renderChart();
  renderDist();
  renderAccounts(ov);
  renderRequests(m.recent || []);
  renderCheckin(ov);
  renderRouting(ov);
  renderAccountManager(ov);
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function renderKpis(m, ov) {
  $('kpi-inflight').textContent = m.in_flight ?? 0;
  $('kpi-completed').textContent = m.completed ?? 0;
  $('kpi-success').textContent = m.success_rate == null ? '—' : `${m.success_rate}%`;
  $('kpi-latency').textContent = m.avg_duration_ms == null ? '—' : `${m.avg_duration_ms} ms`;
  $('kpi-uptime').textContent = fmtDuration(ov.uptime);
  const tok = $('kpi-tokens');
  if (tok) {
    tok.textContent = formatCompact(m.total_tokens);
    tok.title = m.unmetered ? `本次运行累计；其中 ${m.unmetered} 笔未取到用量` : '本次运行内累计（重启清零）';
  }

  const rate = m.success_rate;
  const el = $('kpi-success');
  el.style.color = rate == null ? '' : rate >= 95 ? 'var(--green)' : rate >= 80 ? 'var(--amber)' : 'var(--red)';
}

function renderChart() {
  const canvas = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 800;
  const h = 180;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padL = 40, padR = 44, padT = 12, padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  if (!series.length) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('等待请求数据…', padL + 8, padT + plotH / 2);
    return;
  }

  const maxCount = Math.max(1, ...series.map((s) => s.count));
  const maxAvg = Math.max(1, ...series.map((s) => s.avg));
  const n = series.length;
  const slot = plotW / Math.max(n, 60);

  series.forEach((s, i) => {
    const x = padL + i * slot;
    const bh = (s.count / maxCount) * plotH;
    ctx.fillStyle = '#93c5fd';
    ctx.fillRect(x, padT + plotH - bh, Math.max(1.5, slot - 1), bh);
    if (s.errors > 0) {
      const eh = (s.errors / maxCount) * plotH;
      ctx.fillStyle = '#fca5a5';
      ctx.fillRect(x, padT + plotH - eh, Math.max(1.5, slot - 1), eh);
    }
  });

  ctx.beginPath();
  series.forEach((s, i) => {
    const x = padL + i * slot + slot / 2;
    const y = padT + plotH - (s.avg / maxAvg) * plotH;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#94a3b8';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(String(maxCount), 6, padT + 8);
  ctx.fillText('0', 6, padT + plotH);
  ctx.fillStyle = '#2563eb';
  ctx.fillText(`${maxAvg} ms`, w - padR + 4, padT + 8);
}

// ---------------------------------------------------------------------------
// 用量统计（日 / 月 / 年）
// ---------------------------------------------------------------------------

/** 1234 -> "1.2K"、1234567 -> "1.23M"，看板口径的紧凑数字 */
function formatCompact(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) < 1000) return String(Math.round(v * 100) / 100);
  if (Math.abs(v) < 1e6) return `${(v / 1e3).toFixed(v < 1e4 ? 1 : 0)}K`;
  if (Math.abs(v) < 1e9) return `${(v / 1e6).toFixed(2)}M`;
  return `${(v / 1e9).toFixed(2)}B`;
}

const fmtInt = (n) => (Number(n) || 0).toLocaleString('zh-CN');
const fmtCredit = (n) => {
  const v = Number(n) || 0;
  return v >= 100 ? String(Math.round(v)) : String(Math.round(v * 100) / 100);
};

/**
 * 手写「柱 + 折线」图：柱子表示主指标，折线表示次指标（各自独立右侧刻度）。
 * 沿用 renderChart 的视觉语言，不引任何图表库（CSP 只允许本文件）。
 */
function renderBarLine(canvas, { labels, bars, line, barColor, lineColor, emptyText, barFmt = formatCompact, lineFmt = formatCompact, height = 200 }) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 800;
  // 高度必须用固定数值，不能读 canvas.getAttribute('height')：
  // canvas.height = h * dpr 会把该属性改写，下次再读就会拿到放大后的值，
  // 每次重绘都再乘一次 dpr，图表会一路长高。
  const h = height;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  // 显示高度固定为 h 个 CSS 像素。不写死的话，canvas.height 是设备像素，
  // 在高 DPI 屏上会被当成 CSS 高度，图表比预期高一截。
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padL = 52, padR = 52, padT = 14, padB = 26;
  const plotW = Math.max(10, w - padL - padR);
  const plotH = Math.max(10, h - padT - padB);

  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  const hasData = Array.isArray(bars) && bars.some((v) => Number(v) > 0);
  if (!hasData) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(emptyText || '暂无数据', padL + 8, padT + plotH / 2);
    return;
  }

  const n = bars.length;
  const slot = plotW / Math.max(n, 1);
  const maxBar = Math.max(1, ...bars.map((v) => Number(v) || 0));
  const maxLine = Math.max(1, ...(line || []).map((v) => Number(v) || 0));

  bars.forEach((v, i) => {
    const x = padL + i * slot;
    const bh = ((Number(v) || 0) / maxBar) * plotH;
    if (bh > 0) {
      ctx.fillStyle = barColor;
      ctx.fillRect(x + Math.min(1, slot * 0.12), padT + plotH - bh, Math.max(1.5, slot * 0.76), bh);
    }
  });

  if (line && line.length) {
    ctx.beginPath();
    line.forEach((v, i) => {
      const x = padL + i * slot + slot / 2;
      const y = padT + plotH - ((Number(v) || 0) / maxLine) * plotH;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }

  // 左右刻度
  ctx.fillStyle = '#94a3b8';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(barFmt(maxBar), padL - 6, padT + 8);
  ctx.fillText('0', padL - 6, padT + plotH);
  ctx.textAlign = 'left';
  if (line && line.length) ctx.fillText(lineFmt(maxLine), w - padR + 6, padT + 8);

  // 横轴标签：桶多时抽稀，避免糊成一团
  ctx.textAlign = 'center';
  const step = Math.max(1, Math.ceil(n / 12));
  labels.forEach((label, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    ctx.fillText(String(label), padL + i * slot + slot / 2, h - 8);
  });
  ctx.textAlign = 'left';
}

function renderUsage() {
  const box = $('u-tokens');
  if (!box) return;
  const tabs = $('usage-tabs');
  if (tabs) {
    tabs.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.period === usagePeriod));
  }

  const note = $('usage-note');
  const data = usage && usage.period === usagePeriod ? usage : null;
  if (!data) {
    const msg = usageError || (status.running ? '正在读取用量…' : '网关未运行，启动后可查看用量。');
    for (const id of ['u-tokens', 'u-credits', 'u-requests', 'u-unmetered']) $(id).textContent = '—';
    for (const id of ['u-tokens-sub', 'u-credits-sub', 'u-requests-sub']) $(id).textContent = '';
    $('usage-rows').innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(msg)}</td></tr>`;
    $('usage-breakdown').innerHTML = `<div class="empty">${escapeHtml(msg)}</div>`;
    $('usage-range').textContent = '';
    note.textContent = usageError ? usageError : '';
    renderBarLine($('chart-usage-tokens'), { labels: [], bars: [], line: [], barColor: '#93c5fd', lineColor: '#2563eb', emptyText: msg });
    renderBarLine($('chart-usage-credits'), { labels: [], bars: [], line: [], barColor: '#fcd34d', lineColor: '#f59e0b', emptyText: msg });
    return;
  }

  const t = data.totals || {};
  $('u-tokens').textContent = formatCompact(t.total_tokens);
  $('u-credits').textContent = fmtCredit(t.credits_used);
  $('u-requests').textContent = fmtInt((t.api_requests || 0) + (t.test_requests || 0));
  $('u-unmetered').textContent = fmtInt(t.unmetered);
  $('u-tokens-sub').textContent = `输入 ${formatCompact(t.prompt_tokens)} · 输出 ${formatCompact(t.completion_tokens)}`;
  $('u-credits-sub').textContent = t.credits_granted ? `另有获得 ${fmtCredit(t.credits_granted)}` : '按余额采样折算';
  $('u-requests-sub').textContent = `其中连通测试 ${fmtInt(t.test_requests)}`;

  const buckets = data.buckets || [];
  const labels = buckets.map((b) => b.label);
  renderBarLine($('chart-usage-tokens'), {
    labels,
    bars: buckets.map((b) => b.total_tokens),
    line: buckets.map((b) => b.api_requests + b.test_requests),
    barColor: '#93c5fd',
    lineColor: '#2563eb',
    emptyText: '这段时间还没有请求。',
  });

  let running = 0;
  const cumulative = buckets.map((b) => (running += Number(b.credits_used) || 0));
  renderBarLine($('chart-usage-credits'), {
    labels,
    bars: buckets.map((b) => b.credits_used),
    line: cumulative,
    barColor: '#fcd34d',
    lineColor: '#f59e0b',
    barFmt: fmtCredit,
    lineFmt: fmtCredit,
    emptyText: '还没有采到积分消耗（余额查询后才会出现）。',
  });

  const nonEmpty = buckets.filter(
    (b) => b.total_tokens || b.api_requests || b.test_requests || b.credits_used || b.credits_granted,
  );
  $('usage-range').textContent = `${data.timezone} 分桶 · 有数据 ${nonEmpty.length}/${buckets.length} 个周期`;
  $('usage-rows').innerHTML = nonEmpty.length
    ? nonEmpty
        .slice()
        .reverse()
        .map(
          (b) => `<tr>
            <td>${escapeHtml(b.key)}</td>
            <td>${fmtInt(b.api_requests + b.test_requests)}</td>
            <td>${fmtInt(b.prompt_tokens)}</td>
            <td>${fmtInt(b.completion_tokens)}</td>
            <td>${fmtInt(b.total_tokens)}</td>
            <td>${b.credits_used ? fmtCredit(b.credits_used) : '—'}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="6" class="empty">这段时间还没有用量记录。</td></tr>';

  const models = data.models || [];
  const accounts = data.accounts || [];
  const rows = [
    ...models.slice(0, 5).map((m) => ({ label: m.model, value: m.total_tokens, sub: `${fmtInt(m.requests)} 次` })),
    ...accounts.slice(0, 5).map((a) => ({ label: a.name || a.id, value: a.total_tokens, sub: `${fmtInt(a.requests)} 次` })),
  ];
  if (!rows.length) {
    $('usage-breakdown').innerHTML = '<div class="empty">还没有归因数据。用量按「模型 / 账号」分别累计。</div>';
  } else {
    const max = Math.max(...rows.map((r) => r.value), 1);
    $('usage-breakdown').innerHTML = rows
      .map(
        (r) => `<div class="dist-row">
          <span class="dist-label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</span>
          <span class="dist-bar"><span style="width:${(r.value / max) * 100}%"></span></span>
          <span class="dist-count">${formatCompact(r.value)}</span>
        </div>`,
      )
      .join('');
  }

  const cov = data.coverage || {};
  note.textContent =
    `口径：token 来自响应流里的 usage，按北京时间分桶；积分消耗是「定期查询余额做差分」折算出来的` +
    `${cov.credit_note ? `（${cov.credit_note}）` : ''}，签到赠包计入「获得」而不是负消耗。` +
    `账本保留 ${cov.retention_days || 400} 天、跨重启保留；顶部状态页的 KPI 仍是本次运行内的累计。` +
    `客户端提前断开时可能拿不到 usage，这类请求计入「未取到用量」。`;
}

/** 取用量。节流 30 秒，避免和 2 秒一次的状态轮询叠加。 */
async function refreshUsage(force = false) {
  if (!status.running) {
    usageError = '网关未运行，启动后可查看用量。';
    usage = null;
    renderUsage();
    return;
  }
  if (!force && Date.now() - usageFetchedAt < 30000 && usage && usage.period === usagePeriod) {
    renderUsage();
    return;
  }
  try {
    const r = await window.gw.usage(usagePeriod);
    if (r && r.ok) {
      usage = r;
      usageError = '';
    } else {
      usage = null;
      usageError = (r && (r.error || r.detail)) || '读取用量失败';
    }
  } catch (err) {
    usage = null;
    usageError = `读取用量异常：${err.message}`;
  }
  usageFetchedAt = Date.now();
  renderUsage();
}

function renderDist() {
  const box = $('dist');
  if (!events.length) {
    box.innerHTML = '<div class="empty">还没有请求记录。</div>';
    return;
  }
  const byStatus = new Map();
  for (const e of events) {
    const k = e.status == null ? '无响应' : String(e.status);
    byStatus.set(k, (byStatus.get(k) || 0) + 1);
  }
  const rows = [...byStatus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const max = Math.max(...rows.map((r) => r[1]));
  box.innerHTML = rows
    .map(
      ([k, v]) =>
        `<div class="dist-row">
           <span class="dist-label">${k === 'null' || k === '无响应' ? '无响应' : k}</span>
           <span class="dist-bar"><span style="width:${(v / max) * 100}%"></span></span>
           <span class="dist-count">${v}</span>
         </div>`,
    )
    .join('');
}

function renderAccounts(ov) {
  const box = $('accounts');
  const list = ov.accounts || [];
  if (!list.length) {
    box.innerHTML = '<div class="empty">账号池为空。到「账号」页添加，或确认凭据已导入。</div>';
    return;
  }
  box.innerHTML = list
    .map((a) => {
      const state = a.pool_state || a.status || '—';
      const cls = state === 'available' || state === 'ready' ? 'ok' : state === 'invalid' ? 'bad' : 'warn';
      const credits = a.remaining == null ? '积分未知' : `剩余 ${a.remaining}`;
      const checkin = a.today_checked_in ? '今日已签到' : '今日未签到';
      const sub = [a.nickname || a.uid || '', credits, checkin, `请求 ${a.request_count || 0}`].filter(Boolean).join(' · ');
      const badge = a.active ? '<span class="pill ok">当前</span>' : '';
      return `<div class="acct">
                <div>
                  <div class="name">${escapeHtml(a.name || a.id)} ${badge}</div>
                  <div class="sub">${escapeHtml(sub)}</div>
                </div>
                <span class="pill ${cls}">${escapeHtml(String(state))}</span>
              </div>`;
    })
    .join('');
}

function renderCheckin(ov) {
  const list = ov.accounts || [];
  const pool = ov.pool || {};

  const checked = list.filter((a) => a.today_checked_in).length;
  $('ci-today').textContent = list.length ? `${checked}/${list.length}` : '—';

  const known = list.filter((a) => typeof a.remaining === 'number');
  $('ci-credits').textContent = known.length ? String(Math.round(known.reduce((s, a) => s + a.remaining, 0))) : '—';

  const auto = pool.auto_checkin === true;
  const time = pool.checkin_time || '09:00';
  $('ci-auto-state').textContent = auto ? `每日 ${time}` : '已关闭';

  if (document.activeElement !== $('ci-time')) $('ci-time').value = time;
  if (document.activeElement !== $('ci-auto')) $('ci-auto').checked = auto;
}

function renderRequests(recent) {
  const tbody = $('req-rows');
  if (!recent.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无请求</td></tr>';
    return;
  }
  const known = new Set(events.map((e) => `${e.time}-${e.path}-${e.status}-${e.duration_ms}`));
  tbody.innerHTML = recent
    .slice(0, 50)
    .map((e) => {
      const key = `${e.time}-${e.path}-${e.status}-${e.duration_ms}`;
      const ok = e.ok;
      const fresh = !known.has(key);
      return `<tr class="${fresh ? 'fresh' : ''}">
        <td>${fmtTime(e.time)}</td>
        <td><code>${escapeHtml(e.path || '')}</code></td>
        <td>${e.source === 'test' ? '连通测试' : '客户端'}</td>
        <td>${e.status ?? '—'}</td>
        <td>${e.duration_ms} ms</td>
        <td><span class="tag ${ok ? 'ok' : 'bad'}">${escapeHtml(e.outcome || (ok ? 'success' : 'failed'))}</span></td>
      </tr>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// 多账号
// ---------------------------------------------------------------------------

let oauthTimer = null;
let oauthFlow = null;

function renderRouting(ov) {
  const routing = (ov.pool || {}).routing || 'round_robin';
  const manual = routing === 'manual';
  if (document.activeElement !== $('rt-manual') && document.activeElement !== $('rt-round')) {
    $('rt-manual').checked = manual;
    $('rt-round').checked = !manual;
  }
  const current = (ov.accounts || []).find((a) => a.active);
  $('rt-note').textContent = manual
    ? current
      ? `当前只用「${current.name || current.id}」的积分。`
      : '手动模式但未指定账号，请求会失败——请在账号列表点「只用此账号」。'
    : '轮询模式下所有「可用」账号轮流消耗，「当前」标记不生效。';
}

function renderAccountManager(ov) {
  const list = ov.accounts || [];
  const box = $('acct-list');
  const checked = list.filter((a) => a.today_checked_in).length;
  $('acct-summary').textContent = list.length ? `${list.length} 个账号 · 今日已签到 ${checked}` : '';

  if (!list.length) {
    box.innerHTML = '<div class="empty">还没有账号。点「浏览器登录新账号」或「导入登录文件…」添加。</div>';
    return;
  }

  box.innerHTML = list
    .map((a) => {
      const state = a.pool_state || a.status || '—';
      const cls = state === 'available' || state === 'ready' ? 'ok' : state === 'invalid' ? 'bad' : 'warn';
      const credits = a.remaining == null ? '积分未知' : `剩余 ${a.remaining}`;
      const sub = [a.nickname || a.uid || '', credits, a.today_checked_in ? '今日已签到' : '今日未签到', `请求 ${a.request_count || 0}`]
        .filter(Boolean)
        .join(' · ');
      const badge = a.active ? '<span class="pill ok">当前</span>' : '';
      return `<div class="acct acct-row">
                <div class="acct-main">
                  <div class="name">${escapeHtml(a.name || a.id)} ${badge}</div>
                  <div class="sub">${escapeHtml(sub)}</div>
                </div>
                <div class="acct-side">
                  <span class="pill ${cls}">${escapeHtml(String(state))}</span>
                  <span class="acct-btns">
                    <button data-act="use" data-id="${escapeHtml(a.id)}" ${a.active ? 'disabled' : ''}>只用此账号</button>
                    <button class="ghost" data-act="checkin" data-id="${escapeHtml(a.id)}">签到</button>
                    <button class="ghost" data-act="refresh" data-id="${escapeHtml(a.id)}">刷新</button>
                    <button class="ghost" data-act="toggle" data-id="${escapeHtml(a.id)}" data-enabled="${a.enabled ? '1' : '0'}">${a.enabled ? '停用' : '启用'}</button>
                    <button class="ghost danger" data-act="remove" data-id="${escapeHtml(a.id)}">删除</button>
                  </span>
                </div>
              </div>`;
    })
    .join('');
}

function stopOauth() {
  if (oauthTimer) clearInterval(oauthTimer);
  oauthTimer = null;
  oauthFlow = null;
}

async function startOauth() {
  const name = $('acct-name').value.trim();
  $('acct-note').textContent = '正在生成登录链接…';
  const r = await window.gw.oauthStart(name || undefined);
  if (!r.ok) {
    $('acct-note').textContent = `无法开始登录：${r.error || r.detail || '未知错误'}`;
    return;
  }
  oauthFlow = { id: r.id, url: r.url, interval: r.interval || 3 };
  $('oauth-box').hidden = false;
  $('oauth-url').textContent = r.url || '—';
  $('oauth-state').textContent = '等待登录';
  $('acct-note').textContent = '已在默认浏览器打开授权页。';

  stopOauthTimerOnly();
  oauthTimer = setInterval(pollOauth, Math.max(1000, (oauthFlow.interval || 3) * 1000));
}

function stopOauthTimerOnly() {
  if (oauthTimer) clearInterval(oauthTimer);
  oauthTimer = null;
}

async function pollOauth() {
  if (!oauthFlow) return stopOauth();
  const r = await window.gw.oauthPoll(oauthFlow.id);
  if (!r.ok) {
    stopOauth();
    $('oauth-state').textContent = '失败';
    $('acct-note').textContent = `登录失败：${r.error || r.detail || '未知错误'}`;
    return;
  }
  if (r.status === 'success') {
    stopOauth();
    $('oauth-box').hidden = true;
    $('acct-note').textContent = `已添加账号「${r.name || r.id || '新账号'}」。`;
    $('acct-name').value = '';
    await refreshOverview();
    return;
  }
  if (r.status === 'expired') {
    stopOauth();
    $('oauth-state').textContent = '已过期';
    $('acct-note').textContent = '登录链接已过期（5 分钟），请重新点击登录。';
    return;
  }
  $('oauth-state').textContent = '等待登录…';
}

async function cancelOauth() {
  if (oauthFlow) await window.gw.oauthCancel(oauthFlow.id);
  stopOauth();
  $('oauth-box').hidden = true;
  $('acct-note').textContent = '已取消登录。';
}

async function importCredential() {
  $('acct-note').textContent = '选择文件…';
  const picked = await window.gw.pickCredential();
  if (!picked) {
    $('acct-note').textContent = '';
    return;
  }
  if (!picked.ok) {
    $('acct-note').textContent = picked.error || '文件解析失败';
    return;
  }
  const r = await window.gw.addAccount({
    credential: picked.credential,
    name: $('acct-name').value.trim() || undefined,
  });
  $('acct-note').textContent = r.ok
    ? `已导入账号（${r.id}）。`
    : `导入失败：${r.error || r.detail || '请确认文件是桌面端导出的 .info 登录文件'}`;
  if (r.ok) {
    $('acct-name').value = '';
    await refreshOverview();
  }
}

async function onAccountAction(act, id, btn) {
  if (act === 'remove') {
    if (!confirm('删除后该账号的凭据会移入回收目录，确定删除？')) return;
    const r = await window.gw.removeAccount(id);
    $('acct-note').textContent = r.ok ? '已删除。' : `删除失败：${r.error || r.detail || ''}`;
  } else if (act === 'toggle') {
    const enabled = btn.dataset.enabled === '1';
    const r = await window.gw.updateAccount({ id, patch: { enabled: !enabled } });
    $('acct-note').textContent = r.ok ? (enabled ? '已停用。' : '已启用。') : `操作失败：${r.error || r.detail || ''}`;
  } else if (act === 'use') {
    const r = await window.gw.useAccount(id);
    $('acct-note').textContent = r.ok
      ? '已切换为手动模式，后续请求只消耗该账号积分。'
      : `切换失败：${r.error || r.detail || ''}`;
  } else if (act === 'checkin' || act === 'refresh') {
    const r = await window.gw.accountAction({ id, action: act });
    const label = act === 'checkin' ? '签到' : '刷新';
    $('acct-note').textContent = r.ok
      ? `${label}完成：${r.message || '成功'}`
      : `${label}失败：${r.error || r.detail || ''}`;
  }
  await refreshOverview();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------

const pageNames = {
  status: '实时状态',
  usage: '用量统计',
  accounts: '账号',
  admin: '管理后台',
  settings: '设置',
  logs: '运行日志',
};

function switchView(name) {
  document.querySelectorAll('.nav-item').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $('page-title').textContent = pageNames[name] || 'WorkBuddy 中转网关';
  if (name === 'logs') refreshLogs();
  if (name === 'settings') refreshConfig();
  if (name === 'usage') refreshUsage(true);
}

async function refreshLogs() {
  const lines = await window.gw.logs();
  $('console').textContent = lines.map((l) => `[${new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false })}] ${l.text}`).join('\n') || '（暂无输出）';
}

async function refreshConfig() {
  config = await window.gw.config();
  $('cfg-project').value = config.projectDir || '';
  $('cfg-port').value = config.port || 8787;
  $('cfg-clientkey').value = config.clientKey || '';
  $('cfg-autostart').checked = Boolean(config.autostart);
  $('admin-key').textContent = config.adminKey || '—';
}

function bind() {
  document.querySelectorAll('.nav-item').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

  $('btn-start').addEventListener('click', async () => {
    await window.gw.start();
    await refreshStatus();
  });
  $('btn-stop').addEventListener('click', async () => {
    await window.gw.stop();
    await refreshStatus();
  });
  $('btn-restart').addEventListener('click', async () => {
    await window.gw.restart();
    lastCompleted = null;
    series = [];
    await refreshStatus();
  });
  $('copy-ep').addEventListener('click', () => navigator.clipboard.writeText(`${status.base}/v1`));
  $('btn-refresh-logs').addEventListener('click', refreshLogs);

  $('btn-checkin').addEventListener('click', async () => {
    const btn = $('btn-checkin');
    btn.disabled = true;
    btn.textContent = '签到中…';
    $('ci-note').textContent = '';
    try {
      const r = await window.gw.checkin();
      if (!r.ok) {
        $('ci-note').textContent = `签到失败：${r.error || r.detail || '未知错误'}`;
        return;
      }
      const results = r.results || [];
      const okCount = results.filter((x) => x.ok).length;
      $('ci-note').textContent =
        `签到完成：成功 ${okCount}/${results.length}` +
        (results.length ? ` — ${results.map((x) => `${x.id}: ${x.message}`).join('；')}` : '');
      await refreshOverview();
    } catch (err) {
      $('ci-note').textContent = `签到异常：${err.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = '立即签到';
    }
  });

  $('btn-ci-save').addEventListener('click', async () => {
    const patch = {
      auto_checkin: $('ci-auto').checked,
      checkin_time: $('ci-time').value || '09:00',
    };
    try {
      const r = await window.gw.poolSettings(patch);
      $('ci-note').textContent = r.ok
        ? `已保存：自动签到${patch.auto_checkin ? '开启' : '关闭'}，每日 ${patch.checkin_time}（北京时间）`
        : `保存失败：${r.error || r.detail || '未知错误'}`;
      if (r.ok) await refreshOverview();
    } catch (err) {
      $('ci-note').textContent = `保存异常：${err.message}`;
    }
  });

  if (window.gw.onCheckinResult) {
    window.gw.onCheckinResult((r) => {
      const results = r.results || [];
      const okCount = results.filter((x) => x.ok).length;
      $('ci-note').textContent = r.ok
        ? `签到完成：成功 ${okCount}/${results.length}`
        : `签到失败：${r.error || '未知错误'}`;
      refreshOverview();
    });
  }

  $('btn-oauth').addEventListener('click', startOauth);
  $('btn-oauth-cancel').addEventListener('click', cancelOauth);
  $('btn-import').addEventListener('click', importCredential);
  $('btn-checkin-all2').addEventListener('click', async () => {
    $('acct-note').textContent = '签到中…';
    const r = await window.gw.checkin();
    const results = r.results || [];
    const okCount = results.filter((x) => x.ok).length;
    $('acct-note').textContent = r.ok
      ? `签到完成：成功 ${okCount}/${results.length}${results.length ? ` — ${results.map((x) => `${x.id}: ${x.message}`).join('；')}` : ''}`
      : `签到失败：${r.error || r.detail || '未知错误'}`;
    await refreshOverview();
  });

  for (const el of [$('rt-manual'), $('rt-round')]) {
    el.addEventListener('change', async () => {
      if (!el.checked) return;
      const r = await window.gw.poolSettings({ routing: el.value });
      $('rt-note').textContent = r.ok
        ? `已保存：${el.value === 'manual' ? '手动指定' : '轮询分摊'}`
        : `保存失败：${r.error || r.detail || ''}`;
      if (r.ok) await refreshOverview();
    });
  }

  $('acct-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn || btn.disabled) return;
    await onAccountAction(btn.dataset.act, btn.dataset.id, btn);
  });

  $('usage-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn || btn.dataset.period === usagePeriod) return;
    usagePeriod = btn.dataset.period;
    refreshUsage(true);
  });

  $('btn-pick').addEventListener('click', async () => {
    const p = await window.gw.pickProject();
    if (p) $('cfg-project').value = p;
  });
  $('btn-open-data').addEventListener('click', () => window.gw.openDir(status.dataDir));
  $('btn-save').addEventListener('click', async () => {
    await window.gw.saveConfig({
      projectDir: $('cfg-project').value.trim(),
      port: Number($('cfg-port').value) || 8787,
      clientKey: $('cfg-clientkey').value.trim(),
      startMinimized: false,
    });
    $('save-note').textContent = '已保存，正在重启网关…';
    await window.gw.restart();
    lastCompleted = null;
    series = [];
    await refreshStatus();
    $('save-note').textContent = '已保存并重启。';
  });

  $('btn-new-key').addEventListener('click', async () => {
    const btn = $('btn-new-key');
    btn.disabled = true;
    btn.textContent = '生成中…';
    const r = await window.gw.createKey();
    btn.disabled = false;
    btn.textContent = '生成新密钥';
    if (r && r.ok) {
      $('cfg-clientkey').value = r.key;
      $('save-note').textContent = '已生成新密钥，请复制给客户端使用。';
    } else {
      $('save-note').textContent = `生成失败：${(r && r.error) || '未知错误'}`;
    }
  });

  $('btn-copy-key').addEventListener('click', async () => {
    const v = $('cfg-clientkey').value.trim();
    if (!v) return;
    await navigator.clipboard.writeText(v);
    $('save-note').textContent = '已复制到剪贴板。';
  });

  window.gw.onStatus((s) => {
    status = s;
    refreshStatus();
  });

  window.addEventListener('resize', () => {
    renderChart();
    renderUsage();
  });
}

(async function boot() {
  bind();
  await refreshStatus();
  await refreshOverview();
  setInterval(async () => {
    await refreshStatus();
    await refreshOverview();
    // 只有停在这一页时才刷新用量，且内部还有 30 秒节流。
    if (document.querySelector('.nav-item.active')?.dataset.view === 'usage') await refreshUsage();
  }, 2000);
})();
