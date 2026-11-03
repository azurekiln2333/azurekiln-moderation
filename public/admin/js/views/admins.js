// Administrator accounts: create, disable, reset password, delete. The last enabled
// super administrator cannot be removed; the backend enforces that and the UI surfaces it.

import { el, clear, badge, time, toast, errorBox, table } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { listState, withQuery, pager, load, messageOf, cellText } from './common.js';

const ROLES = ['superadmin', 'admin'];

function createForm(refresh) {
  const username = el('input', { required: true, minlength: '3', maxlength: '64', autocomplete: 'off' });
  const password = el('input', { type: 'password', required: true, minlength: '12', autocomplete: 'new-password' });
  const role = el('select', {}, ROLES.map(value => el('option', { value, text: value,
    selected: value === 'admin' })));
  const submit = el('button', { type: 'submit', class: 'button primary', text: '创建管理员' });
  const feedback = el('div');
  const form = el('form', { class: 'stack', novalidate: true },
    el('div', { class: 'inline' },
      el('label', { class: 'grow' }, el('span', { text: '用户名' }), username),
      el('label', { class: 'grow' }, el('span', { text: '初始密码（至少 12 位）' }), password),
      el('label', {}, el('span', { text: '角色' }), role)),
    feedback,
    el('div', { class: 'actions' }, submit));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    clear(feedback);
    submit.disabled = true;
    try {
      await api.createAdmin({ username: username.value.trim(), password: password.value, role: role.value });
      form.reset();
      toast('管理员已创建', 'ok');
      refresh();
    } catch (error) {
      feedback.append(errorBox(messageOf(error)));
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

export async function adminsView(main, { query }) {
  const state = listState(query);
  await load(main, async container => {
    clear(container);
    const refresh = () => navigate(withQuery('/admins', state), { replace: true });
    const result = await api.listAdmins({ limit: state.limit, offset: state.offset });
    const items = result.items ?? [];

    container.append(
      el('h1', { text: '管理员' }),
      el('p', { class: 'lede', text: '管理员账号用于登录本后台。请至少保留一个启用的超级管理员。' }),
      el('section', { class: 'card' }, el('h2', { text: '新增管理员' }), createForm(refresh)),
      el('section', { class: 'card' },
        table([
          { label: '用户名', render: row => el('span', { class: 'mono', text: cellText(row.username) }) },
          { label: '角色', render: row => badge(cellText(row.role)) },
          { label: '状态', render: row => row.enabled === false ? badge('已停用', 'bad') : badge('启用', 'ok') },
          { label: '最近登录', render: row => time(row.lastLoginAt) },
          { label: '创建时间', render: row => time(row.createdAt) },
          { label: '操作', render: row => actions(row, refresh) }
        ], items, { empty: '没有管理员账号' }),
        pager(result, offset => navigate(withQuery('/admins', { ...state, offset }))))
    );
    return container;
  });
}

function actions(row, refresh) {
  const id = row.id ?? row.username;
  const toggle = el('button', { type: 'button', class: 'button small',
    text: row.enabled === false ? '启用' : '停用',
    onclick: async () => {
      try {
        await api.updateAdmin(id, { enabled: row.enabled === false });
        refresh();
      } catch (error) { toast(messageOf(error), 'error'); }
    } });
  const reset = el('button', { type: 'button', class: 'button small', text: '重置密码',
    onclick: async () => {
      const password = window.prompt(`为 ${row.username} 设置新密码（至少 12 位）：`);
      if (password === null) return;
      try {
        await api.updateAdmin(id, { password });
        toast('密码已重置', 'ok');
      } catch (error) { toast(messageOf(error), 'error'); }
    } });
  const remove = el('button', { type: 'button', class: 'button small danger', text: '删除',
    onclick: async () => {
      if (!window.confirm(`删除管理员 ${row.username}？`)) return;
      try {
        await api.deleteAdmin(id);
        toast('已删除', 'ok');
        refresh();
      } catch (error) { toast(messageOf(error), 'error'); }
    } });
  return el('div', { class: 'actions' }, toggle, reset, remove);
}
