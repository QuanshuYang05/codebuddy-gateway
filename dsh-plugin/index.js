/**
 * Host 半：网关的数据桥 + 生命周期控制。
 *
 * 两个职责：
 *  1. 取数。浏览器直连网关会被 CORS 拦掉（FastAPI 不发 CORS 头），
 *     所以由 Node 侧代取，再用 ctx.webServer 注册同源路由给 Client 半。
 *  2. 控制。内核本来就是个普通 Python 进程（Electron 只是它的启动器），
 *     所以这里可以直接 spawn / kill 它，从而不再需要那个 Electron 桌面窗口。
 *
 * 安全边界：控制接口只做三件事 —— 启动、停止、重启，且只操作本机回环上的
 * 那一个内核。不接受任意路径、任意命令。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 插件自己的目录（payload 就在这里），与 profile 的 cwd 无关 */
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

const ROUTE = '/codebuddy-gateway/status';
const CONTROL_ROUTE = '/codebuddy-gateway/control';
const ACTION_ROUTE = '/codebuddy-gateway/action';
const DIAGNOSE_ROUTE = '/codebuddy-gateway/diagnose';
const TIMEOUT_MS = 6000;
const CACHE_MS = 1500;
const PERIODS = new Set(['day', 'month', 'year']);
const DEFAULT_PORT = 8787;
const MAX_BODY = 64 * 1024; // 账号操作请求体都很小，限制一下避免被灌爆

/** CodeBuddy 桌面端写凭据的地方（内核启动时从这里复制一份过去） */
function codebuddyAuthDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(xdg, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
}

/**
 * 无 BOM 的 UTF-8 写入。
 *
 * 这一点是被实测逼出来的：内核的 launcher.py 用 json.load 读 keys.json，
 * 带 BOM 会解析失败，而它的 except 会**静默回退成空值**，最后报成
 * 「ADMIN_KEY must contain at least 20 characters」—— 错误信息完全指向别处。
 * PowerShell 的 Set-Content -Encoding utf8 默认就带 BOM，很容易踩。
 */
function writeJsonNoBom(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf8' });
}

/**
 * 首次运行的自动初始化。
 *
 * 让"只装了 WorkBuddy 并登录"的用户也能一键跑起来。要补三样东西，
 * 这三样在纯插件环境里都没人替他做（桌面版是 Electron 那边做的）：
 *
 *   1. keys.json       —— 内核强制要求 admin key ≥20 字符，且不会自动生成
 *   2. 客户端 API Key  —— /v1/* 强制校验，缺了一律 401
 *   3. auth/*.info     —— 从 CodeBuddy 桌面端复制过来（内核只读，不写那边）
 *
 * 全部幂等：已有的不动。
 */
function ensureInitialized() {
  const dir = dataRoot();
  const created = [];
  const notes = [];

  // 1) 管理密钥
  const keyFile = path.join(dir, 'keys.json');
  let keys = readJson(keyFile);
  if (!keys || !keys.adminKey || keys.adminKey.length < 20) {
    keys = { adminKey: crypto.randomBytes(30).toString('base64url').slice(0, 40) };
    writeJsonNoBom(keyFile, keys);
    created.push('管理密钥');
  }

  // 2) 桌面版配置（补一份最小可用的，内核只需要 host/port）
  const desktopFile = path.join(dir, 'desktop.json');
  let desktop = readJson(desktopFile);
  if (!desktop || !desktop.port) {
    desktop = { host: '127.0.0.1', port: DEFAULT_PORT, ...(desktop || {}) };
    writeJsonNoBom(desktopFile, desktop);
    created.push('网关配置');
  }

  // 3) 凭据：从 CodeBuddy 桌面端导入到内核自己的目录（不写回那边）
  const ownAuth = path.join(dir, 'gateway-data', 'auth');
  fs.mkdirSync(ownAuth, { recursive: true });
  const havePlain = (() => {
    try {
      return fs.readdirSync(ownAuth).some((n) => {
        if (!n.endsWith('.info')) return false;
        const doc = readJson(path.join(ownAuth, n));
        const t = doc && doc.auth && doc.auth.accessToken;
        return typeof t === 'string' && t;
      });
    } catch { return false; }
  })();

  if (!havePlain) {
    const src = codebuddyAuthDir();
    let copied = 0;
    let skippedEncrypted = 0;
    try {
      for (const n of fs.readdirSync(src)) {
        if (!n.endsWith('.info')) continue;
        const doc = readJson(path.join(src, n));
        const t = doc && doc.auth && doc.auth.accessToken;
        // 只复制明文：加密的复制过去内核也用不了，反而让体检更难看懂
        if (typeof t !== 'string' || !t) {
          if (t) skippedEncrypted++;
          continue;
        }
        const dst = path.join(ownAuth, n);
        if (!fs.existsSync(dst)) {
          fs.copyFileSync(path.join(src, n), dst);
          copied++;
        }
      }
    } catch { /* 目录不存在 = 用户没登录过 */ }
    if (copied) created.push(`凭据 ×${copied}`);
    if (skippedEncrypted) {
      notes.push(
        `跳过了 ${skippedEncrypted} 份加密凭据（内核只认明文）。`
        + '若账号没出现，请改用同目录下带时间戳的备份文件，或走「浏览器授权登录」。',
      );
    }
  }

  return { dir, keys, desktop, created, notes };
}

