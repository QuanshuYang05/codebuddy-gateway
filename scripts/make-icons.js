#!/usr/bin/env node
'use strict';

/**
 * 从 resources/icon.ico 生成 macOS / Linux 可用图标。
 *
 * 本仓库的图标源是 Windows ICO，里面最大只有 256x256。
 * macOS 推荐 1024x1024；GitHub Actions 在 macOS runner 上可用 sips/iconutil
 * 基于这张 256 PNG 再放大到 512/1024。这里先把 ICO 中的 PNG 条目拆出来，
 * 生成一个纯 JS 可写的 ICNS（支持 icp4/icp5/icp6/ic07/ic08 这些 PNG 类型）。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ICO_PATH = path.join(ROOT, 'resources', 'icon.ico');

function parseIcoEntries(buf) {
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const w = buf[o] === 0 ? 256 : buf[o];
    const h = buf[o + 1] === 0 ? 256 : buf[o + 1];
    const len = buf.readUInt32LE(o + 8);
    const off = buf.readUInt32LE(o + 12);
    const data = buf.subarray(off, off + len);
    // Windows Vista+ ICO 的高分辨率条目通常已经是完整 PNG 文件
    const isPng = data.subarray(0, 4).toString('hex') === '89504e47';
    if (isPng) entries.push({ w, h, data });
  }
  return entries;
}

function makeIcns(entries) {
  // 标准 ICNS PNG 类型（OS X 10.5+）
  const typeForSize = {
    16: 'icp4',
    32: 'icp5',
    64: 'icp6',
    128: 'ic07',
    256: 'ic08',
  };

  const parts = [];
  let total = 4 + 4; // header: magic + length

  for (const size of [16, 32, 64, 128, 256]) {
    const type = typeForSize[size];
    const entry = entries.find((e) => e.w === size || e.w >= size);
    if (!entry) continue;
    const partLen = 4 + 4 + entry.data.length;
    const part = Buffer.alloc(partLen);
    part.write(type, 0, 4, 'ascii');
    part.writeUInt32BE(partLen, 4);
    entry.data.copy(part, 8);
    parts.push(part);
    total += partLen;
  }

  const icns = Buffer.alloc(total);
  icns.write('icns', 0, 4, 'ascii');
  icns.writeUInt32BE(total, 4);
  let off = 8;
  for (const p of parts) {
    p.copy(icns, off);
    off += p.length;
  }
  return icns;
}

function main() {
  if (!fs.existsSync(ICO_PATH)) {
    console.error(`找不到 ${ICO_PATH}`);
    process.exit(1);
  }
  const ico = fs.readFileSync(ICO_PATH);
  const entries = parseIcoEntries(ico);
  console.log(`ICO 内 PNG 条目：${entries.map((e) => `${e.w}x${e.h}`).join(', ')}`);

  const entry256 = entries.find((e) => e.w === 256);
  if (!entry256) {
    console.error('ICO 里没有 256x256 PNG 条目，无法生成高清图标');
    process.exit(1);
  }

  const pngPath = path.join(ROOT, 'resources', 'icon-256.png');
  fs.writeFileSync(pngPath, entry256.data);
  console.log(`已生成 ${pngPath}`);

  const icnsPath = path.join(ROOT, 'resources', 'icon.icns');
  const icns = makeIcns(entries);
  fs.writeFileSync(icnsPath, icns);
  console.log(`已生成 ${icnsPath}（${icns.length} 字节）`);
}

main();
