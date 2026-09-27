'use strict';

/**
 * 回归防护：主进程的 request() 必须把查询串带给内核。
 *
 * 背景（真实踩到的 bug）：request() 原来写的是 `path: u.pathname`，查询串被丢掉。
 * 对 /admin/api/usage?period=month 这类接口，内核收不到 period 就退回默认值 day，
 * 界面上表现为「切到按月/按年没反应，数字和按日一模一样」——而且不报任何错，
 * 极难排查。这里用真实 HTTP 服务器验证 request() 的行为。
 *
 * main.js 不能直接 require（它依赖 electron 模块），所以这里把其中的 request()
 * 抽出来单独跑：先断言源码里没有 `path: u.pathname` 这种写法，再对着一个
 * 本地服务器实测查询串确实到达了服务端。
 *
 * 用法：node scripts/test-request-url.js
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const MAIN = path.join(__dirname, '..', 'src', 'electron', 'main.js');
let failed = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const source = fs.readFileSync(MAIN, 'utf8');

// 1. 源码级：不允许出现丢弃查询串的写法
check(
  'request() 不再丢弃查询串',
  !/path:\s*u\.pathname\s*,/.test(source),
  '未发现 `path: u.pathname`',
);
check(
  'request() 显式拼接 u.search',
  /path:\s*u\.pathname\s*\+\s*u\.search/.test(source),
  '找到 `path: u.pathname + u.search`',
);

// 2. 行为级：用与 main.js 相同的写法打一次真实请求，确认服务端收到查询串
const seen = [];
const server = http.createServer((req, res) => {
  seen.push(req.url);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

function requestLikeMain(port, urlPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(`http://127.0.0.1:${port}` + urlPath);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', timeout: 5000 },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  try {
    const cases = [
      ['/admin/api/usage?period=day', '/admin/api/usage?period=day'],
      ['/admin/api/usage?period=month', '/admin/api/usage?period=month'],
      ['/admin/api/usage?period=year', '/admin/api/usage?period=year'],
      ['/admin/api/usage', '/admin/api/usage'],
    ];
    for (const [sent, expected] of cases) {
      const status = await requestLikeMain(port, sent);
      check(`服务端收到了 ${sent}`, status === 200 && seen.includes(expected), `实际收到 ${seen[seen.length - 1]}`);
    }
    // 编码后的值也要原样送达
    await requestLikeMain(port, '/admin/api/usage?period=' + encodeURIComponent('a b&c'));
    check(
      '特殊字符按 URL 编码送达',
      seen.includes('/admin/api/usage?period=a%20b%26c'),
      `实际收到 ${seen[seen.length - 1]}`,
    );
  } catch (err) {
    check('行为级验证', false, String(err.message || err));
  } finally {
    server.close();
  }

  console.log('');
  console.log(failed === 0 ? '全部通过：查询串不会再被丢掉。' : `${failed} 项未通过。`);
  process.exit(failed === 0 ? 0 : 1);
});
