// Applications and their api/admin keys: create, rename, enable/disable, rotate, revoke.
// Plaintext key material is shown exactly once, at creation or rotation, and is never
// re-fetched from the server afterwards.

import { el, clear, badge, time, toast, errorBox, table } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { listState, withQuery, pager, load, messageOf, cellText } from './common.js';

function secretReveal(title, entries) {
  const reveal = el('div', { class: 'secret-reveal' },
    el('p', { class: 'small', text: `${title}（仅显示一次，请立即复制保存；关闭后无法再次查看）` }));
  for (const [label, value] of entries) {
    reveal.append(el('p', { class: 'small muted', text: label }));
    reveal.append(el('code', { class: 'otp', text: value }));
  }
  const copy = el('button', { type: 'button', class: 'button small',
    text: '复制全部',
    onclick: async () => {
      const text = entries.map(([label, value]) => `${label}\t${value}`).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        toast('已复制到剪贴板', 'ok');
      } catch {
        toast('复制失败，请手动选择文本', 'error');
      }
    } });
  reveal.append(el('div', { class: 'actions' }, copy));
  return reveal;
}

function createForm(onCreated) {
  const appId = el('input', { name: 'appId', required: true, maxlength: '64', pattern: '[A-Za-z0-9_-]+',
    placeholder: '例如 qflistudio' });
  const name = el('input', { name: 'name', maxlength: '128', placeholder: '可选，便于识别的名称' });
  const note = el('input', { name: 'note', maxlength: '500', placeholder: '可选备注' });
  const submit = el('button', { type: 'submit', class: 'button primary', text: '创建应用并签发密钥' });
  const feedback = el('div');
  const form = el('form', { class: 'stack', novalidate: true },
    el('div', { class: 'inline' },
      el('label', { class: 'grow' }, el('span', { text: '应用 ID（appId）' }), appId),
      el('label', { class: 'grow' }, el('span', { text: '名称' }), name),
      el('label', { class: 'grow' }, el('span', { text: '备注' }), note)),
    feedback,
    el('div', { class: 'actions' }, submit));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    clear(feedback);
    submit.disabled = true;
    try {
      const result = await api.createApp({ appId: appId.value.trim(), name: name.value.trim() || undefined,
        note: note.value.trim() || undefined });
      form.reset();
      onCreated(result);
    } catch (error) {
      feedback.append(errorBox(messageOf(error)));
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

function enableForm(app, done) {
  const input = el('input', { value: app.appId, maxlength: '64', required: true });
  const submit = el('button', { type: 'submit', class: 'button primary', text: '启用' });
  const form = el('form', { class: 'stack', novalidate: true },
    el('p', { class: 'small muted', text: '启用前会重新校验 appId 的可用性，被拒绝时不会恢复访问。' }),
    el('label', {}, el('span', { text: '确认应用 ID' }), input),
    el('div', { class: 'actions' }, submit,
      el('button', { type: 'button', class: 'button', text: '取消', onclick: () => done() })));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await api.setAppEnabled(app.id ?? app.appId, true, { confirmAppId: input.value.trim() });
      toast('应用已启用', 'ok');
      done();
    } catch (error) {
      toast(messageOf(error), 'error');
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

export async function appsView(main, { query }) {
  const state = listState(query, { q: '' });
  await load(main, async container => {
    clear(container);
    const search = el('input', { value: state.q ?? '', placeholder: '按 appId 或名称搜索' });
    const searchForm = el('form', { class: 'inline', role: 'search' },
      el('label', { class: 'grow' }, el('span', { text: '搜索' }), search),
      el('button', { type: 'submit', class: 'button', text: '查找' }));
    searchForm.addEventListener('submit', event => {
      event.preventDefault();
      navigate(withQuery('/apps', { ...state, q: search.value.trim(), offset: 0 }));
    });

    const listResult = await api.listApps({ limit: state.limit, offset: state.offset, q: state.q });
    const items = listResult.items ?? [];
    const reveal = el('div');
    container.append(
      el('h1', { text: '应用与密钥' }),
      el('p', { class: 'lede', text: '每个应用拥有独立词库与规则。apiKey 用于业务调用，adminKey 用于该应用的管理接口。' }),
      el('section', { class: 'card' }, el('h2', { text: '接入新应用' }),
        createForm(result => {
          clear(reveal);
          const secrets = [];
          if (result?.apiKey) secrets.push(['apiKey', result.apiKey]);
          if (result?.adminKey) secrets.push(['adminKey', result.adminKey]);
          if (secrets.length === 0) {
            toast('应用已创建，但响应中没有返回密钥，请检查接口契约', 'error');
            return;
          }
          reveal.append(secretReveal(`应用 ${result.appId ?? ''} 的密钥`, secrets),
            el('div', { class: 'actions' },
              el('button', { type: 'button', class: 'button primary', text: '我已保存，刷新列表',
                onclick: () => navigate(withQuery('/apps', { ...state, offset: 0 })) })));
          reveal.scrollIntoView({ block: 'nearest' });
        }),
        reveal),
      el('section', { class: 'card' }, searchForm,
        table([
          { label: '应用', render: row => el('span', { class: 'mono', text: cellText(row.appId) }) },
          { label: '名称', render: row => cellText(row.name) },
          { label: '状态', render: row => row.enabled === false ? badge('已停用', 'bad') : badge('启用中', 'ok') },
          { label: '密钥', render: row => keyCells(row) },
          { label: '更新时间', render: row => time(row.updatedAt) },
          { label: '操作', render: row => appActions(row, state) }
        ], items, { empty: '还没有应用' }),
        pager(listResult, offset => navigate(withQuery('/apps', { ...state, offset }))))
    );
    return container;
  });
}

function keyCells(row) {
  const keys = Array.isArray(row.keys) ? row.keys : [];
  if (keys.length === 0) return el('span', { class: 'muted small', text: '—' });
  const list = el('div', { class: 'stack small' });
  for (const key of keys) {
    const label = key.kind === 'admin' ? 'adminKey' : 'apiKey';
    const bits = [
      el('span', { class: 'mono', text: `${label} ${key.prefix ? key.prefix + '…' : ''}` }),
      key.revokedAt ? badge('已吊销', 'bad') : key.graceUntil ? badge('轮换宽限中', 'warn') : badge('有效', 'ok')
    ];
    const line = el('div', {}, ...bits);
    list.append(el('div', {}, line,
      el('span', { class: 'muted', text: [key.createdAt ? `签发 ${key.createdAt.slice(0, 10)}` : '',
        key.graceUntil ? `宽限至 ${key.graceUntil.slice(0, 10)}` : ''].filter(Boolean).join(' · ') })));
  }
  return list;
}

function appActions(row, state) {
  const id = row.id ?? row.appId;
  const actions = el('div', { class: 'actions' });
  const enabled = row.enabled !== false;
  actions.append(el('button', { type: 'button', class: 'button small', text: '轮换 apiKey',
    onclick: () => rotate(id, 'api', state) }));
  actions.append(el('button', { type: 'button', class: 'button small', text: '轮换 adminKey',
    onclick: () => rotate(id, 'admin', state) }));
  if (enabled) {
    actions.append(el('button', { type: 'button', class: 'button small danger', text: '停用',
      onclick: async () => {
        if (!window.confirm(`停用应用 ${row.appId}？停用后该应用的所有请求立即被拒绝。`)) return;
        try {
          await api.setAppEnabled(id, false, { reason: 'disabled in admin UI' });
          toast('应用已停用', 'ok');
          navigate(withQuery('/apps', state), { replace: true });
        } catch (error) { toast(messageOf(error), 'error'); }
      } }));
  } else {
    actions.append(el('button', { type: 'button', class: 'button small', text: '启用',
      onclick: () => {
        const dialog = el('dialog', { open: true }, enableForm(row, () => { dialog.close(); navigate(withQuery('/apps', state), { replace: true }); }));
        document.body.append(dialog);
        dialog.addEventListener('close', () => dialog.remove());
      } }));
  }
  return actions;
}

async function rotate(id, kind, state = {}) {
  const label = kind === 'admin' ? 'adminKey' : 'apiKey';
  const graceDays = window.prompt(`为 ${label} 签发新密钥。旧密钥保留的宽限期（天，0 表示立即吊销）：`, '7');
  if (graceDays === null) return;
  const days = Number(graceDays);
  if (!Number.isFinite(days) || days < 0 || days > 30) { toast('宽限期必须是 0..30 之间的整数', 'error'); return; }
  try {
    const result = await api.rotateKey(id, kind, { graceDays: Math.trunc(days) });
    const value = kind === 'admin' ? result?.adminKey : result?.apiKey;
    if (value) {
      const box = secretReveal(`新的 ${label}`, [[label, value]]);
      const dialog = el('dialog', { open: true },
        el('div', { class: 'card' }, el('h2', { text: `已轮换 ${label}` }), box,
          el('div', { class: 'actions' },
            el('button', { type: 'button', class: 'button primary', text: '我已保存',
              onclick: () => { dialog.close(); navigate(withQuery('/apps', state)); } }))));
      document.body.append(dialog);
      dialog.addEventListener('close', () => dialog.remove());
    }
    toast(`${label} 已轮换`, 'ok');
  } catch (error) {
    toast(messageOf(error), 'error');
  }
}
