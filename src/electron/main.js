'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, Notification, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

// ---------------------------------------------------------------------------
// 路径与配置
// ---------------------------------------------------------------------------

const USER_DATA = app.getPath('userData');
const CONFIG_FILE = path.join(USER_DATA, 'desktop.json');
const KEY_FILE = path.join(USER_DATA, 'keys.json');
const GATEWAY_DATA = path.join(USER_DATA, 'gateway-data');

// 打包后 __dirname 位于 app.asar 内，而 Python 读不到 asar 内部文件，
// launcher.py / 内核 / 图标都以 extraResources 形式放在 process.resourcesPath 下。
const IS_PACKAGED = app.isPackaged;
const APP_ROOT = IS_PACKAGED ? process.resourcesPath : path.resolve(__dirname, '..', '..');
const LAUNCHER = IS_PACKAGED
  ? path.join(APP_ROOT, 'launcher.py')
  : path.join(__dirname, '..', 'launcher.py');

const DEFAULT_PROJECT = 'D:\\workshop\\2026-09-23-10-55-33\\workbuddy2api';

/** 打包版随安装包附带的内核；不存在则回退到开发期默认目录 */
function builtinKernel() {
  if (!IS_PACKAGED) return '';
  const p = path.join(APP_ROOT, 'kernel');
  return fs.existsSync(path.join(p, 'core', 'converter.py')) ? p : '';
}

function defaultProject() {
  return builtinKernel() || DEFAULT_PROJECT;
}

const DEFAULT_CONFIG = {
  projectDir: defaultProject(),
  pythonPath: '', // 留空则自动探测项目内 .venv
  host: '127.0.0.1',
  port: 8787,
  clientKey: '', // 客户端调用 /v1/* 时要求的 API Key
  startMinimized: false,
};

let config = loadConfig();
let keys = loadKeys();

// 内核对 /v1/* 强制校验客户端 Key：留空会让 Claude Code / HexHub 等客户端直接 401。
// 首次运行自动生成一枚，用户在设置页可见可改。
if (!config.clientKey) {
  config.clientKey = `wbg-${require('node:crypto').randomBytes(16).toString('hex')}`;
  saveConfig({ clientKey: config.clientKey });
}

function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    saved = {};
  }
  const merged = { ...DEFAULT_CONFIG, ...saved };
  // 用户在设置页手动指定过内核目录时才尊重它（且目录必须真的像 workbuddy2api）
  const custom =
    saved.projectDirCustom === true &&
    !!saved.projectDir &&
    fs.existsSync(path.join(saved.projectDir, 'core', 'converter.py'));
  const builtin = builtinKernel();
  if (builtin) {
    // 打包版：内核随安装包走。旧安装/旧构建目录被清理或占用时自动跟随当前安装，
    // 否则一次重建就会让应用指向已失效的绝对路径。
    merged.projectDir = custom ? saved.projectDir : builtin;
  } else if (!custom && (!saved.projectDir || saved.projectDir === DEFAULT_PROJECT)) {
    merged.projectDir = DEFAULT_PROJECT;
  }
  return merged;
}

function saveConfig(next) {
  config = { ...config, ...next };
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

/** 管理密钥：首次运行生成，之后复用，供自动登录使用 */
function loadKeys() {
  try {
    const k = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    if (k && k.adminKey && k.adminKey.length >= 20) return k;
  } catch {
    /* 首次运行 */
  }
  const generated = { adminKey: require('node:crypto').randomBytes(32).toString('base64url').slice(0, 40) };
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(KEY_FILE, JSON.stringify(generated, null, 2), 'utf8');
  return generated;
}

function resolvePython() {
  if (config.pythonPath && fs.existsSync(config.pythonPath)) return config.pythonPath;
  const venvWin = path.join(config.projectDir, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venvWin)) return venvWin;
  const venvPosix = path.join(config.projectDir, '.venv', 'bin', 'python');
  if (fs.existsSync(venvPosix)) return venvPosix;
  return os.platform() === 'win32' ? 'python' : 'python3';
}

const baseUrl = () => `http://${config.host}:${config.port}`;

// ---------------------------------------------------------------------------
// 网关进程管理
// ---------------------------------------------------------------------------

let child = null;
let running = false;
let lastError = '';
let startedAt = null;
let adminCookie = null; // { name, value }
let csrfToken = ''; // 内核对非 GET 请求校验 X-CSRF-Token
const logs = [];
const LOG_CAP = 400;

function pushLog(line) {
  const text = String(line).replace(/\s+$/, '');
  if (!text) return;
  logs.push({ t: Date.now(), text });
  if (logs.length > LOG_CAP) logs.shift();
}

