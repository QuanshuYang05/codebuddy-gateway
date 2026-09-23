'use strict';

/**
 * 内核链路冒烟测试（不启动 Electron）。
 *
 * 验证：启动器能起内核 -> /health 通 -> 管理端能登录 -> /admin/api/overview 返回指标
 *      -> /v1/models 返回模型 -> /v1/chat/completions 能真正转发到上游。
 *
 * 用法：node scripts/smoke-test.js
 */

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const KERNEL_DIR = process.env.WB_KERNEL_DIR || 'D:\\workshop\\2026-09-23-10-55-33\\workbuddy2api';
const PORT = Number(process.env.SMOKE_PORT || 8799);
const PYTHON = path.join(KERNEL_DIR, '.venv', 'Scripts', 'python.exe');
const LAUNCHER = path.join(__dirname, '..', 'src', 'launcher.py');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wbg-smoke-'));

const adminKey = crypto.randomBytes(32).toString('base64url');
const clientKey = `smoke-${crypto.randomBytes(12).toString('hex')}`;
const keyFile = path.join(TMP, 'keys.json');
const dataDir = path.join(TMP, 'data');

fs.writeFileSync(keyFile, JSON.stringify({ adminKey }, null, 2));

let child = null;
let failed = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failed += 1;
  return ok;
}

function request(method, urlPath, { body = undefined, cookie = '', auth = '', timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { Accept: 'application/json' };
    if (auth) headers.Authorization = `Bearer ${auth}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (cookie) headers.Cookie = cookie;

    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: urlPath, method, headers, timeout },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode, headers: res.headers, json, text: data });
        });
      },
    );
    req.on('error', () => resolve({ status: 0, headers: {}, json: null, text: '' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, headers: {}, json: null, text: '' });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killChild() {
  if (!child) return;
  try {
    child.kill();
  } catch {
    /* 忽略 */
  }
  if (child.pid && process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${child.pid} /t /f`, { stdio: 'ignore' });
    } catch {
      /* 已退出 */
    }
  }
  child = null;
}

async function main() {
  console.log(`内核目录 : ${KERNEL_DIR}`);
  console.log(`测试端口 : ${PORT}`);
  console.log(`临时目录 : ${TMP}`);
  console.log('');

  const stderrLog = [];
  child = spawn(
    PYTHON,
    ['-u', LAUNCHER, '--project-dir', KERNEL_DIR, '--port', String(PORT), '--data-dir', dataDir, '--admin-key-file', keyFile, '--client-key', clientKey],
    { cwd: KERNEL_DIR, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, windowsHide: true },
  );
  child.stdout.on('data', (d) => stderrLog.push(String(d)));
  child.stderr.on('data', (d) => stderrLog.push(String(d)));

  // 1. 健康检查
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    const r = await request('GET', '/health');
    if (r.status === 200) healthy = true;
    else await sleep(700);
  }
  if (!check('内核启动 + /health', healthy)) {
    console.log('\n--- 内核输出 ---\n' + stderrLog.join(''));
    killChild();
    process.exit(1);
  }

  // 2. 管理端登录
  const login = await request('POST', '/admin/api/login', { body: { key: adminKey } });
  const cookieRaw = (login.headers['set-cookie'] || []).find((c) => c.startsWith('workbuddy_admin='));
  const cookie = cookieRaw ? cookieRaw.split(';')[0] : '';
  if (!check('管理端登录', login.status === 200 && Boolean(cookie), `HTTP ${login.status}`)) {
    killChild();
    process.exit(1);
  }

  // 3. 概览指标
  const ov = await request('GET', '/admin/api/overview', { cookie });
  const m = ov.status === 200 && ov.json ? ov.json.metrics : null;
  check(
    '中转状态接口 /admin/api/overview',
    Boolean(m),
    m ? `完成 ${m.completed} 笔 / 进行中 ${m.in_flight} / 成功率 ${m.success_rate ?? '—'}` : `HTTP ${ov.status}`,
  );
  if (ov.status === 200 && ov.json) {
    check('账号池已导入凭据', Array.isArray(ov.json.accounts) && ov.json.accounts.length > 0, `账号数 ${(ov.json.accounts || []).length}`);
  }

  // 4. 模型列表（客户端接口要求带 API Key）
  const models = await request('GET', '/v1/models', { auth: clientKey });
  const modelList = models.status === 200 && models.json ? models.json.data || [] : [];
  check('GET /v1/models', models.status === 200, `HTTP ${models.status} / ${modelList.length} 个模型`);

  // 5. 真实转发一次（非流式，短输出）
  const model = modelList.length ? modelList[0].id : 'deepseek-v4-flash';
  const chat = await request(
    'POST',
    '/v1/chat/completions',
    {
      body: { model, messages: [{ role: 'user', content: '请只回复两个字：正常' }], stream: false, max_tokens: 64 },
      auth: clientKey,
      timeout: 90000,
    },
  );
  const content =
    chat.status === 200 && chat.json
      ? ((chat.json.choices || [])[0] || {}).message?.content ?? ''
      : '';
  check(
    'POST /v1/chat/completions 真实转发',
    chat.status === 200 && Boolean(content),
    `HTTP ${chat.status} ${content ? `回复="${String(content).slice(0, 40)}"` : (chat.text || '').slice(0, 120)}`,
  );

  // 6. 再取一次概览，确认指标确实在动
  const ov2 = await request('GET', '/admin/api/overview', { cookie });
  const m2 = ov2.status === 200 && ov2.json ? ov2.json.metrics : null;
  check('指标随请求递增', Boolean(m2) && m2.completed >= 1, m2 ? `完成 ${m2.completed} 笔` : '');

  console.log('');
  if (failed === 0) {
    console.log('全部通过：内核链路可用，桌面版可以正常托管。');
  } else {
    console.log(`${failed} 项未通过。内核输出摘要：`);
    console.log(stderrLog.join('').slice(-2000));
  }
  killChild();
  process.exit(failed === 0 ? 0 : 1);
}

process.on('SIGINT', () => {
  killChild();
  process.exit(130);
});

main().catch((err) => {
  console.error('冒烟测试异常:', err.message);
  killChild();
  process.exit(1);
});
