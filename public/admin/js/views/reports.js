// User reports: accept, resolve, or reject, with an ordered handling history.
// Content removal stays with the consuming application; this page records the outcome.

import { el, clear, badge, time, toast, errorBox, table } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { listState, withQuery, pager, load, messageOf, cellText } from './common.js';

const STATUSES = ['open', 'accepted', 'resolved', 'rejected'];
const TONE = { open: 'warn', accepted: '', resolved: 'ok', rejected: 'bad' };
const HANDLE = ['accepted', 'resolved', 'rejected'];

function statusBadge(status) {
  return badge(status ?? '—', TONE[status] ?? '');
}

function detailPanel(row, onChanged) {
  const card = el('section', { class: 'card' },
    el('h2', { text: `举报 ${row.id}` }),
    el('dl', { class: 'detail' },
      el('dt', { text: '目标' }), el('dd', { text: `${cellText(row.targetType)} / ${cellText(row.targetId)}` }),
      el('dt', { text: '举报人' }), el('dd', { text: cellText(row.reporterId) }),
      el('dt', { text: '理由' }), el('dd', { text: cellText(row.reason) }),
      el('dt', { text: '状态' }), el('dd', {}, statusBadge(row.status)),
      el('dt', { text: '提交时间' }), el('dd', {}, time(row.createdAt)))
  );
  const history = Array.isArray(row.history) ? row.history : [];
  card.append(el('h2', { text: '处理记录' }),
    table([
      { label: '时间', render: event => time(event.createdAt) },
      { label: '状态', render: event => statusBadge(event.status) },
      { label: '处理人', render: event => cellText(event.actorId) },
      { label: '结论', render: event => cellText(event.result) }
    ], history, { empty: '还没有处理记录' }));

  if (row.status !== 'resolved' && row.status !== 'rejected') {
    const status = el('select', {}, HANDLE.map(value => el('option', { value, text: value,
      selected: value === 'accepted' })));
    const result = el('input', { maxlength: '2000', placeholder: '处理结论（1..2000 字符）', required: true });
    const feedback = el('div');
    const submit = el('button', { type: 'button', class: 'button primary', text: '提交处理' });
    submit.addEventListener('click', async () => {
      clear(feedback);
      if (result.value.trim() === '') { feedback.append(errorBox('请填写处理结论')); return; }
      submit.disabled = true;
      try {
        await api.handleReport(row.id, { status: status.value, result: result.value.trim() });
        toast('已记录处理结果', 'ok');
        onChanged();
      } catch (error) {
        feedback.append(errorBox(messageOf(error)));
      } finally {
        submit.disabled = false;
      }
    });
    card.append(el('h2', { text: '处理' }),
      el('div', { class: 'inline' },
        el('label', {}, el('span', { text: '处理结果' }), status),
        el('label', { class: 'grow' }, el('span', { text: '结论' }), result)),
      feedback,
      el('div', { class: 'actions' }, submit));
  }
  return card;
}

export async function reportsView(main, { query, ctx }) {
  const state = listState(query, { status: 'open' });
  await load(main, async container => {
    clear(container);
    const refresh = () => navigate(withQuery('/reports', state), { replace: true });
    const status = el('select', {},
      el('option', { value: '', text: '全部状态', selected: !state.status }),
      STATUSES.map(value => el('option', { value, text: value, selected: value === state.status })));
    const filterForm = el('form', { class: 'inline', role: 'search' },
      el('label', {}, el('span', { text: '状态' }), status),
      el('button', { type: 'submit', class: 'button', text: '筛选' }));
    filterForm.addEventListener('submit', event => {
      event.preventDefault();
      navigate(withQuery('/reports', { ...state, status: status.value, offset: 0 }));
    });

    const result = await api.listReports({ limit: state.limit, offset: state.offset,
      status: state.status || undefined });
    const items = result.items ?? [];
    const detailHost = el('div');

    const open = async id => {
      clear(detailHost).append(el('p', { class: 'muted', text: '正在加载举报…' }));
      try {
        const row = await api.getReport(id);
        clear(detailHost).append(detailPanel(row, refresh));
        detailHost.scrollIntoView({ block: 'start' });
      } catch (error) {
        clear(detailHost).append(errorBox(messageOf(error)));
      }
    };

    container.append(
      el('h1', { text: '举报' }),
      el('p', { class: 'lede', text: `当前应用 ${ctx.appId ?? ''}。内容下架仍由业务方管理员执行，这里只记录受理与结论。` }),
      el('section', { class: 'card' }, filterForm,
        table([
          { label: '提交时间', render: row => time(row.createdAt) },
          { label: '目标', render: row => el('span', {},
            el('span', { class: 'mono', text: cellText(row.targetType) }), ' / ', cellText(row.targetId)) },
          { label: '举报人', render: row => cellText(row.reporterId) },
          { label: '理由', render: row => cellText(row.reason) },
          { label: '状态', render: row => statusBadge(row.status) },
          { label: '操作', render: row => el('button', { type: 'button', class: 'button small', text: '处理',
            onclick: () => open(row.id) }) }
        ], items, { empty: '没有举报' }),
        pager(result, offset => navigate(withQuery('/reports', { ...state, offset })))),
      detailHost
    );
    return container;
  });
}
