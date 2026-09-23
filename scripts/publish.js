'use strict';

/**
 * 一键发布到 GitHub：
 *   建仓库 → 推送 → 打 tag → 建 Release → 上传安装包
 *
 * 令牌从 Windows 凭据管理器取（git credential fill），不需要任何环境变量或手工输入。
 * 第一次取不到时会由 GCM 弹窗问一次，之后 git credential approve 已持久化，不再弹。
 *
 * 幂等：仓库/Release/tag 已存在就跳过，重跑安全。
 * 用法：npm run publish:github
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');

// Node 22 默认 DNS 结果顺序是 verbatim，会先试 IPv6；本机 IPv6 不通时
// fetch 直接 Connect Timeout（而 curl 正常）。强制 IPv4 优先。
require('node:dns').setDefaultResultOrder('ipv4first');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// 从 package.json 的 repository.url 解析 owner/repo，避免两处写死
const repoUrl = (pkg.repository && pkg.repository.url) || '';
const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(repoUrl);
if (!m) {
  console.error('[publish] package.json 的 repository.url 无法解析 owner/repo：', repoUrl);
  process.exit(1);
}
const OWNER = m[1];
const REPO = m[2];
const VERSION = `v${pkg.version}`;
const API = 'https://api.github.com';

// ---------- 令牌 ----------
function getToken() {
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const hit = /^password=(.+)$/m.exec(r.stdout || '');
  return hit ? hit[1].trim() : null;
}

const TOKEN = getToken();
if (!TOKEN) {
  console.error('[publish] 取不到 GitHub 令牌（git credential fill 返回空）');
  process.exit(1);
}

// ---------- API ----------
async function api(method, urlPath, body) {
  const res = await fetch(API + urlPath, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return { ok: true, data: {} };
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    // GitHub 会在响应头里写明缺哪个权限，直接透传，省得猜
    const need = res.headers.get('x-accepted-github-permissions');
    const err = new Error(
      `${method} ${urlPath} → ${res.status} ${data.message || text.slice(0, 200)}` +
        (need ? `\n[publish] 该端点需要权限: ${need}` : '')
    );
    err.status = res.status;
    throw err;
  }
  return { ok: true, data };
}

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${(r.stderr || r.stdout || '').trim()}`);
  }
  return (r.stdout || '').trim();
}

// ---------- 1. 身份 ----------
async function whoami() {
  const { data } = await api('GET', '/user');
  console.log(`[publish] 身份：${data.login}${OWNER && data.login !== OWNER ? `（注意：与 package.json 里的 ${OWNER} 不一致）` : ''}`);
  return data.login;
}

// ---------- 2. 仓库 ----------
async function ensureRepo() {
  let exists = false;
  try {
    await api('GET', `/repos/${OWNER}/${REPO}`);
    exists = true;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  if (exists) {
    console.log(`[publish] 仓库已存在：${OWNER}/${REPO}`);
    return;
  }
  console.log(`[publish] 创建仓库：${OWNER}/${REPO}（public）`);
  await api('POST', '/user/repos', {
    name: REPO,
    description: pkg.description || '',
    homepage: pkg.homepage || '',
    private: false,
    has_issues: true,
    has_wiki: false,
    auto_init: false,
  });
  console.log('[publish] 仓库创建成功');
}

// ---------- 3. 推送 ----------
function push() {
  const remote = `https://github.com/${OWNER}/${REPO}.git`;
  const cur = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' });
  const curUrl = (cur.stdout || '').trim();
  if (curUrl !== remote) {
    if (curUrl) git(['remote', 'set-url', 'origin', remote]);
    else git(['remote', 'add', 'origin', remote]);
  }
  console.log('[publish] 推送代码…');
  git(['push', '-u', 'origin', 'HEAD:main']);
  console.log('[publish] 代码已推送');

  const tags = spawnSync('git', ['tag', '-l', VERSION], { cwd: ROOT, encoding: 'utf8' });
  if (!(tags.stdout || '').trim()) git(['tag', '-a', VERSION, '-m', `Release ${VERSION}`]);
  git(['push', 'origin', VERSION, '--force']);
  console.log(`[publish] tag ${VERSION} 已推送`);
}

// ---------- 4. Release ----------
async function ensureRelease() {
  let id = null;
  try {
    const { data } = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${VERSION}`);
    id = data.id;
    console.log(`[publish] Release ${VERSION} 已存在`);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  if (id === null) {
    const notesPath = path.join(ROOT, 'release', `RELEASE_NOTES_${VERSION}.md`);
    const body = fs.existsSync(notesPath)
      ? fs.readFileSync(notesPath, 'utf8')
      : `Release ${VERSION}`;
    const { data } = await api('POST', `/repos/${OWNER}/${REPO}/releases`, {
      tag_name: VERSION,
      name: VERSION,
      body,
      draft: false,
      prerelease: false,
    });
    id = data.id;
    console.log(`[publish] Release ${VERSION} 已创建`);
  }
  return id;
}

// ---------- 5. 上传安装包 ----------
async function uploadAsset(releaseId) {
  const file = path.join(ROOT, 'release', `${REPO}-${pkg.version}-Setup.exe`);
  if (!fs.existsSync(file)) {
    console.warn(`[publish] 找不到安装包 ${file}，跳过上传（先跑 npm run build）`);
    return;
  }
  const name = path.basename(file);
  const { data: assets } = await api('GET', `/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?per_page=100`);
  if (assets.some((a) => a.name === name)) {
    console.log(`[publish] 附件 ${name} 已存在，跳过`);
    return;
  }
  const size = fs.statSync(file).size;
  console.log(`[publish] 上传附件 ${name}（${(size / 1048576).toFixed(1)} MB）…`);
  // 必须一次性给出 Buffer：Node fetch 用流式 body 会走 chunked，
  // GitHub uploads 端点要求 Content-Length，否则报 400 Bad Content-Length
  const buf = fs.readFileSync(file);
  const res = await fetch(
    `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(buf.length),
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: buf,
    }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`上传附件失败 ${res.status}：${text.slice(0, 300)}`);
  }
  console.log('[publish] 附件上传完成');
}

// ---------- main ----------
(async () => {
  try {
    await whoami();
    await ensureRepo();
    push();
    const releaseId = await ensureRelease();
    await uploadAsset(releaseId);
    console.log(`\n[publish] 完成 → https://github.com/${OWNER}/${REPO}/releases/tag/${VERSION}`);
  } catch (err) {
    console.error(`\n[publish] 失败：${err.message}`);
    process.exit(1);
  }
})();