function health() {
  return new Promise((resolve) => {
    const req = http.get(`${baseUrl()}/health`, { timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitHealthy(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await health()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function startGateway() {
  if (child) return { ok: false, error: '网关已在启动中' };
  lastError = '';

  const python = resolvePython();
  const args = [
    '-u',
    LAUNCHER,
    '--project-dir',
    config.projectDir,
    '--host',
    config.host,
    '--port',
    String(config.port),
    '--data-dir',
    GATEWAY_DATA,
    '--admin-key-file',
    KEY_FILE,
    '--client-key',
    config.clientKey || '',
  ];

  pushLog(`$ ${python} ${args.slice(1).join(' ')}`);

  try {
    child = spawn(python, args, {
      cwd: config.projectDir,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
  } catch (err) {
    lastError = String(err.message || err);
    pushLog(`[error] 启动失败：${lastError}`);
    child = null;
    return { ok: false, error: lastError };
  }

  child.stdout.on('data', (buf) => String(buf).split('\n').forEach(pushLog));
  child.stderr.on('data', (buf) => String(buf).split('\n').forEach(pushLog));
  child.on('exit', (code, sig) => {
    pushLog(`[exit] 网关进程退出 code=${code} signal=${sig}`);
    child = null;
    running = false;
    adminCookie = null;
    refreshTray();
    notifyStatus();
  });
  child.on('error', (err) => {
    lastError = String(err.message || err);
    pushLog(`[error] ${lastError}`);
  });

  startedAt = Date.now();
  return { ok: true };
}

function stopGateway() {
  if (!child) return { ok: true };
  try {
    child.kill();
  } catch {
    /* 已退出 */
  }
  child = null;
  running = false;
  adminCookie = null;
  return { ok: true };
}

/** 启动并等待健康，然后完成自动登录 */
/**
 * 保证内核里至少有一把可用的客户端 API Key。
 *
 * 内核只在数据目录首次初始化时才采纳 --client-key（"首次迁入"），
 * 若目录是早期空密钥创建的，之后传什么都无效 —— 客户端接入必然 401。
 * 因此这里反过来：内核没有密钥就由桌面版建一枚，并保存明文供用户复制。
 */
async function ensureClientKey() {
  try {
    const r = await request('GET', '/admin/api/overview');
    if (r.status !== 200) return;
    let keys = [];
    try {
      keys = JSON.parse(r.text).keys || [];
    } catch {
      return;
    }
    if (keys.length > 0) return; // 内核已有密钥，沿用
    const c = await request('POST', '/admin/api/keys', { name: '桌面版' });
    if (c.status !== 200) {
      pushLog(`[keys] 创建客户端密钥失败：${c.status}`);
      return;
    }
    const j = JSON.parse(c.text);
    if (j.key) {
      saveConfig({ clientKey: j.key });
      pushLog('[keys] 已创建客户端 API Key，可在设置页复制');
    }
  } catch (err) {
    pushLog(`[keys] 同步客户端密钥失败：${err.message || err}`);
  }
}

async function ensureGateway() {
  if (await health()) {
    running = true;
    await loginAdmin();
    await ensureClientKey();
    refreshTray();
    notifyStatus();
    return { ok: true, already: true };
  }
  const r = startGateway();
  if (!r.ok) return r;
  const ok = await waitHealthy();
  running = ok;
  if (!ok) {
    lastError = '网关启动超时，请查看日志';
    pushLog(`[error] ${lastError}`);
  } else {
    await loginAdmin();
    await ensureClientKey();
  }
  refreshTray();
  notifyStatus();
  return { ok, error: ok ? '' : lastError };
}

// ---------------------------------------------------------------------------
// 管理端鉴权：取会话 cookie，供面板取数与 webview 内嵌页面使用
// ---------------------------------------------------------------------------

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl() + urlPath);
    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (adminCookie) headers.Cookie = `${adminCookie.name}=${adminCookie.value}`;
    // 内核 require_admin 对非 GET 请求强制校验 CSRF，缺失会 403
    if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;

    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method, headers, timeout: 10000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, text: raw });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function loginAdmin() {
  try {
    const res = await request('POST', '/admin/api/login', { key: keys.adminKey });
    if (res.status !== 200) {
      pushLog(`[auth] 管理端登录失败 HTTP ${res.status}`);
      return false;
    }
    const setCookie = res.headers['set-cookie'] || [];
    const raw = setCookie.find((c) => c.startsWith('workbuddy_admin='));
    if (!raw) {
      pushLog('[auth] 登录成功但没有拿到会话 cookie');
      return false;
    }
    const value = raw.split(';')[0].split('=')[1];
    adminCookie = { name: 'workbuddy_admin', value };

    try {
      csrfToken = (JSON.parse(res.text || '{}') || {}).csrf || '';
    } catch {
      csrfToken = '';
    }

    // 让内嵌的管理后台页面（webview）也处于已登录状态
    try {
      await session.defaultSession.cookies.set({
        url: `${baseUrl()}/admin/`,
        name: 'workbuddy_admin',
        value,
        path: '/admin',
        httpOnly: true,
        sameSite: 'strict',
      });
    } catch (err) {
      pushLog(`[auth] cookie 注入失败：${err.message}`);
    }
    pushLog('[auth] 管理端会话已建立');
    return true;
  } catch (err) {
    pushLog(`[auth] ${err.message}`);
    return false;
  }
}

async function getOverview() {
  if (!running) return null;
  let res = await request('GET', '/admin/api/overview');
  if (res.status === 401 || res.status === 403) {
    // 会话过期：重新登录再取一次
    if (await loginAdmin()) res = await request('GET', '/admin/api/overview');
  }
  if (res.status !== 200) return null;
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 窗口 / 托盘
// ---------------------------------------------------------------------------

let win = null;
let tray = null;
let quitting = false;

function iconPath(name) {
  // 开发态：__dirname = src/electron → 上两级是项目根；打包态：resources 目录
  return path.join(APP_ROOT, 'resources', name);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'WorkBuddy 中转网关',
    icon: nativeImage.createFromPath(iconPath('icon.png')),
    backgroundColor: '#f6f7f9',
    show: false, // 等首屏渲染完再显示，避免白屏
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    if (!quitting && win && !win.isDestroyed() && !config.startMinimized) {
      win.show();
    }
  });

  win.on('close', (e) => {
    if (!quitting) {
      // 关闭窗口不等于退出：缩到托盘继续中转
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

function statusLabel() {
  if (running) return `运行中 · ${config.host}:${config.port}`;
  return '已停止';
}

/** 执行一次批量签到。fromTray=true 时额外弹桌面通知 */
async function doCheckin(fromTray = false) {
  let r;
  try {
    r = await withReauth(() => request('POST', '/admin/api/pool/actions/checkin', {}));
  } catch (err) {
    r = { ok: false, error: err.message };
  }
  const results = r.results || [];
  const okCount = results.filter((x) => x.ok).length;
  const msg = r.ok
    ? `签到完成：成功 ${okCount}/${results.length}`
    : `签到失败：${r.error || '未知错误'}`;
  pushLog(
    `[checkin] ${msg}` +
      (r.ok && results.length ? ` — ${results.map((x) => `${x.id}: ${x.message}`).join(' | ')}` : ''),
  );
  if (fromTray && Notification.isSupported()) {
    new Notification({ title: 'WorkBuddy 网关 · 每日签到', body: msg }).show();
  }
  if (win && !win.isDestroyed()) win.webContents.send('gw:checkin-result', r);
  notifyStatus();
  return r;
}

function refreshTray() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: `状态：${statusLabel()}`, enabled: false },
    { type: 'separator' },
    {
      label: running ? '停止网关' : '启动网关',
      click: async () => (running ? stopGateway() : ensureGateway()).then(refreshTray),
    },
    { label: '重启网关', click: async () => { stopGateway(); await new Promise((r) => setTimeout(r, 600)); await ensureGateway(); refreshTray(); } },
    { type: 'separator' },
    { label: '打开面板', click: () => win && (win.show(), win.focus()) },
    { label: '每日签到（立即）', click: () => doCheckin(true) },
    { label: '打开数据目录', click: () => shell.openPath(GATEWAY_DATA) },
    { label: '客户端接入地址', click: () => dialog.showMessageBox({ type: 'info', title: '接入地址', message: `${baseUrl()}/v1`, detail: '在 Claude Code / CC-Switch / HexHub 等客户端里填这个地址。' }) },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; stopGateway(); app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`WorkBuddy 中转网关 · ${statusLabel()}`);
}

function notifyStatus() {
  if (win && !win.isDestroyed()) win.webContents.send('gw:status', statusPayload());
}

function statusPayload() {
  return {
    running,
    host: config.host,
    port: config.port,
    base: baseUrl(),
    startedAt,
    lastError,
    dataDir: GATEWAY_DATA,
    projectDir: config.projectDir,
    autostart: app.getLoginItemSettings().openAtLogin,
  };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('gw:status', () => statusPayload());
ipcMain.handle('gw:logs', () => logs.slice(-200));
ipcMain.handle('gw:overview', () => getOverview());
ipcMain.handle('gw:config', () => ({ ...config, adminKey: keys.adminKey }));
ipcMain.handle('gw:start', () => ensureGateway());
ipcMain.handle('gw:stop', () => { stopGateway(); refreshTray(); notifyStatus(); return { ok: true }; });
ipcMain.handle('gw:restart', async () => {
  stopGateway();
  await new Promise((r) => setTimeout(r, 600));
  const r = await ensureGateway();
  refreshTray();
  return r;
});
/** 统一解析内核 JSON 响应；HTTP 非 200 时给出可读错误，不把原始报文整个抛给界面 */
function parseKernel(res) {
  if (res.status !== 200) {
    return { ok: false, error: `HTTP ${res.status}`, detail: String(res.text || '').slice(0, 300) };
  }
  try {
    return { ...JSON.parse(res.text || '{}'), ok: true };
  } catch {
    return { ok: false, error: '内核响应无法解析' };
  }
}

/** 会话失效时重试一次，避免用户遇到"莫名 401" */
async function withReauth(run) {
  const res = await run();
  if (res.status === 401 || res.status === 403) {
    if (await loginAdmin()) return parseKernel(await run());
  }
  return parseKernel(res);
}

// ---- 每日签到 / 积分 ----

/** 批量签到：对账号池内所有启用账号执行 checkin */
ipcMain.handle('gw:checkin', async () => {
  try {
    return await withReauth(() => request('POST', '/admin/api/pool/actions/checkin', {}));
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** 单账号签到 */
ipcMain.handle('gw:checkin-account', async (_e, aid) => {
  try {
    const p = `/admin/api/accounts/${encodeURIComponent(String(aid))}/actions/checkin`;
    return await withReauth(() => request('POST', p, {}));
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** 账号池设置：auto_checkin(bool) / checkin_time("HH:MM") / routing */
ipcMain.handle('gw:pool-settings', async (_e, patch) => {
  try {
    return await withReauth(() => request('PATCH', '/admin/api/pool/settings', patch || {}));
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---- 多账号：登录 / 切换 / 签到 ----

/**
 * 发起浏览器授权登录。
 * 内核只负责生成一次性授权链接并轮询结果，真正的登录页在系统默认浏览器打开
 * （这样能复用用户已有的 CodeBuddy 会话，不必在应用内再实现一套登录）。
 */
ipcMain.handle('gw:oauth:start', async (_e, name) => {
  try {
    const r = await withReauth(() => request('POST', '/admin/api/oauth/start', { name: String(name || '').trim() || undefined }));
    if (r.ok && r.url) {
      try {
        await shell.openExternal(r.url);
      } catch (err) {
        return { ok: false, error: `无法打开浏览器：${err.message}`, url: r.url };
      }
    }
    return r;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** 轮询授权结果：pending / success / expired */
ipcMain.handle('gw:oauth:poll', async (_e, fid) => {
  try {
    if (!fid) return { ok: false, error: '缺少授权会话 id' };
    return await withReauth(() => request('POST', `/admin/api/oauth/${encodeURIComponent(String(fid))}/poll`, {}));
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('gw:oauth:cancel', async (_e, fid) => {
  try {
    if (!fid) return { ok: false, error: '缺少授权会话 id' };
    return await withReauth(() => request('DELETE', `/admin/api/oauth/${encodeURIComponent(String(fid))}`));
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** 手动导入凭据：credential 为桌面端 .info 文件的内容（含 auth / account 对象） */
ipcMain.handle('gw:accounts:add', async (_e, input) => {
  try {
    const body = {};
    if (input && input.credential) body.credential = input.credential;
    if (input && input.name) body.name = input.name;
    return await withReauth(() => request('POST', '/admin/api/accounts', body));
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * 切换消耗账号：把调度切到 manual 并指定该账号。
 * 轮询模式下「当前账号」不生效，所以这里连带改 routing，避免出现"点了没变化"。
 */
ipcMain.handle('gw:accounts:use', async (_e, aid) => {
  try {
    if (!aid) return { ok: false, error: '缺少账号 id' };
    const id = encodeURIComponent(String(aid));
    const enabled = await withReauth(() => request('PATCH', `/admin/api/accounts/${id}`, { enabled: true }));
    if (!enabled.ok) return enabled;
    const act = await withReauth(() => request('PATCH', `/admin/api/accounts/${id}`, { active: true }));
    if (!act.ok) return act;
    return await withReauth(() => request('PATCH', '/admin/api/pool/settings', { routing: 'manual' }));
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('gw:accounts:update', async (_e, input) => {
  try {
    const id = encodeURIComponent(String((input || {}).id || ''));
    if (!id) return { ok: false, error: '缺少账号 id' };
    return await withReauth(() => request('PATCH', `/admin/api/accounts/${id}`, input.patch || {}));
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('gw:accounts:remove', async (_e, aid) => {
  try {
    const id = encodeURIComponent(String(aid || ''));
    if (!id) return { ok: false, error: '缺少账号 id' };
    return await withReauth(() => request('DELETE', `/admin/api/accounts/${id}`));
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** 单账号动作：refresh（刷新积分/令牌）/ status / checkin */
ipcMain.handle('gw:accounts:action', async (_e, input) => {
  try {
    const id = encodeURIComponent(String((input || {}).id || ''));
    const action = encodeURIComponent(String((input || {}).action || ''));
    if (!id || !action) return { ok: false, error: '缺少账号 id 或动作' };
    return await withReauth(() => request('POST', `/admin/api/accounts/${id}/actions/${action}`, {}));
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** 选择本地 .info / .json 凭据文件，在主进程读取并解析，界面不直接碰磁盘 */
ipcMain.handle('gw:pick-credential', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openFile'],
    title: '选择 CodeBuddy 登录文件（.info / .json）',
    filters: [{ name: '登录凭据', extensions: ['info', 'json'] }, { name: '所有文件', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const file = res.filePaths[0];
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, file, error: `无法解析该文件：${err.message}` };
  }

  // 新版桌面端会把 token 加密存储（{$wbEncrypted:1, envelope:"..."}），内核只认明文。
  // 不在这里拦下的话，用户只会看到一句看不懂的「缺少 accessToken」。
  const auth = doc && doc.auth;
  const token = auth && auth.accessToken;
  if (token && typeof token !== 'string') {
    return {
      ok: false,
      file,
      encrypted: true,
      error:
        '这个文件里的令牌是加密格式（桌面端新版会加密存储），网关无法直接使用。\n' +
        '请改用同目录下带时间戳的备份文件（形如 workbuddy-desktop.2026-09-20T....info），' +
        '或直接点「浏览器登录新账号」。',
    };
  }

  return { ok: true, file, credential: doc };
});

ipcMain.handle('gw:config:save', (_e, next) => {
  const patch = { ...(next || {}) };
  // 记住内核目录是否由用户手动指定：手动指定的才在后续启动里保留
  if (Object.prototype.hasOwnProperty.call(patch, 'projectDir')) {
    patch.projectDirCustom = !!patch.projectDir && patch.projectDir !== defaultProject();
  }
  const saved = saveConfig(patch);
  refreshTray();
  return { ...saved, adminKey: keys.adminKey };
});
ipcMain.handle('gw:pick-project', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择 workbuddy2api 项目目录' });
  return res.canceled ? null : res.filePaths[0];
});
ipcMain.handle('gw:keys:create', async () => {
  try {
    const c = await request('POST', '/admin/api/keys', { name: '桌面版' });
    if (c.status !== 200) return { ok: false, error: `HTTP ${c.status}` };
    const j = JSON.parse(c.text);
    if (!j.key) return { ok: false, error: '内核未返回密钥明文' };
    saveConfig({ clientKey: j.key });
    pushLog('[keys] 已生成新的客户端 API Key');
    return { ok: true, key: j.key };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});
ipcMain.handle('gw:open-dir', (_e, p) => shell.openPath(p || GATEWAY_DATA));

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(async () => {
    fs.mkdirSync(GATEWAY_DATA, { recursive: true });

    createWindow();

    tray = new Tray(nativeImage.createFromPath(iconPath('tray.png')));
    tray.on('click', () => win && (win.show(), win.focus()));
    refreshTray();

    try {
      await ensureGateway();
    } catch (err) {
      pushLog(`[boot] 网关启动异常：${err.message || err}`);
    }

    if (win && !win.isDestroyed()) {
      // startMinimized 时窗口保持隐藏，托盘在运行
      if (!config.startMinimized) { win.show(); win.focus(); }
    }

    // 仅供文档截图：GW_CAPTURE=<png 路径> 时截图后自行退出。
    // 不设该变量时这段代码完全不执行，不影响正常运行。
    if (process.env.GW_CAPTURE && win && !win.isDestroyed()) {
      win.show();
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.GW_CAPTURE, img.toPNG());
        } catch (err) {
          pushLog(`[capture] 截图失败：${err.message || err}`);
        } finally {
          quitting = true;
          stopGateway();
          app.quit();
        }
      }, Number(process.env.GW_CAPTURE_DELAY || 6000));
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    stopGateway();
  });

  app.on('window-all-closed', () => {
    // 托盘常驻：不退出
  });
}
