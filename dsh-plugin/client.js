/**
 * Client 半：右by Sidebar 里的「中转网关」页签。
 *
 * 数据来自同源的 /codebuddy-gateway/status（Host 半注册的路由）——
 * 浏览器直接打这个地址，不经网关，所以没有 CORS 问题。
 *
 * 样式只用 --dsw-alias-* 主题变量，因此浅色/深色自动跟随宿主。
 * 不 import 任何 Harness Client 包（规范禁止），控件全部就地实现。
 */
window.__ModuleLoader__.load({
  id: '@quanshuyang05/codebuddy-gateway-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const ENDPOINT = '/codebuddy-gateway/status';
    const CONTROL = '/codebuddy-gateway/control';
    const ACTION = '/codebuddy-gateway/action';
    const DIAGNOSE = '/codebuddy-gateway/diagnose';
    const POLL_MS = 5000;

    // ---------------------------------------------------------------- 样式
    // 组件内联 style 元素：卸载时随组件一起消失，不留全局残留。
    const CSS = `
.gwp-root {
  display: flex; flex-direction: column; gap: 14px;
  padding: 14px; height: 100%; overflow-y: auto;
  font-family: var(--dsw-font-family);
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  box-sizing: border-box;
}
.gwp-head { display: flex; align-items: baseline; gap: 8px; justify-content: space-between; }
.gwp-title { font-size: var(--dsw-font-base-strong-16-font-size); font-weight: 600; }
.gwp-sub { font-size: var(--dsw-font-xxxs-11-font-size); color: var(--dsw-alias-label-tertiary); }
.gwp-dot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:6px;
  background: var(--dsw-alias-state-idle-primary); vertical-align: middle; }
.gwp-dot--on { background: var(--dsw-alias-state-success-primary); }
.gwp-dot--err { background: var(--dsw-alias-state-error-primary); }

.gwp-kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.gwp-kpi {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  padding: 9px 10px; min-width: 0;
}
.gwp-kpi-label { font-size: var(--dsw-font-xxxs-11-font-size); color: var(--dsw-alias-label-tertiary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gwp-kpi-value { font-size: var(--dsw-font-m-18-font-size); font-weight: 600; margin-top: 2px;
  font-variant-numeric: tabular-nums; }
.gwp-kpi-value--sm { font-size: var(--dsw-font-s-14-font-size); }

.gwp-section-title { font-size: var(--dsw-font-xs-strong-13-font-size); font-weight: 600;
  margin-bottom: 2px; display:flex; align-items:center; justify-content:space-between; }

.gwp-card {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  overflow: hidden;
}
.gwp-row { display:flex; align-items:center; gap:8px; padding:7px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); min-width:0; }
.gwp-row:last-child { border-bottom: none; }
.gwp-row-name { flex: 1 1 auto; min-width: 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font-size: var(--dsw-font-xs-13-font-size); }
.gwp-row-meta { font-size: var(--dsw-font-xxxs-11-font-size); color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }

.gwp-tag { font-size: var(--dsw-font-xxxs-11-font-size); padding: 1px 6px; border-radius: var(--dsw-radius-xs);
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary);
  white-space: nowrap; }
.gwp-tag--ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-secondary); }
.gwp-tag--warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-secondary); }
.gwp-tag--err { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-secondary); }

.gwp-chart { display:flex; align-items:flex-end; gap:2px; height:56px; padding:8px 10px 0; }
.gwp-bar { flex:1 1 0; min-width:0; background: var(--dsw-alias-brand-primary);
  border-radius: var(--dsw-radius-xs) var(--dsw-radius-xs) 0 0; opacity:.85; }

.gwp-seg { display:inline-flex; border:1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm); overflow:hidden; }
.gwp-seg-btn { appearance:none; border:none; background:transparent; cursor:pointer;
  color: var(--dsw-alias-label-secondary); font-family: inherit;
  font-size: var(--dsw-font-xxxs-11-font-size); padding:3px 9px; }
.gwp-seg-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.gwp-seg-btn--on { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary);
  font-weight: 600; }

.gwp-msg { font-size: var(--dsw-font-xs-13-font-size); color: var(--dsw-alias-label-tertiary);
  line-height: 1.6; padding: 10px 12px; border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); }
.gwp-msg--err { color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-secondary); }
.gwp-refresh { appearance:none; background:transparent; border:1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm); color: var(--dsw-alias-label-secondary); cursor:pointer;
  font-family: inherit; font-size: var(--dsw-font-xxxs-11-font-size); padding:3px 9px; }
.gwp-refresh:hover { background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary); }

.gwp-actions { display:flex; gap:6px; align-items:center; }
.gwp-btn { appearance:none; cursor:pointer; font-family:inherit; border-radius: var(--dsw-radius-sm);
  font-size: var(--dsw-font-xxxs-11-font-size); padding:4px 12px;
  border:1px solid var(--dsw-alias-border-l2); background:transparent;
  color: var(--dsw-alias-label-primary); }
.gwp-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.gwp-btn:disabled { opacity:.45; cursor:default; }
.gwp-btn--primary { background: var(--dsw-alias-button-primary-fill); border-color:transparent;
  color: var(--dsw-alias-label-primary-foreground); }
.gwp-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.gwp-btn--danger { color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-secondary); }
.gwp-btn--danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }

.gwp-note { font-size: var(--dsw-font-xxxs-11-font-size); border-radius: var(--dsw-radius-sm);
  padding:6px 9px; line-height:1.5; border:1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }
.gwp-note--ok { color: var(--dsw-alias-state-success-primary);
  border-color: var(--dsw-alias-state-success-secondary); }
.gwp-note--err { color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-secondary); }
.gwp-meta { font-size: var(--dsw-font-xxxs-11-font-size); color: var(--dsw-alias-label-tertiary);
  word-break: break-all; line-height:1.5; }
.gwp-code { font-family: var(--dsw-font-markdown-code-font-family, monospace);
  font-size: var(--dsw-font-xxxs-11-font-size); }

.gwp-mini { appearance:none; cursor:pointer; font-family:inherit; background:transparent;
  border:1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-xs);
  color: var(--dsw-alias-label-secondary); font-size: var(--dsw-font-xxxs-11-font-size);
  padding:2px 6px; white-space:nowrap; }
.gwp-mini:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary); }
.gwp-mini:disabled { opacity:.4; cursor:default; }
.gwp-mini--danger { color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-secondary); }
.gwp-mini--on { background: var(--dsw-alias-interactive-bg-active);
  color: var(--dsw-alias-label-primary); font-weight:600; }
.gwp-acc-actions { display:flex; gap:4px; flex:0 0 auto; }
.gwp-acc-main { flex:1 1 auto; min-width:0; }
.gwp-input { width:100%; box-sizing:border-box; font-family:inherit;
  font-size: var(--dsw-font-xs-13-font-size); padding:5px 8px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); }
.gwp-input:focus { outline:none; border-color: var(--dsw-alias-brand-primary); }
.gwp-field { display:flex; gap:6px; align-items:center; }
.gwp-steps { margin:0; padding-left:16px; font-size: var(--dsw-font-xxxs-11-font-size);
  color: var(--dsw-alias-label-secondary); line-height:1.7; }

.gwp-diag { display:grid; gap:6px; }
.gwp-diag-item { border:1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm); padding:7px 9px; background: var(--dsw-alias-bg-layer-1); }
.gwp-diag-item--bad { border-color: var(--dsw-alias-state-error-secondary); }
.gwp-diag-head { display:flex; align-items:center; gap:6px;
  font-size: var(--dsw-font-xs-13-font-size); }
.gwp-diag-mark { flex:0 0 auto; font-weight:700; width:12px; text-align:center; }
.gwp-diag-mark--ok { color: var(--dsw-alias-state-success-primary); }
.gwp-diag-mark--bad { color: var(--dsw-alias-state-error-primary); }
.gwp-diag-body { font-size: var(--dsw-font-xxxs-11-font-size);
  color: var(--dsw-alias-label-tertiary); line-height:1.6; margin-top:4px;
  word-break: break-all; }
.gwp-diag-fix { font-size: var(--dsw-font-xxxs-11-font-size); line-height:1.6;
  margin-top:4px; color: var(--dsw-alias-state-warn-primary); }
`;

    // ---------------------------------------------------------------- 工具
    const fmtInt = (n) =>
      typeof n === 'number' && isFinite(n) ? Math.round(n).toLocaleString('zh-CN') : '—';

    const fmtCompact = (n) => {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
      return String(Math.round(n));
    };

    const fmtDuration = (sec) => {
      if (typeof sec !== 'number' || !isFinite(sec)) return '—';
      const d = Math.floor(sec / 86400);
      const hh = Math.floor((sec % 86400) / 3600);
      const mm = Math.floor((sec % 3600) / 60);
      if (d) return `${d}d ${hh}h`;
      if (hh) return `${hh}h ${mm}m`;
      return `${mm}m`;
    };

    const fmtTime = (ts) => {
      if (!ts) return '—';
      const d = new Date(ts * 1000);
      return d.toLocaleTimeString('zh-CN', { hour12: false });
    };

    // ---------------------------------------------------------------- 控制
    /** 启停内核。控制接口在 Host 半，动作只有 start/stop/restart。 */
    function useKernelControl(reload) {
      const [busy, setBusy] = useState('');
      const [note, setNote] = useState(null); // { ok, text }

      const run = useCallback(async (action) => {
        setBusy(action);
        setNote(null);
        try {
          const res = await fetch(`${CONTROL}?action=${encodeURIComponent(action)}`, {
            method: 'POST',
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const r = await res.json();
          const label = { start: '启动', stop: '停止', restart: '重启' }[action] || action;
          setNote({
            ok: !!r.ok,
            text: r.ok
              ? (r.message || `${label}完成。`)
              : (r.error || `${label}失败。`),
          });
        } catch (err) {
          setNote({ ok: false, text: `请求失败：${err.message || err}` });
        } finally {
          setBusy('');
          // 内核状态变了，让面板重新取一次
          if (typeof reload === 'function') reload();
        }
      }, [reload]);

      return { busy, note, run, clearNote: () => setNote(null) };
    }

    /** 账号/签到等写操作。全部走 Host 半的白名单 action 路由。 */
    function useGatewayAction(reload) {
      const [busy, setBusy] = useState('');
      const [note, setNote] = useState(null); // { ok, text }

      const send = useCallback(async (payload, okText) => {
        setBusy(payload.action);
        setNote(null);
        try {
          const res = await fetch(ACTION, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            cache: 'no-store',
            body: JSON.stringify(payload),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const r = await res.json();
          setNote({ ok: !!r.ok, text: r.ok ? (okText || '完成。') : (r.error || '操作失败。') });
          return r;
        } catch (err) {
          setNote({ ok: false, text: `请求失败：${err.message || err}` });
          return { ok: false };
        } finally {
          setBusy('');
          if (typeof reload === 'function') reload();
        }
      }, [reload]);

      return { busy, note, send, setNote };
    }

    /** 体检：只在打开时取一次，不轮询。 */
    function useDiagnose() {
      const [state, setState] = useState({ phase: 'idle', data: null, error: '' });
      const load = useCallback(async () => {
        setState((s) => ({ ...s, phase: 'loading' }));
        try {
          const res = await fetch(DIAGNOSE, { cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const d = await res.json();
          setState({ phase: 'ready', data: d, error: '' });
        } catch (err) {
          setState({ phase: 'error', data: null, error: String(err.message || err) });
        }
      }, []);
      return { ...state, load };
    }

    // ---------------------------------------------------------------- 取数
    function useGatewayStatus(period) {
      const [state, setState] = useState({ phase: 'loading', data: null, error: '' });
      const alive = useRef(true);

      const load = useCallback(async () => {
        try {
          const res = await fetch(`${ENDPOINT}?period=${encodeURIComponent(period)}`, {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          });
          if (!res.ok) {
            // 404 = Host 半没加载。最常见的原因：插件是刚装的，
            // 而宿主进程启动得比安装早（HMR root 为空时无法热更新）。
            if (res.status === 404) {
              const e = new Error(
                'Host 半未加载（HTTP 404）。插件是刚安装的话，重启 dsh web 宿主即可生效。',
              );
              e.code = 'host-not-loaded';
              throw e;
            }
            throw new Error(`HTTP ${res.status}`);
          }
          const data = await res.json();
          if (!alive.current) return;
          if (data.ok) setState({ phase: 'ready', data, error: '' });
          else setState({ phase: 'error', data, error: data.error || '未知错误' });
        } catch (err) {
          if (!alive.current) return;
          setState((s) => ({
            phase: 'error',
            data: s.data,
            error: String(err.message || err),
            code: err.code || '',
          }));
        }
      }, [period]);

      useEffect(() => {
        alive.current = true;
        load();
        const id = setInterval(load, POLL_MS);
        return () => {
          alive.current = false;
          clearInterval(id);
        };
      }, [load]);

      return { ...state, reload: load };
    }

    // ---------------------------------------------------------------- 子组件
    function Kpi({ label, value, title, small }) {
      return h('div', { className: 'gwp-kpi', title: title || undefined },
        h('div', { className: 'gwp-kpi-label' }, label),
        h('div', { className: `gwp-kpi-value${small ? ' gwp-kpi-value--sm' : ''}` }, value));
    }

    function Sparkline({ buckets }) {
      if (!buckets || !buckets.length) return null;
      const max = Math.max(...buckets.map((b) => b.totalTokens || 0), 1);
      return h('div', { className: 'gwp-chart', role: 'img', 'aria-label': 'token 用量趋势' },
        buckets.map((b, i) =>
          h('div', {
            key: b.label || i,
            className: 'gwp-bar',
            style: { height: `${Math.max(2, ((b.totalTokens || 0) / max) * 100)}%` },
            title: `${b.label}：${fmtInt(b.totalTokens)} token（${b.requests} 次请求）`,
          })));
    }

    function AccountRow({ a, act, busy, onRemove }) {
      const healthy = a.enabled && !a.expired && a.poolState === 'available';
      const tag = a.expired ? ['已过期', 'err']
        : !a.enabled ? ['已停用', 'warn']
          : healthy ? ['可用', 'ok'] : ['受限', 'warn'];
      const pending = (name) => busy && busy.startsWith(name);

      return h('div', { className: 'gwp-row gwp-acc' },
        h('span', {
          className: `gwp-dot${a.active ? ' gwp-dot--on' : ''}`,
          title: a.active ? '当前消耗账号' : '',
        }),
        h('span', { className: 'gwp-acc-main', style: { minWidth: 0 } },
          h('div', { className: 'gwp-row-name', title: a.name },
            a.name,
            a.todayCheckedIn ? h('span', { className: 'gwp-tag gwp-tag--ok', style: { marginLeft: 6 } }, '已签到') : null,
            h('span', { className: `gwp-tag gwp-tag--${tag[1]}`, style: { marginLeft: 4 } }, tag[0])),
          h('div', { className: 'gwp-row-meta', style: { textAlign: 'left' } },
            a.remaining == null ? '余额同步中…' : `余额 ${a.remaining.toFixed(1)} 分`,
            a.requestCount ? ` · ${a.requestCount} 次` : '')),
        h('span', { className: 'gwp-acc-actions' },
          h('button', {
            className: `gwp-mini${a.active ? ' gwp-mini--on' : ''}`,
            type: 'button', disabled: !!busy || a.active,
            title: '把调度切到这个账号（并设为手动指定）',
            onClick: () => act({ action: 'account-use', id: a.id }, `已切换到 ${a.name}。`),
          }, a.active ? '当前' : '切换'),
          h('button', {
            className: 'gwp-mini', type: 'button', disabled: !!busy,
            title: '只给这个账号签到',
            onClick: () => act({ action: 'checkin-account', id: a.id }, `${a.name} 签到完成。`),
          }, pending('checkin-account') ? '…' : '签到'),
          h('button', {
            className: 'gwp-mini', type: 'button', disabled: !!busy,
            title: a.enabled ? '停用此账号' : '启用此账号',
            onClick: () => act(
              { action: 'account-toggle', id: a.id, enabled: !a.enabled },
              `${a.name} 已${a.enabled ? '停用' : '启用'}。`,
            ),
          }, a.enabled ? '停用' : '启用'),
          h('button', {
            className: 'gwp-mini gwp-mini--danger', type: 'button', disabled: !!busy,
            title: '删除此账号（凭据会移入内核 trash 目录）',
            onClick: () => onRemove(a),
          }, '删除')));
    }

    /** 新增账号：浏览器授权登录，或导入 .info 凭据 */
    function AddAccount({ act, busy, onClose }) {
      const [tab, setTab] = useState('oauth');
      const [name, setName] = useState('');
      const [fid, setFid] = useState('');
      const [url, setUrl] = useState('');
      const [state, setState] = useState('');
      const [cred, setCred] = useState('');

      // 拿到 fid 后每 3 秒轮询一次授权结果
      useEffect(() => {
        if (!fid) return undefined;
        let alive = true;
        const tick = async () => {
          const r = await act({ action: 'oauth-poll', fid }, '登录成功，账号已添加。');
          if (!alive) return;
          if (r.ok) {
            const s = r.data?.status || '';
            setState(s === 'success' ? '成功' : s === 'expired' ? '链接已过期' : '等待授权…');
            if (s === 'success' || s === 'expired') {
              setFid('');
              setUrl('');
              if (s === 'success') onClose();
            }
          }
        };
        const id = setInterval(tick, 3000);
        tick();
        return () => { alive = false; clearInterval(id); };
      }, [fid]);

      const start = async () => {
        const r = await act({ action: 'oauth-start', name: name.trim() || undefined }, '已打开授权页。');
        if (r.ok && r.data?.url) {
          setUrl(r.data.url);
          setFid(r.data.fid || r.data.id || '');
          setState('等待授权…');
          // 复用系统浏览器，用户已有的 CodeBuddy 会话可直接用
          try { window.open(r.data.url, '_blank', 'noopener'); } catch { /* 被拦就手动点 */ }
        } else if (r.ok) {
          setState('内核没有返回授权链接，请查看内核版本。');
        }
      };

      const cancel = async () => {
        if (fid) await act({ action: 'oauth-cancel', fid }, '已取消。');
        setFid(''); setUrl(''); setState('');
      };

      const importCred = async () => {
        let doc;
        try {
          doc = JSON.parse(cred);
        } catch {
          setState('这段内容不是合法 JSON。');
          return;
        }
        const r = await act(
          { action: 'add-credential', credential: doc, name: name.trim() || undefined },
          '凭据已导入。',
        );
        if (r.ok) onClose();
        else setState(r.error || '导入失败。');
      };

      return h('div', { className: 'gwp-card', style: { padding: 10, display: 'grid', gap: 8 } },
        h('div', { className: 'gwp-field' },
          h('button', {
            className: `gwp-mini${tab === 'oauth' ? ' gwp-mini--on' : ''}`,
            type: 'button', onClick: () => setTab('oauth'),
          }, '浏览器登录'),
          h('button', {
            className: `gwp-mini${tab === 'import' ? ' gwp-mini--on' : ''}`,
            type: 'button', onClick: () => setTab('import'),
          }, '导入凭据'),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'gwp-mini', type: 'button', onClick: onClose }, '收起')),

        h('input', {
          className: 'gwp-input', type: 'text', value: name,
          placeholder: '账号备注名（可留空）',
          onChange: (e) => setName(e.target.value),
        }),

        tab === 'oauth'
          ? h('div', { style: { display: 'grid', gap: 6 } },
            h('button', {
              className: 'gwp-btn gwp-btn--primary', type: 'button',
              disabled: !!busy || !!fid, onClick: start,
            }, fid ? '等待授权…' : '打开授权页'),
            url
              ? h('div', null,
                h('ol', { className: 'gwp-steps' },
                  h('li', null, '已在浏览器打开授权页，完成登录即可。'),
                  h('li', null, '本面板每 3 秒自动检查一次，成功后会自动添加。'),
                  h('li', null, '链接 5 分钟过期。'),
                  h('li', null,
                    '没自动打开？',
                    h('a', {
                      href: url, target: '_blank', rel: 'noopener noreferrer',
                      style: { color: 'var(--dsw-alias-link)' },
                    }, '点这里'))),
                h('button', { className: 'gwp-mini', type: 'button', onClick: cancel }, '取消'))
              : h('div', { className: 'gwp-meta' },
                '走系统浏览器完成一次 CodeBuddy 授权，复用你已有的登录态。'),
            state ? h('div', { className: 'gwp-meta' }, state) : null)
          : h('div', { style: { display: 'grid', gap: 6 } },
            h('textarea', {
              className: 'gwp-input', rows: 4, value: cred,
              placeholder: '粘贴 .info 文件的内容（JSON）',
              style: { resize: 'vertical', fontFamily: 'inherit' },
              onChange: (e) => setCred(e.target.value),
            }),
            h('button', {
              className: 'gwp-btn', type: 'button',
              disabled: !!busy || !cred.trim(), onClick: importCred,
            }, '导入'),
            h('div', { className: 'gwp-meta' },
              '注意：新版桌面端的令牌是加密存储的，内核只认明文。'
              + '若报「凭据缺少 accessToken」，请改用同目录下带时间戳的备份 .info 文件。'),
            state ? h('div', { className: 'gwp-meta' }, state) : null));
    }

    /** 体检区块：逐项显示依赖状态与修复建议 */
    function DiagnoseBlock({ open, onToggle, diag }) {
      if (!open) return null;
      return h('div', { className: 'gwp-card', style: { padding: 10, display: 'grid', gap: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { fontSize: 'var(--dsw-font-xs-strong-13-font-size)', fontWeight: 600 } }, '依赖体检'),
          h('span', { className: 'gwp-sub', style: { flex: 1 } },
            diag.phase === 'loading' ? '检查中…'
              : diag.phase === 'error' ? `检查失败：${diag.error}`
                : (diag.data?.summary || '')),
          h('button', { className: 'gwp-mini', type: 'button', onClick: diag.load }, '重新检查'),
          h('button', { className: 'gwp-mini', type: 'button', onClick: onToggle }, '收起')),

        diag.data?.items?.length
          ? h('div', { className: 'gwp-diag' },
            diag.data.items.map((it) =>
              h('div', {
                key: it.id,
                className: `gwp-diag-item${it.ok ? '' : ' gwp-diag-item--bad'}`,
              },
                h('div', { className: 'gwp-diag-head' },
                  h('span', {
                    className: `gwp-diag-mark ${it.ok ? 'gwp-diag-mark--ok' : 'gwp-diag-mark--bad'}`,
                  }, it.ok ? '✓' : '✗'),
                  h('span', null, it.label)),
                h('div', { className: 'gwp-diag-body' }, it.detail),
                it.fix ? h('div', { className: 'gwp-diag-fix' }, `怎么办：${it.fix}`) : null,
                it.searched?.length
                  ? h('div', { className: 'gwp-diag-body' },
                    `搜过：${it.searched.join('  |  ')}`)
                  : null)))
          : null,

        diag.data
          ? h('div', { className: 'gwp-meta' },
            `平台 ${diag.data.platform} · Node ${diag.data.node}`)
          : null);
    }

    // ---------------------------------------------------------------- 主体
    function Panel() {
      const [period, setPeriod] = useState('day');
      const [showAdd, setShowAdd] = useState(false);
      const [showDiag, setShowDiag] = useState(false);
      const { phase, data, error, reload } = useGatewayStatus(period);
      const { busy: kernelBusy, note: kernelNote, run } = useKernelControl(reload);
      const { busy: actBusy, note: actNote, send: act, setNote: setActNote } = useGatewayAction(reload);
      const diag = useDiagnose();

      useEffect(() => {
        const el = document.createElement('style');
        el.setAttribute('data-gwp', '1');
        el.textContent = CSS;
        document.head.appendChild(el);
        return () => { el.remove(); };
      }, []);

      const ov = data?.overview;
      const usage = data?.usage;
      const online = Boolean(data?.ok);
      const running = Boolean(data?.running);
      const managed = Boolean(data?.managed);
      const runtimeRoot = data?.runtime?.root || null;

      const header = h('div', { className: 'gwp-head' },
        h('div', null,
          h('div', { className: 'gwp-title' },
            h('span', {
              className: `gwp-dot${online ? ' gwp-dot--on' : running ? ' gwp-dot--on' : ' gwp-dot--err'}`,
            }),
            '中转网关'),
          h('div', { className: 'gwp-sub' },
            data?.endpoint
              ? `${data.endpoint} · ${online ? '已连接' : running ? '运行中' : '未运行'}`
              : (phase === 'error' && !data ? 'Host 半未加载' : '读取中'))),
        h('button', {
          className: 'gwp-refresh', type: 'button', onClick: reload, title: '立即刷新',
        }, '刷新'),
        h('button', {
          className: 'gwp-refresh', type: 'button',
          title: '检查依赖是否齐全',
          onClick: () => {
            const next = !showDiag;
            setShowDiag(next);
            if (next && diag.phase === 'idle') diag.load();
          },
        }, showDiag ? '收起体检' : '体检'));

      const diagBlock = h(DiagnoseBlock, {
        open: showDiag, onToggle: () => setShowDiag(false), diag,
      });

      // 控制条：无论内核在与不在都要能操作
      const controls = h('div', { className: 'gwp-actions' },
        h('button', {
          className: 'gwp-btn gwp-btn--primary',
          type: 'button',
          disabled: running || !!kernelBusy,
          onClick: () => run('start'),
        }, kernelBusy === 'start' ? '启动中…' : '启动'),
        h('button', {
          className: 'gwp-btn',
          type: 'button',
          disabled: !running || !!kernelBusy,
          onClick: () => run('restart'),
        }, kernelBusy === 'restart' ? '重启中…' : '重启'),
        h('button', {
          className: 'gwp-btn gwp-btn--danger',
          type: 'button',
          disabled: !running || !!kernelBusy,
          onClick: () => run('stop'),
        }, kernelBusy === 'stop' ? '停止中…' : '停止'));

      const noteEl = kernelNote
        ? h('div', { className: `gwp-note ${kernelNote.ok ? 'gwp-note--ok' : 'gwp-note--err'}` },
          kernelNote.text)
        : null;
      const actNoteEl = actNote
        ? h('div', { className: `gwp-note ${actNote.ok ? 'gwp-note--ok' : 'gwp-note--err'}` },
          actNote.text)
        : null;

      if (phase === 'loading' && !data) {
        return h('div', { className: 'gwp-root' },
          h('div', { className: 'gwp-msg' }, '正在读取网关状态…'));
      }

      // 内核没跑：给出可操作的启动界面，而不是一句"连不上"
      if (!running) {
        return h('div', { className: 'gwp-root' },
          header,
          controls,
          noteEl,
          diagBlock,
          h('div', { className: 'gwp-msg' },
            '内核当前没有运行。点上面的「启动」即可在本机把它拉起来'
            + '（用随网关附带的独立 Python，不需要那个桌面窗口）。',
            runtimeRoot
              ? h('div', { className: 'gwp-meta', style: { marginTop: 8 } },
                '运行时：', h('span', { className: 'gwp-code' }, runtimeRoot))
              : h('div', { className: 'gwp-meta', style: { marginTop: 8 } },
                '没有找到网关运行时 —— 点上面的「体检」看差哪一项。')));
      }

      // 内核在跑但取不到数（比如是别的进程启动的）
      if (!online) {
        return h('div', { className: 'gwp-root' },
          header,
          controls,
          noteEl,
          diagBlock,
          h('div', { className: 'gwp-msg gwp-msg--err' },
            error || '内核在运行，但读取失败',
            !managed ? h('div', { className: 'gwp-meta', style: { marginTop: 6 } },
              '这个内核不是本面板启动的，因此无法从这里停止它。') : null,
            data?.configDir ? h('div', { className: 'gwp-meta', style: { marginTop: 6 } },
              '配置目录：', h('span', { className: 'gwp-code' }, data.configDir)) : null));
      }

      const k = ov.kpi;
      const rate = k.successRate;
      const rateColor = rate == null ? undefined
        : rate >= 95 ? 'var(--dsw-alias-state-success-primary)'
          : rate >= 80 ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-state-error-primary)';

      return h('div', { className: 'gwp-root' },
        header,
        controls,
        noteEl,
        diagBlock,

        h('div', { className: 'gwp-kpis' },
          h(Kpi, {
            label: '在途 / 完成',
            value: `${k.inFlight} / ${k.completed}`,
            title: `本次运行累计，重启内核清零`,
            small: false,
          }),
          h('div', { className: 'gwp-kpi' },
            h('div', { className: 'gwp-kpi-label' }, '成功率'),
            h('div', {
              className: 'gwp-kpi-value',
              style: rateColor ? { color: rateColor } : undefined,
            }, rate == null ? '—' : `${rate}%`)),
          h(Kpi, {
            label: '平均耗时', value: k.avgDurationMs == null ? '—' : `${fmtInt(k.avgDurationMs)} ms`,
          }),
          h(Kpi, {
            label: '累计 Token', value: fmtCompact(k.totalTokens),
            title: k.unmetered ? `其中 ${k.unmetered} 笔未取到用量` : '本次运行内累计',
          })),

        h('div', null,
          h('div', { className: 'gwp-section-title' },
            h('span', null, '用量'),
            h('span', { className: 'gwp-seg' },
              [['day', '日'], ['month', '月'], ['year', '年']].map(([v, label]) =>
                h('button', {
                  key: v, type: 'button',
                  className: `gwp-seg-btn${period === v ? ' gwp-seg-btn--on' : ''}`,
                  onClick: () => setPeriod(v),
                }, label)))),
          h('div', { className: 'gwp-card', style: { marginTop: 6 } },
            usage && usage.buckets.length
              ? h('div', { style: { padding: '8px 10px 2px' } },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 'var(--dsw-font-xxxs-11-font-size)', color: 'var(--dsw-alias-label-tertiary)' } },
                  h('span', null, `Token ${fmtCompact(usage.totals.totalTokens)}`),
                  h('span', null, `积分 ${usage.totals.creditsUsed.toFixed(2)}`)),
                h(Sparkline, { buckets: usage.buckets }))
              : h('div', { className: 'gwp-msg', style: { border: 'none', background: 'transparent' } },
                '当前内核不支持用量统计（缺 /admin/api/usage）。'))),

        h('div', null,
          h('div', { className: 'gwp-section-title' },
            h('span', null, `账号池 · ${ov.accounts.length}`),
            h('span', { className: 'gwp-sub' },
              `${ov.pool.routing === 'manual' ? '手动指定' : '轮询分摊'}`
              + (ov.pool.autoCheckin ? ` · 自动签到 ${ov.pool.checkinTime}` : ''))),

          // 账号操作条
          h('div', { className: 'gwp-actions', style: { marginTop: 6 } },
            h('button', {
              className: 'gwp-btn gwp-btn--primary', type: 'button',
              disabled: !!actBusy,
              title: '对账号池里所有启用账号执行一次签到',
              onClick: () => act({ action: 'checkin' }, '签到完成。'),
            }, actBusy === 'checkin' ? '签到中…' : '立即签到（全部）'),
            h('button', {
              className: 'gwp-btn', type: 'button',
              disabled: !!actBusy, onClick: () => setShowAdd((v) => !v),
            }, showAdd ? '收起' : '添加账号')),

          actNoteEl,

          showAdd
            ? h(AddAccount, {
              act, busy: actBusy,
              onClose: () => setShowAdd(false),
            })
            : null,

          h('div', { className: 'gwp-card', style: { marginTop: 6 } },
            ov.accounts.length
              ? ov.accounts.map((a) => h(AccountRow, {
                key: a.id, a, act, busy: actBusy,
                onRemove: (acc) => {
                  // 删除不可逆（凭据移入 trash），先确认一次
                  if (window.confirm(`确定删除账号「${acc.name}」？\n凭据会移入内核的 trash 目录。`)) {
                    act({ action: 'account-remove', id: acc.id }, `已删除 ${acc.name}。`);
                  }
                },
              }))
              : h('div', { className: 'gwp-row' },
                h('span', { className: 'gwp-row-name' }, '账号池为空，点上面「添加账号」')))),

        h('div', null,
          h('div', { className: 'gwp-section-title' },
            h('span', null, '最近请求'),
            h('span', { className: 'gwp-sub' },
              `模型 ${ov.modelCount} · 密钥 ${ov.keyCount} · 运行 ${fmtDuration(ov.uptime)}`)),
          h('div', { className: 'gwp-card', style: { marginTop: 6 } },
            ov.recent.length
              ? ov.recent.map((e, i) =>
                h('div', { key: `${e.time}-${i}`, className: 'gwp-row' },
                  h('span', { className: `gwp-dot${e.ok ? ' gwp-dot--on' : ' gwp-dot--err'}` }),
                  h('span', { className: 'gwp-row-name' }, e.path),
                  h('span', { className: 'gwp-row-meta' },
                    `${e.status} · ${e.durationMs}ms · ${fmtTime(e.time)}`)))
              : h('div', { className: 'gwp-row' },
                h('span', { className: 'gwp-row-name' }, '暂无请求')))));
    }

    const TITLE_CSS = `
.gwp-chip { display:inline-flex; align-items:center; gap:6px; min-width:0; }
.gwp-chip-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gwp-chip-dot { width:6px; height:6px; border-radius:50%; flex:0 0 auto;
  background: var(--dsw-alias-state-idle-primary); }
.gwp-chip-dot--on { background: var(--dsw-alias-state-success-primary); }
`;

    /** 页签 chip：带一个在线状态点 */
    function GatewayTitle() {
      const [online, setOnline] = useState(null);

      useEffect(() => {
        let alive = true;
        const check = async () => {
          try {
            const res = await fetch(`${ENDPOINT}?period=day`, { cache: 'no-store' });
            const d = await res.json();
            if (alive) setOnline(Boolean(d?.ok));
          } catch {
            if (alive) setOnline(false);
          }
        };
        check();
        const id = setInterval(check, 15000);
        return () => { alive = false; clearInterval(id); };
      }, []);

      useEffect(() => {
        const el = document.createElement('style');
        el.setAttribute('data-gwp-chip', '1');
        el.textContent = TITLE_CSS;
        document.head.appendChild(el);
        return () => { el.remove(); };
      }, []);

      return h('span', { className: 'gwp-chip' },
        h('span', {
          className: `gwp-chip-dot${online ? ' gwp-chip-dot--on' : ''}`,
          title: online === null ? '状态未知' : online ? '网关运行中' : '网关未运行',
        }),
        h('span', { className: 'gwp-chip-label' }, '中转网关'));
    }

    const PKG = '@quanshuyang05/codebuddy-gateway-panel';

    return {
      inject: ['sidebarRightTabs', 'slots'],
      apply(ctx) {
        // 注册一个页签类型；kind 是 openTab 用的判别名，id 是它自己的身份。
        // 关键点：sidebar.right.pane.tab 是 keyed 槽，键就是这里的 id。
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: PKG,
          kind: 'codebuddy-gateway',
          title: () => '中转网关',
          guide: [{
            id: 'codebuddy-gateway',
            order: 40,
            title: () => '中转网关',
            description: () => '查看中转网关的 KPI、账号池与用量',
          }],
        }));

        ctx.effect(() =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({
              name: 'sidebar.right.pane.tab',
              key: PKG,
            }, Panel)));

        ctx.effect(() =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({
              name: 'sidebar.right.pane.tab.title',
              key: PKG,
            }, GatewayTitle)));
      },
    };
  },
});
