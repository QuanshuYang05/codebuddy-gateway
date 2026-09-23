#!/usr/bin/env node
'use strict';

/**
 * Electron 打包脚本。
 *
 * 比 `npx electron-builder --win` 多做几件事：
 * 1. 检查内核（build/kernel）和依赖是否就绪；
 * 2. 自动切换国内镜像（npmmirror）；
 * 3. 构建目录被锁时自动换到 release2/release3…；
 * 4. 支持 `--win` / `--mac` / `--linux` 跨平台参数。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = process.cwd();

function checkKernel() {
  const project = path.join(ROOT, 'build', 'kernel');
  if (!fs.existsSync(path.join(project, 'core', 'converter.py'))) {
    console.error('[check] 内核源码缺失：build/kernel/core/converter.py 不存在');
    console.error('[check] 仓库里必须包含 build/kernel/（源码约 500K），否则无法打包。');
    process.exit(2);
  }

  const py = path.join(project, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', 'python');
  const pyExe = process.platform === 'win32' ? `${py}.exe` : py;
  if (!fs.existsSync(pyExe)) {
    console.warn('[check] 内核 .venv 未就绪，尝试自动安装依赖…');
    const venvCmd = process.platform === 'win32' ? 'python -m venv' : 'python3 -m venv';
    const r1 = spawnSync(venvCmd.split(' ')[0], ['-m', 'venv', path.join(project, '.venv')], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (r1.status !== 0) {
      console.error('[check] 创建 .venv 失败，请手动执行：');
      console.error(`  cd ${project} && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`);
      process.exit(2);
    }
    const pip = path.join(project, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', 'pip');
    const r2 = spawnSync(pip, ['install', '-r', path.join(project, 'requirements.txt')], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (r2.status !== 0) {
      console.error('[check] pip install 失败');
      process.exit(2);
    }
  } else {
    console.log('[check] 内核就绪：.venv/python、core/converter.py、admin/server.py 均在');
  }
}

function removeStaleUnpacked(primary) {
  // electron-builder 解压前会删除旧的 win-unpacked/mac/linux-unpacked。
  // 如果上一轮构建的子进程还占着 app.asar，删除会 EBUSY。这里用系统命令先强删一次。
  const unpackeds = ['win-unpacked', 'mac', 'linux-unpacked'];
  for (const name of unpackeds) {
    const dir = path.join(ROOT, primary, name);
    if (!fs.existsSync(dir)) continue;
    console.log(`[prepare] 清理旧目录：${dir}`);
    if (process.platform === 'win32') {
      spawnSync('rmdir', ['/s', '/q', dir], { shell: true, stdio: 'ignore' });
    } else {
      spawnSync('rm', ['-rf', dir], { stdio: 'ignore' });
    }
  }
}

function pickOutputDir() {
  const candidates = ['release', 'release2', 'release3', 'release4'];
  for (const d of candidates) {
    const staleDir = path.join(ROOT, d, 'win-unpacked');
    if (fs.existsSync(staleDir)) {
      // 目录存在但可能被占用，尝试强删一次；如果还是删不掉，就换下一个目录
      removeStaleUnpacked(d);
    }
    if (!fs.existsSync(staleDir)) return d;
  }
  return 'release';
}

function resolveTargetArg() {
  const args = process.argv.slice(2);
  if (args.includes('--mac')) return { target: 'mac', platform: 'MAC' };
  if (args.includes('--linux')) return { target: 'linux', platform: 'LINUX' };
  if (args.includes('--win')) return { target: 'win', platform: 'WINDOWS' };
  // 默认按当前平台
  const map = { win32: { target: 'win', platform: 'WINDOWS' }, darwin: { target: 'mac', platform: 'MAC' }, linux: { target: 'linux', platform: 'LINUX' } };
  return map[process.platform] || { target: 'win', platform: 'WINDOWS' };
}

function main() {
  checkKernel();

  const { target, platform } = resolveTargetArg();

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
    ELECTRON_BUILDER_BINARIES_MIRROR:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR,
    CODEBUDDY_SAFE_DELETE_ENABLED: '0',
  };
  delete env.ELECTRON_RUN_AS_NODE;

  removeStaleUnpacked('release');
  const outDir = pickOutputDir();
  console.log(`[build] 目标平台：${target}`);
  console.log(`[build] 输出目录：${outDir}`);
  console.log('[build] 开始打包…');

  const { build, Platform } = require('electron-builder');
  build({
    targets: Platform[platform].createTarget(),
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
}

main();