/** 确保内核里至少有一把可用的客户端 API Key（/v1/* 强制校验） */
async function ensureClientKey(session, cfg) {
  try {
    const ov = await session.get('/admin/api/overview');
    if ((ov.keys || []).length > 0) return { ok: true, existed: true };
    const r = await session.mutate('POST', '/admin/api/keys', { name: 'DSH 面板' });
    if (!r.ok) return { ok: false, error: r.error };
    const key = r.data?.key;
    if (key) {
      const desktopFile = path.join(dataRoot(), 'desktop.json');
      const desktop = readJson(desktopFile) || {};
      desktop.clientKey = key;
      writeJsonNoBom(desktopFile, desktop);
    }
    return { ok: true, created: true, key };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

/**
 * 逐项体检。
 *
 * 每一项都回：有没有、在哪、缺了怎么办。目的是让别人装上后遇到问题时
 * 能自己看出差在哪，而不是对着一句"连不上"猜。
 *
 * 注意凭据那一项：新版桌面端会把 accessToken 加密存成对象
 * （{$wbEncrypted:1, envelope:"..."}），内核只认明文。同一个目录里
 * 往往既有加密的也有带时间戳的明文备份，所以这里要逐个文件判断，
 * 而不是只看"目录里有文件"。
 */
function diagnose() {
  const items = [];
  const dataDir = dataRoot();

  // 1) 运行时
  const rt = findRuntime();
  items.push({
    id: 'runtime',
    label: 'Python 运行时与内核',
    ok: rt.found,
    detail: rt.found
      ? `${rt.bundled ? '插件自带' : '使用本机已装'} · ${rt.root}`
      : '没有找到',
    fix: rt.found
      ? ''
      : '插件自带的 payload 不完整，且本机也没有已安装的「WorkBuddy 中转网关」。'
        + '请在 %APPDATA%\\codebuddy-gateway\\panel-runtime.json 里指定 '
        + '{"root":"<安装目录>"}，或重新安装本插件。',
    searched: rt.found ? [] : (rt.searched || []).slice(0, 8),
  });

  // 2) 管理密钥
  const keys = readJson(path.join(dataDir, 'keys.json'));
  const hasKey = Boolean(keys && keys.adminKey && keys.adminKey.length >= 20);
  items.push({
    id: 'adminkey',
    label: '管理密钥',
    ok: hasKey,
    detail: hasKey ? path.join(dataDir, 'keys.json') : '缺失或过短',
    fix: hasKey ? '' : '启动一次网关桌面版会自动生成；或手动创建 keys.json，内容 {"adminKey":"<至少20位>"}。',
  });

  // 3) 客户端 Key（/v1/* 强制校验，缺了客户端会 401）
  const desktop = readJson(path.join(dataDir, 'desktop.json'));
  const clientKey = desktop?.clientKey || '';
  items.push({
    id: 'clientkey',
    label: '客户端 API Key',
    ok: Boolean(clientKey),
    detail: clientKey ? `${clientKey.slice(0, 8)}…` : '未设置',
    fix: clientKey
      ? ''
      : '在桌面版设置页里复制「客户端 Key」，或在管理后台创建一枚。'
        + '缺了它 /v1/* 会返回 401。',
  });

  // 4) 凭据（逐个文件判断明文/加密）
  const authDirs = [path.join(dataDir, 'gateway-data', 'auth'), codebuddyAuthDir()];
  const plain = [];
  const encrypted = [];
  const scanned = [];
  for (const dir of authDirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.info'));
    } catch { /* 目录不存在 */ }
    let plainHere = 0;
    let encHere = 0;
    for (const n of names) {
      const doc = readJson(path.join(dir, n));
      const t = doc && doc.auth && doc.auth.accessToken;
      if (typeof t === 'string' && t) { plain.push({ dir, name: n }); plainHere++; }
      else if (t) { encrypted.push({ dir, name: n }); encHere++; }
    }
    scanned.push({ dir, exists: names.length > 0, count: names.length, plain: plainHere, encrypted: encHere });
  }
  const hasPlain = plain.length > 0;
  // 详情里点名可用凭据在哪个目录 —— 同一个文件名在两个目录里可能一个明文一个加密
  const plainDirs = [...new Set(plain.map((p) => p.dir))];
  items.push({
    id: 'credential',
    label: 'CodeBuddy 凭据',
    ok: hasPlain,
    detail: hasPlain
      ? `${plain.length} 份可用（明文）· 位置 ${plainDirs.join(' ; ')}`
        + (encrypted.length ? ` · 另有 ${encrypted.length} 份加密不可用` : '')
      : (encrypted.length ? `${encrypted.length} 份，但全是加密格式` : '没有找到'),
    fix: hasPlain
      ? ''
      : '先在本机登录 CodeBuddy 桌面端。若只有加密文件，改用同目录下带时间戳的备份'
        + '（形如 workbuddy-desktop.2026-09-20T....info，里面是明文），'
        + '或在管理后台走「浏览器授权登录」添加账号。',
    scanned,
  });

  // 5) 端口
  const endpoint = `http://${desktop?.host || '127.0.0.1'}:${Number(desktop?.port) || DEFAULT_PORT}`;
  items.push({
    id: 'config',
    label: '网关配置',
    ok: Boolean(desktop),
    detail: desktop ? endpoint : `缺 ${path.join(dataDir, 'desktop.json')}`,
    fix: desktop ? '' : '启动一次网关桌面版即可生成 desktop.json。',
  });

  const failed = items.filter((i) => !i.ok);
  return {
    ok: failed.length === 0,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    dataDir,
    items,
    summary: failed.length === 0
      ? '依赖齐全。'
      : `${failed.length} 项需要处理：${failed.map((i) => i.label).join('、')}`,
  };
}

/** 读请求体，带大小上限 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 桌面版的数据目录（配置、密钥、内核业务数据都在这里） */
function dataRoot() {
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(base, 'codebuddy-gateway');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadDesktopConfig() {
  const dir = dataRoot();
  return {
    desktop: readJson(path.join(dir, 'desktop.json')),
    keys: readJson(path.join(dir, 'keys.json')),
    dir,
  };
}

/**
 * 插件自带的运行时（随包分发的那一份）。
 *
 * 这是"装完即用"的关键：用户机器上只有 WorkBuddy + 登录态，
 * 没有 Python、没有内核、没有网关。插件自己带齐这三样。
 *
 * 布局：
 *   <插件目录>/payload/python/        ← 可重定位的 Python（python.exe 与 python3xx.dll 同级）
 *   <插件目录>/payload/kernel/        ← 内核源码
 *   <插件目录>/payload/launcher.py
 */
function bundledRuntime() {
  const root = path.join(PLUGIN_DIR, 'payload');
  const python = [
    path.join(root, 'python', 'python.exe'),
    path.join(root, 'python', 'bin', 'python3'),
  ].find((p) => fs.existsSync(p));
  const launcher = path.join(root, 'launcher.py');
  const kernel = path.join(root, 'kernel');
  if (python && fs.existsSync(launcher) && fs.existsSync(path.join(kernel, 'core', 'converter.py'))) {
    return { root, python, launcher, kernel, found: true, bundled: true };
  }
  return { found: false };
}

/**
 * 找到可用的网关运行时。
 *
 * 顺序：**自带 payload → 用户显式指定 → 上次用过的 → 桌面版配置 → 常见安装位**。
 * 自带的那份放最前，因为它一定和当前插件版本匹配；用户已装的桌面版放后面兜底。
 * 一个候选要同时具备 python、launcher.py 和 kernel 才算数。
 */
function findRuntime() {
  const bundled = bundledRuntime();
  if (bundled.found) return bundled;

  const { desktop, dir } = loadDesktopConfig();
  const saved = readJson(path.join(dir, 'panel-runtime.json')) || {};

  const candidates = [];
  if (saved.root) candidates.push(saved.root);
  if (process.env.CODEBUDDY_GATEWAY_ROOT) candidates.push(process.env.CODEBUDDY_GATEWAY_ROOT);

  // 桌面版 desktop.json 里记的 projectDir 是内核目录，回溯两级即安装根
  if (desktop?.projectDir) {
    candidates.push(path.resolve(desktop.projectDir, '..', '..'));
  }

  // 常见安装位置
  const home = os.homedir();
  for (const base of [
    'D:\\code_gateway\\codebuddy-gateway',
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'WorkBuddy 中转网关'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WorkBuddy 中转网关'),
    path.join(home, 'codebuddy-gateway'),
  ]) {
    candidates.push(base);
  }

  // 也扫一下本仓库的 release 产物
  for (const repo of ['D:\\Code\\codebuddy_gateway', 'D:\\code_gateway\\codebuddy-gateway']) {
    try {
      for (const name of fs.readdirSync(repo)) {
        if (/^release/i.test(name)) {
          candidates.push(path.join(repo, name, 'win-unpacked', 'resources'));
          candidates.push(path.join(repo, name, 'resources'));
        }
      }
    } catch { /* 目录不存在就算了 */ }
  }

  const seen = new Set();
  for (const raw of candidates) {
    if (!raw) continue;
    const root = path.resolve(raw);
    if (seen.has(root)) continue;
    seen.add(root);

    const python = [
      path.join(root, 'python', 'python.exe'),
      path.join(root, 'resources', 'python', 'python.exe'),
      path.join(root, 'python', 'bin', 'python3'),
    ].find((p) => fs.existsSync(p));
    const launcher = [
      path.join(root, 'launcher.py'),
      path.join(root, 'resources', 'launcher.py'),
    ].find((p) => fs.existsSync(p));
    const kernel = [
      path.join(root, 'kernel'),
      path.join(root, 'resources', 'kernel'),
    ].find((p) => fs.existsSync(path.join(p, 'core', 'converter.py')));

    if (python && launcher && kernel) {
      return { root, python, launcher, kernel, found: true, bundled: false };
    }
  }
  return { found: false, searched: [...seen] };
}

function rememberRuntime(root) {
  try {
    fs.mkdirSync(dataRoot(), { recursive: true });
    fs.writeFileSync(
      path.join(dataRoot(), 'panel-runtime.json'),
      JSON.stringify({ root }, null, 2),
      'utf8',
    );
  } catch { /* 记不住也不影响本次运行 */ }
}

/** 带超时的 JSON 请求 */
async function request(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 400);
    }
    return { status: res.status, headers: res.headers, body };
  } finally {
    clearTimeout(timer);
  }
}

