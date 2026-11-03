// IP / CIDR / region deny rules for the selected application. All rules are deny rules;
// an address that matches no enabled rule is allowed.

import { el, clear, badge, time, toast, errorBox, table } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { listState, withQuery, pager, load, messageOf, cellText } from './common.js';

const TYPES = ['ip', 'cidr', 'region'];

function typeSelect(selected) {
  return el('select', {}, TYPES.map(type => el('option', { value: type, text: type, selected: type === selected })));
}

function createForm(refresh) {
  const type = typeSelect('ip');
  const value = el('input', { required: true, maxlength: '128', placeholder: '192.0.2.1 / 192.0.2.0/24 / CN-44' });
  const reason = el('input', { maxlength: '500', placeholder: '可选，记录拦截原因' });
  const submit = el('button', { type: 'submit', class: 'button primary', text: '添加规则' });
  const feedback = el('div');
  type.addEventListener('change', () => {
    value.placeholder = type.value === 'region' ? 'CN 或 CN-44'
      : type.value === 'cidr' ? '192.0.2.0/24 或 2001:db8::/32' : '192.0.2.1 或 2001:db8::1';
  });
  const form = el('form', { class: 'stack', novalidate: true },
    el('div', { class: 'inline' },
      el('label', {}, el('span', { text: '类型' }), type),
      el('label', { class: 'grow' }, el('span', { text: '值' }), value),
      el('label', { class: 'grow' }, el('span', { text: '原因' }), reason)),
    feedback,
    el('div', { class: 'actions' }, submit));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    clear(feedback);
    submit.disabled = true;
    try {
      await api.createIpRule({ type: type.value, value: value.value.trim(),
        reason: reason.value.trim() || undefined, enabled: true });
      value.value = '';
      reason.value = '';
      toast('规则已添加', 'ok');
      refresh();
    } catch (error) {
      feedback.append(errorBox(messageOf(error)));
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

export async function ipRulesView(main, { query, ctx }) {
  const state = listState(query, { type: '', q: '' });
  await load(main, async container => {
    clear(container);
    const refresh = () => navigate(withQuery('/ip-rules', state), { replace: true });
    const search = el('input', { value: state.q ?? '', placeholder: '按规则值或原因搜索' });
    const type = el('select', {},
      el('option', { value: '', text: '全部类型', selected: !state.type }),
      TYPES.map(item => el('option', { value: item, text: item, selected: item === state.type })));
    const filterForm = el('form', { class: 'inline', role: 'search' },
      el('label', { class: 'grow' }, el('span', { text: '搜索' }), search),
      el('label', {}, el('span', { text: '类型' }), type),
      el('button', { type: 'submit', class: 'button', text: '筛选' }));
    filterForm.addEventListener('submit', event => {
      event.preventDefault();
      navigate(withQuery('/ip-rules', { ...state, q: search.value.trim(), type: type.value, offset: 0 }));
    });

    const result = await api.listIpRules({ limit: state.limit, offset: state.offset,
      type: state.type || undefined, q: state.q || undefined });
    const items = result.items ?? [];

    container.append(
      el('h1', { text: 'IP 规则' }),
      el('p', { class: 'lede', text: `当前应用 ${ctx.appId ?? ''}。规则全部为拒绝规则，未命中任何启用规则时放行。` }),
      el('section', { class: 'card' }, el('h2', { text: '新增规则' }), createForm(refresh)),
      el('section', { class: 'card' }, filterForm,
        table([
          { label: '类型', render: row => badge(cellText(row.type)) },
          { label: '值', render: row => el('span', { class: 'mono', text: cellText(row.value) }) },
          { label: '原因', render: row => cellText(row.reason) },
          { label: '状态', render: row => row.enabled === false ? badge('已停用', 'bad') : badge('启用', 'ok') },
          { label: '更新时间', render: row => time(row.updatedAt ?? row.createdAt) },
          { label: '操作', render: row => actions(row, refresh) }
        ], items, { empty: '还没有规则' }),
        pager(result, offset => navigate(withQuery('/ip-rules', { ...state, offset }))))
    );
    return container;
  });
}

function actions(row, refresh) {
  const toggle = el('button', { type: 'button', class: 'button small',
    text: row.enabled === false ? '启用' : '停用',
    onclick: async () => {
      try {
        await api.updateIpRule(row.id, { enabled: row.enabled === false });
        refresh();
      } catch (error) { toast(messageOf(error), 'error'); }
    } });
  const remove = el('button', { type: 'button', class: 'button small danger', text: '删除',
    onclick: async () => {
      if (!window.confirm(`删除规则 ${row.value}？`)) return;
      try {
        await api.deleteIpRule(row.id);
        toast('已删除', 'ok');
        refresh();
      } catch (error) { toast(messageOf(error), 'error'); }
    } });
  return el('div', { class: 'actions' }, toggle, remove);
}
