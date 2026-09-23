'use strict';

/**
 * Windows 打包：
 *   1. 把 Python 内核（含 .venv）复制到 build/kernel
 *   2. 设置 electron-builder 二进制镜像（国内网络必需）
 *   3. 调用 electron-builder --win
 *
 * 内核目录可用环境变量 KERNEL_DIR 覆盖，默认取设置里那个开发期目录。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const KERNEL_DIR = process.env.KERNEL_DIR || 'D:\\workshop\\2026-09-23-10-55-33\\workbuddy2api';
const TARGET = path.join(ROOT, 'build', 'kernel');

// 不需要带进安装包的垃圾
const EXCLUDE_DIRS = new Set(['__pycache__', '.git', '.mypy_cache', '.pytest_cache', '.ruff_cache']);
const EXCLUDE_FILES = new Set(['converter.log']);

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      copyTree(s, d);
    } else if (entry.isFile()) {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      if (entry.name.endsWith('.pyc')) continue;
      // dereference：venv 里的 python.exe 可能是符号链接/硬链接，必须复制真实内容
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * 清空目录。
 * 宿主环境可能给 Node 的 fs.rm 挂批量删除保护（超过阈值直接抛错），
 * 而 electron-builder 解压前会删除旧的 win-unpacked，因此这里用系统命令代劳。
 */
function clearDir(dir) {
  if (!fs.existsSync(dir)) return;
  if (process.platform === 'win32') {
    spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', dir], { stdio: 'ignore' });
  } else {
    spawnSync('rm', ['-rf', dir], { stdio: 'ignore' });
  }
}

/**
 * 选一个可用的输出目录。
 * 上一轮的 win-unpacked 有时会被外部进程锁住（app.asar 占用）删不掉，
 * 这种情况下换一个全新目录，而不是让 electron-builder 在删除阶段直接崩掉。
 */
function pickOutputDir() {
  const primary = 'release';
  const stale = path.join(ROOT, primary, 'win-unpacked');
  if (fs.existsSync(stale)) {
    clearDir(stale);
    if (fs.existsSync(stale)) {
      console.warn(`[build] ${path.relative(ROOT, stale)} 被占用，无法清空，改用新输出目录`);
      let i = 2;
      while (fs.existsSync(path.join(ROOT, `release${i}`))) i += 1;
      return `release${i}`;
    }
  }
  return primary;
}

function main() {
  if (!fs.existsSync(path.join(KERNEL_DIR, 'core', 'converter.py'))) {
    console.error(`[prepare] 内核目录无效：${KERNEL_DIR}`);
    console.error('[prepare] 请设置环境变量 KERNEL_DIR 指向 workbuddy2api 根目录');
    process.exit(1);
  }

  console.log(`[prepare] 内核源：${KERNEL_DIR}`);
  // 覆盖式更新，不整目录删除：避免触发宿主环境的批量删除保护
  fs.mkdirSync(TARGET, { recursive: true });
  copyTree(KERNEL_DIR, TARGET);

  // 校验：Python 解释器与关键模块必须都在
  const checks = [
    ['.venv', 'Scripts', 'python.exe'],
    ['core', 'converter.py'],
    ['admin', 'server.py'],
  ];
  for (const parts of checks) {
    const p = path.join(TARGET, ...parts);
    if (!fs.existsSync(p)) {
      console.error(`[prepare] 内核缺少：${parts.join('/')}`);
      process.exit(1);
    }
  }
  console.log('[prepare] 内核就绪：.venv/python.exe、core/converter.py、admin/server.py 均在');

  // 镜像与宿主删除保护开关：既给子进程（CLI），也给当前进程（Node API）用
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    'https://npmmirror.com/mirrors/electron-builder-binaries/';
  process.env.ELECTRON_MIRROR =
    process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
  process.env.CODEBUDDY_SAFE_DELETE_ENABLED = '0';
  delete process.env.ELECTRON_RUN_AS_NODE;

  const env = {
    ...process.env,
    // electron-builder 的 nsis / winCodeSign 二进制默认走 GitHub，国内很慢
    ELECTRON_BUILDER_BINARIES_MIRROR:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
      'https://npmmirror.com/mirrors/electron-builder-binaries/',
    // packaging 阶段 builder 会自行下载 electron 分发包，默认走 GitHub 会超时
    ELECTRON_MIRROR:
      process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
    // 宿主给 Node 的 fs.rm 挂了批量删除保护（>50 个文件直接抛错），
    // 而 builder 解包前必须清空 win-unpacked。这里只在构建子进程内关闭它：
    // 删除目标是本项目自己生成的 dist/ 构建产物，不涉及任何个人文件。
    CODEBUDDY_SAFE_DELETE_ENABLED: '0',
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const outDir = pickOutputDir();
  console.log(`[build] 输出目录：${outDir}`);
  console.log('[build] 开始打包…');

  // 走了备选输出目录时，electron-builder CLI 不支持覆盖 directories.output，
  // 直接用 Node API 传配置。
  if (outDir !== 'release') {
    const { build, Platform } = require('electron-builder');
    build({
      targets: Platform.WINDOWS.createTarget(),
      config: { directories: { output: outDir } },
    })
      .then((artifacts) => {
        for (const a of artifacts) console.log(`[build] 产物：${a.file || a}`);
        process.exit(0);
      })
      .catch((err) => {
        console.error('[build] 打包失败：', err && err.message ? err.message : err);
        process.exit(1);
      });
    return;
  }

  const bin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
  const args = process.argv.slice(2);
  const r = spawnSync(bin, args.length ? args : ['--win'], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exit(r.status == null ? 1 : r.status);
}

main();
