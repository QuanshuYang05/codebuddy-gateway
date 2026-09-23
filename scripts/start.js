'use strict';

/**
 * 启动入口。
 *
 * 为什么不用 `electron .`：WorkBuddy / VS Code 一类 Electron 宿主会把
 * ELECTRON_RUN_AS_NODE=1 注入环境。带着这个变量启动 electron.exe，它会以纯 Node
 * 模式运行，require('electron') 返回 undefined，主进程第一行就崩，且因为它是
 * Windows GUI 子系统程序，错误不会打印到控制台，表现为"双击没反应"。
 *
 * 这里显式删掉该变量再启动。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const electronPath = require('electron'); // 非 Electron 环境下返回可执行文件路径

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [path.join(__dirname, '..')], {
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code === null ? 0 : code);
});