/** 管理端会话：cookie + csrf */
function createSession(cfg) {
  let cookie = '';
  let csrf = '';
  const base = `http://${cfg.host}:${cfg.port}`;

  async function login() {
    const res = await request(`${base}/admin/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: cfg.adminKey }),
    });
    if (res.status !== 200) throw new Error(`管理端登录失败 HTTP ${res.status}`);
    const setCookie = res.headers.getSetCookie?.() || [];
    const raw = setCookie.find((c) => c.startsWith('workbuddy_admin='));
    if (!raw) throw new Error('登录成功但没拿到会话 cookie');
    cookie = raw.split(';')[0];
    csrf = (res.body && res.body.csrf) || '';
  }

  async function get(pathname) {
    if (!cookie) await login();
    const send = () =>
      request(`${base}${pathname}`, { headers: { Cookie: cookie, 'X-CSRF-Token': csrf } });
    let res = await send();
    if (res.status === 401 || res.status === 403) {
      await login();
      res = await send();
    }
    if (res.status !== 200) throw new Error(`网关读取失败 HTTP ${res.status}`);
    return res.body;
  }

  /**
   * 写请求。内核对非 GET 强制校验 X-CSRF-Token（缺失会 403），
   * 所以这里必须带上 csrf；会话过期同样重登一次。
   * 不抛异常：把内核的报错原文交回调用方，界面上能直接显示。
   */
  async function mutate(method, pathname, body) {
    if (!cookie) await login();
    const send = () =>
      request(`${base}${pathname}`, {
        method,
        headers: {
          Cookie: cookie,
          'X-CSRF-Token': csrf,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    let res = await send();
    if (res.status === 401 || res.status === 403) {
      await login();
      res = await send();
    }
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, data: res.body };
    }
    const detail =
      res.body && typeof res.body === 'object'
        ? res.body.detail || res.body.error || JSON.stringify(res.body)
        : String(res.body || '');
    return { ok: false, status: res.status, error: detail || `HTTP ${res.status}` };
  }

  return { get, mutate, reset: () => { cookie = ''; csrf = ''; } };
}

/** 只取面板要用的字段，剥离 last_error / token_refreshed / uid 等内部细节 */
function shapeOverview(ov) {
  const m = ov.metrics || {};
  return {
    uptime: ov.uptime ?? null,
    kpi: {
      inFlight: m.in_flight ?? 0,
      completed: m.completed ?? 0,
      successRate: m.success_rate ?? null,
      avgDurationMs: m.avg_duration_ms ?? null,
      totalTokens: m.total_tokens ?? 0,
      unmetered: m.unmetered ?? 0,
    },
    accounts: (ov.accounts || []).map((a) => ({
      id: a.id,
      name: a.nickname || a.name || a.id,
      enabled: !!a.enabled,
      active: !!a.active,
      status: a.status || '',
      poolState: a.pool_state || '',
      remaining: typeof a.remaining === 'number' ? a.remaining : null,
      todayCheckedIn: !!a.today_checked_in,
      expired: !!a.expired,
      requestCount: a.request_count ?? 0,
    })),
    pool: {
      routing: ov.pool?.routing || '',
      autoCheckin: !!ov.pool?.auto_checkin,
      checkinTime: ov.pool?.checkin_time || '',
    },
    keyCount: (ov.keys || []).length,
    modelCount: (ov.models || []).length,
    recent: (m.recent || []).slice(0, 12).map((e) => ({
      time: e.time,
      path: e.path,
      status: e.status,
      ok: !!e.ok,
      durationMs: e.duration_ms,
    })),
  };
}

function shapeUsage(u) {
  return {
    period: u.period,
    buckets: (u.buckets || []).map((b) => ({
      label: b.label,
      totalTokens: b.total_tokens ?? 0,
      creditsUsed: b.credits_used ?? 0,
      requests: b.api_requests ?? 0,
    })),
    totals: {
      totalTokens: u.totals?.total_tokens ?? 0,
      creditsUsed: u.totals?.credits_used ?? 0,
      requests: u.totals?.api_requests ?? 0,
    },
    models: (u.models || []).map((x) => ({
      model: x.model,
      requests: x.requests ?? 0,
      totalTokens: x.total_tokens ?? 0,
    })),
  };
}

export const name = 'codebuddy-gateway-panel';
export const inject = ['webServer'];

export function apply(ctx) {
  let session = null;
  let cache = { at: 0, key: '', value: null };
  let cacheCfg = null;

  // 本插件启动的内核进程（不代表用户自己开着的那个）
  let child = null;
  let childStartedAt = 0;
  const childLog = [];

  function pushLog(line) {
    const text = String(line).replace(/\s+$/, '');
    if (!text) return;
    childLog.push({ t: Date.now(), text });
    if (childLog.length > 200) childLog.shift();
  }

  function cfgResolved() {
    const { desktop, keys, dir } = loadDesktopConfig();
    return {
      host: desktop?.host || '127.0.0.1',
      port: Number(desktop?.port) || DEFAULT_PORT,
      adminKey: keys?.adminKey || '',
      clientKey: desktop?.clientKey || '',
      configDir: dir,
      configured: Boolean(desktop && keys?.adminKey),
    };
  }

  /** 内核是否已在监听（不区分是谁启动的） */
  async function probe() {
    const cfg = cfgResolved();
    try {
      const res = await request(`http://${cfg.host}:${cfg.port}/health`, {});
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async function startKernel() {
    // 先把首次运行的缺件补齐（管理密钥、配置、凭据）。
    // 不做这步的话，即使 Python 和内核都在，启动也会死在
    // 「ADMIN_KEY must contain at least 20 characters」。
    let init;
    try {
      init = ensureInitialized();
    } catch (err) {
      return { ok: false, error: `初始化失败：${err.message || err}` };
    }

    const cfg = cfgResolved();
    if (await probe()) {
      // 已经在跑：也要保证客户端 Key 存在，否则 /v1/* 一直 401
      if (!session) session = createSession(cfg);
      const k = await ensureClientKey(session, cfg);
      return {
        ok: true,
        already: true,
        message: '内核已在运行（由其他进程启动）。'
          + (k.created ? ' 已自动创建客户端 API Key。' : ''),
        notes: init.notes,
      };
    }
    const rt = findRuntime();
    if (!rt.found) {
      return {
        ok: false,
        error: '找不到网关运行时。插件自带的 payload 不完整，'
          + '且本机也没有已安装的「WorkBuddy 中转网关」。'
          + '请在本机登录一次 WorkBuddy / CodeBuddy 桌面端后重试。',
        searched: (rt.searched || []).slice(0, 8),
      };
    }
    if (!rt.bundled) rememberRuntime(rt.root);

    const args = [
      '-u', rt.launcher,
      '--project-dir', rt.kernel,
      '--host', cfg.host,
      '--port', String(cfg.port),
      '--data-dir', path.join(cfg.configDir, 'gateway-data'),
      '--admin-key-file', path.join(cfg.configDir, 'keys.json'),
      '--client-key', cfg.clientKey || '',
    ];

    pushLog(`$ ${rt.python} ${args.join(' ')}`);
    if (rt.bundled) pushLog('[info] 使用插件自带运行时');
    if (init.created.length) pushLog(`[init] 已生成：${init.created.join('、')}`);
    for (const n of init.notes) pushLog(`[init] ${n}`);
    try {
      child = spawn(rt.python, args, {
        cwd: rt.kernel,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
    } catch (err) {
      child = null;
      return { ok: false, error: `启动失败：${err.message}` };
    }

    child.stdout.on('data', (b) => String(b).split('\n').forEach(pushLog));
    child.stderr.on('data', (b) => String(b).split('\n').forEach(pushLog));
    child.on('exit', (code, sig) => {
      pushLog(`[exit] 内核退出 code=${code} signal=${sig}`);
      child = null;
      session = null;
      cache = { at: 0, key: '', value: null };
    });
    child.on('error', (err) => pushLog(`[error] ${err.message}`));
    childStartedAt = Date.now();

    // 等健康检查通过，最多 30s
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (await probe()) {
        // 起来了：补上客户端 Key（/v1/* 缺它一律 401）
        if (!session) session = createSession(cfgResolved());
        const k = await ensureClientKey(session, cfgResolved());
        return {
          ok: true,
          message: '内核已启动。'
            + (init.created.length ? ` 已初始化：${init.created.join('、')}。` : '')
            + (k.created ? ' 已创建客户端 API Key。' : ''),
          pid: child?.pid ?? null,
          bundled: rt.bundled,
          notes: init.notes,
          log: childLog.slice(-10),
        };
      }
      if (!child) {
        return { ok: false, error: '内核启动后立即退出，请查看日志。', log: childLog.slice(-12) };
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return { ok: false, error: '内核启动超时（30s）。', log: childLog.slice(-12) };
  }

  async function stopKernel() {
    // 优先停本插件启动的那个
    if (child) {
      const pid = child.pid;
      pushLog(`[stop] 结束内核 pid=${pid}`);
      try {
        child.kill();
      } catch (err) {
        pushLog(`[stop] kill 失败：${err.message}`);
      }
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && (await probe())) {
        await new Promise((r) => setTimeout(r, 300));
      }
      child = null;
      session = null;
      cache = { at: 0, key: '', value: null };
      return { ok: true, message: '内核已停止。', stoppedPid: pid };
    }

    // 不是本插件启动的：如实告知，不擅自杀别的进程
    if (await probe()) {
      return {
        ok: false,
        external: true,
        error: '内核正由其他进程运行（例如桌面版应用）。'
          + '请在那个进程里退出，或先关闭桌面版再从这里启动。',
      };
    }
    return { ok: true, already: true, message: '内核本来就没在运行。' };
  }

  async function readStatus(period) {
    const cfg = cfgResolved();
    const running = await probe();
    const base = {
      running,
      managed: Boolean(child),
      pid: child?.pid ?? null,
      managedSince: childStartedAt || null,
      endpoint: `http://${cfg.host}:${cfg.port}`,
      configDir: cfg.configDir,
      runtime: (() => {
        const rt = findRuntime();
        return rt.found ? { root: rt.root } : { root: null, searched: rt.searched.slice(0, 6) };
      })(),
    };

    if (!running) {
      return { ok: false, code: 'down', error: '内核未运行。', ...base };
    }
    if (!cfg.configured) {
      return {
        ok: false,
        code: 'not-configured',
        error: '内核在运行，但没有找到管理密钥（keys.json）。',
        ...base,
      };
    }

    const fingerprint = `${cfg.host}:${cfg.port}:${cfg.adminKey}`;
    if (cacheCfg !== fingerprint) {
      cacheCfg = fingerprint;
      session = null;
      cache = { at: 0, key: '', value: null };
    }

    const key = `${fingerprint}:${period}`;
    const now = Date.now();
    if (cache.value && cache.key === key && now - cache.at < CACHE_MS) {
      return { ...cache.value, running, managed: Boolean(child), pid: child?.pid ?? null };
    }

    if (!session) session = createSession(cfg);
    try {
      const [ov, usage] = await Promise.all([
        session.get('/admin/api/overview'),
        session.get(`/admin/api/usage?period=${encodeURIComponent(period)}`).catch(() => null),
      ]);
      const value = {
        ok: true,
        fetchedAt: now,
        ...base,
        overview: shapeOverview(ov),
        usage: usage ? shapeUsage(usage) : null,
      };
      cache = { at: now, key, value };
      return value;
    } catch (err) {
      session.reset();
      return { ok: false, code: 'unreachable', error: String(err.message || err), ...base };
    }
  }

  function sendJson(res, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const want = String(url.searchParams.get('period') || 'day');
        const period = PERIODS.has(want) ? want : 'day';
        try {
          sendJson(res, await readStatus(period));
        } catch (err) {
          sendJson(res, { ok: false, code: 'internal', error: String(err.message || err) });
        }
      },
    }),
  );

  // 控制路由：只接受 start / stop / restart，没有别的动作
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: CONTROL_ROUTE,
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const action = String(url.searchParams.get('action') || '');
        let result;
        try {
          if (action === 'start') result = await startKernel();
          else if (action === 'stop') result = await stopKernel();
          else if (action === 'restart') {
            const a = await stopKernel();
            if (a.ok) {
              await new Promise((r) => setTimeout(r, 800));
              result = await startKernel();
            } else result = a;
          } else {
            result = { ok: false, error: `不支持的动作：${action || '(空)'}` };
          }
        } catch (err) {
          result = { ok: false, error: String(err.message || err) };
        }
        if (action === 'stop' || action === 'restart') {
          session = null;
          cache = { at: 0, key: '', value: null };
        }
        sendJson(res, { ...result, log: childLog.slice(-10) });
      },
    }),
  );

  // 体检：只读，逐项报告依赖状态与修复建议。不依赖内核是否在跑。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: DIAGNOSE_ROUTE,
      handler: async (_req, res) => {
        try {
          sendJson(res, diagnose());
        } catch (err) {
          sendJson(res, { ok: false, error: String(err.message || err) });
        }
      },
    }),
  );

  /**
   * 账号与签到操作。
   *
   * 这是插件里唯一的写路径，所以刻意做成白名单：调用方只能用一个
   * action 名字，路径与请求体都由这里拼，客户端递不进任意 URL。
   *
   * 支持的 action：
   *   checkin                全部账号签到
   *   checkin-account        单账号签到（需 id）
   *   oauth-start            发起浏览器授权登录（需 name，可空）
   *   oauth-poll             轮询授权结果（需 fid）
   *   oauth-cancel           取消授权（需 fid）
   *   account-toggle         启用/停用（需 id、enabled）
   *   account-use            切到该账号消耗（需 id）
   *   account-remove         删除账号（需 id）
   *   pool-settings          改调度/自动签到（需 routing 或 autoCheckin）
   */
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ACTION_ROUTE,
      handler: async (req, res) => {
        const cfg = cfgResolved();
        if (!(await probe())) {
          return sendJson(res, { ok: false, error: '内核未运行，请先启动。' });
        }
        if (!cfg.configured) {
          return sendJson(res, { ok: false, error: '缺少管理密钥（keys.json）。' });
        }

        let body = {};
        try {
          const raw = await readBody(req);
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return sendJson(res, { ok: false, error: '请求体不是合法 JSON。' });
        }

        if (!session) session = createSession(cfg);
        const action = String(body.action || '');
        const id = body.id ? encodeURIComponent(String(body.id)) : '';

        let result;
        try {
          switch (action) {
            case 'checkin':
              result = await session.mutate('POST', '/admin/api/pool/actions/checkin', {});
              break;
            case 'checkin-account':
              if (!id) { result = { ok: false, error: '缺少账号 id' }; break; }
              result = await session.mutate(
                'POST', `/admin/api/accounts/${id}/actions/checkin`, {},
              );
              break;
            case 'oauth-start':
              result = await session.mutate('POST', '/admin/api/oauth/start', {
                name: String(body.name || '').trim() || undefined,
              });
              break;
            case 'oauth-poll':
              if (!body.fid) { result = { ok: false, error: '缺少授权会话 id' }; break; }
              result = await session.mutate(
                'POST', `/admin/api/oauth/${encodeURIComponent(String(body.fid))}/poll`, {},
              );
              break;
            case 'oauth-cancel':
              if (!body.fid) { result = { ok: false, error: '缺少授权会话 id' }; break; }
              result = await session.mutate(
                'DELETE', `/admin/api/oauth/${encodeURIComponent(String(body.fid))}`, null,
              );
              break;
            case 'account-toggle':
              if (!id) { result = { ok: false, error: '缺少账号 id' }; break; }
              result = await session.mutate('PATCH', `/admin/api/accounts/${id}`, {
                enabled: !!body.enabled,
              });
              break;
            case 'account-use': {
              if (!id) { result = { ok: false, error: '缺少账号 id' }; break; }
              const e = await session.mutate('PATCH', `/admin/api/accounts/${id}`, { enabled: true });
              if (!e.ok) { result = e; break; }
              const a = await session.mutate('PATCH', `/admin/api/accounts/${id}`, { active: true });
              if (!a.ok) { result = a; break; }
              result = await session.mutate(
                'PATCH', '/admin/api/pool/settings', { routing: 'manual' },
              );
              break;
            }
            case 'account-remove':
              if (!id) { result = { ok: false, error: '缺少账号 id' }; break; }
              result = await session.mutate('DELETE', `/admin/api/accounts/${id}`, null);
              break;
            case 'add-credential': {
              if (!body.credential || typeof body.credential !== 'object') {
                result = { ok: false, error: '缺少凭据内容' };
                break;
              }
              const payload = { credential: body.credential };
              if (body.name) payload.name = String(body.name);
              result = await session.mutate('POST', '/admin/api/accounts', payload);
              break;
            }
            case 'pool-settings': {
              const patch = {};
              if (body.routing) patch.routing = String(body.routing);
              if (typeof body.autoCheckin === 'boolean') patch.auto_checkin = body.autoCheckin;
              if (body.checkinTime) patch.checkin_time = String(body.checkinTime);
              if (!Object.keys(patch).length) {
                result = { ok: false, error: '没有要修改的设置项' };
                break;
              }
              result = await session.mutate('PATCH', '/admin/api/pool/settings', patch);
              break;
            }
            default:
              result = { ok: false, error: `不支持的动作：${action || '(空)'}` };
          }
        } catch (err) {
          result = { ok: false, error: String(err.message || err) };
        }

        // 写操作会改变账号状态，丢掉缓存让界面立刻刷新
        cache = { at: 0, key: '', value: null };
        sendJson(res, result);
      },
    }),
  );

  // 宿主卸载/退出时，收掉自己启动的内核
  ctx.effect(() => () => {
    if (child) {
      try {
        child.kill();
      } catch { /* 已退出 */ }
      child = null;
    }
  });
}
