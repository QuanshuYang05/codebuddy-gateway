'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gw', {
  status: () => ipcRenderer.invoke('gw:status'),
  logs: () => ipcRenderer.invoke('gw:logs'),
  overview: () => ipcRenderer.invoke('gw:overview'),
  config: () => ipcRenderer.invoke('gw:config'),
  saveConfig: (next) => ipcRenderer.invoke('gw:config:save', next),
  start: () => ipcRenderer.invoke('gw:start'),
  stop: () => ipcRenderer.invoke('gw:stop'),
  restart: () => ipcRenderer.invoke('gw:restart'),
  pickProject: () => ipcRenderer.invoke('gw:pick-project'),
  openDir: (p) => ipcRenderer.invoke('gw:open-dir', p),
  // 每日签到 / 积分
  checkin: () => ipcRenderer.invoke('gw:checkin'),
  checkinAccount: (aid) => ipcRenderer.invoke('gw:checkin-account', aid),
  poolSettings: (patch) => ipcRenderer.invoke('gw:pool-settings', patch),
  // 多账号：登录 / 切换 / 签到
  oauthStart: (name) => ipcRenderer.invoke('gw:oauth:start', name),
  oauthPoll: (fid) => ipcRenderer.invoke('gw:oauth:poll', fid),
  oauthCancel: (fid) => ipcRenderer.invoke('gw:oauth:cancel', fid),
  addAccount: (input) => ipcRenderer.invoke('gw:accounts:add', input),
  useAccount: (aid) => ipcRenderer.invoke('gw:accounts:use', aid),
  updateAccount: (input) => ipcRenderer.invoke('gw:accounts:update', input),
  removeAccount: (aid) => ipcRenderer.invoke('gw:accounts:remove', aid),
  accountAction: (input) => ipcRenderer.invoke('gw:accounts:action', input),
  pickCredential: () => ipcRenderer.invoke('gw:pick-credential'),
  createKey: () => ipcRenderer.invoke('gw:keys:create'),
  onCheckinResult: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('gw:checkin-result', handler);
    return () => ipcRenderer.removeListener('gw:checkin-result', handler);
  },
  onStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('gw:status', handler);
    return () => ipcRenderer.removeListener('gw:status', handler);
  },
});
