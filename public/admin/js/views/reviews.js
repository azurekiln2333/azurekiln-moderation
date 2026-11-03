// Manual review queue: list items by status/scene, inspect the submitted payload, and
// record a final decision (approve -> pass, reject -> block).

import { el, clear, badge, time, toast, errorBox, table } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { listState, withQuery, pager, load, messageOf, cellText } from './common.js';

const STATUSES = ['pending', 'approved', 'rejected'];
const STATUS_LABEL = { pending: ['待审核', 'warn'], approved: ['已通过', 'ok'], rejected: ['已拒绝', 'bad'] };

function statusBadge(status) {
  const [label, tone] = STATUS_LABEL[status] ?? [status ?? '—', ''];
  return badge(label, tone);
}

function detailPanel(item, onResolved) {
  const card = el('section', { class: 'card' });
  card.append(
    el('h2', { text: `审核项 ${item.id}` }),
    el('dl', { class: 'detail' },
      el('dt', { text: '场景 / 类型' }), el('dd', { text: `${cellText(item.scene)} / ${cellText(item.kind)}` }),
      el('dt', { text: '状态' }), el('dd', {}, statusBadge(item.status)),
      el('dt', { text: '提交时间' }), el('dd', {}, time(item.createdAt)),
      el('dt', { text: '用户 / 目标' }), el('dd', { text: [item.userId, item.targetType, item.targetId]
        .filter(Boolean).join(' · ') || '—' }),
      el('dt', { text: 'IP' }), el('dd', { class: 'mono', text: cellText(item.ip) }))
  );
  if (item.payload !== undefined) {
    card.append(el('h2', { text: '提交内容' }),
      el('pre', { class: 'payload', text: JSON.stringify(item.payload, null, 2) }));
  }
  if (item.status === 'pending') {
    const reason = el('input', { maxlength: '1000', placeholder: '处理理由（1..1000 字符）', required: true });
    const feedback = el('div');
    const decide = async decision => {
      clear(feedback);
      if (reason.value.trim() === '') { feedback.append(errorBox('请填写处理理由')); return; }
      try {
        await api.resolveReview(item.id, { decision, reason: reason.value.trim() });
        toast(decision === 'pass' ? '已通过' : '已拒绝', 'ok');
        onResolved();
      } catch (error) {
        feedback.append(errorBox(messageOf(error)));
      }
    };
    card.append(
      el('h2', { text: '处理' }),
      el('label', {}, el('span', { text: '理由' }), reason),
      feedback,
      el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'button primary', text: '通过（放行）',
          onclick: () => decide('pass') }),
        el('button', { type: 'button', class: 'button danger', text: '拒绝（拦截）',
          onclick: () => decide('block') }))
    );
  } else {
    card.append(el('p', { class: 'small muted',
      text: `已由 ${cellText(item.actorId)} 于 ${item.resolvedAt ?? ''} 处理，理由：${cellText(item.reason)}` }));
  }
  return card;
}

export async function reviewsView(main, { query, ctx }) {
  const state = listState(query, { status: 'pending', scene: '' });
  await load(main, async container => {
    clear(container);
    const refresh = () => navigate(withQuery('/reviews', state), { replace: true });
    const status = el('select', {},
      el('option', { value: '', text: '全部状态', selected: !state.status }),
      STATUSES.map(value => el('option', { value, text: STATUS_LABEL[value][0], selected: value === state.status })));
    const scene = el('input', { value: state.scene ?? '', maxlength: '64', placeholder: '按场景筛选' });
    const filterForm = el('form', { class: 'inline', role: 'search' },
      el('label', {}, el('span', { text: '状态' }), status),
      el('label', { class: 'grow' }, el('span', { text: '场景' }), scene),
      el('button', { type: 'submit', class: 'button', text: '筛选' }));
    filterForm.addEventListener('submit', event => {
      event.preventDefault();
      navigate(withQuery('/reviews', { ...state, status: status.value, scene: scene.value.trim(), offset: 0 }));
    });

    const result = await api.listReviews({ limit: state.limit, offset: state.offset,
      status: state.status || undefined, scene: state.scene || undefined });
    const items = result.items ?? [];
    const detailHost = el('div');

    const open = async id => {
      clear(detailHost).append(el('p', { class: 'muted', text: '正在加载审核项…' }));
      try {
        const item = await api.getReview(id);
        clear(detailHost).append(detailPanel(item, refresh));
        detailHost.scrollIntoView({ block: 'start' });
      } catch (error) {
        clear(detailHost).append(errorBox(messageOf(error)));
      }
    };

    container.append(
      el('h1', { text: '审核队列' }),
      el('p', { class: 'lede', text: `当前应用 ${ctx.appId ?? ''}。审核结果决定消费者是否放行内容。` }),
      el('section', { class: 'card' }, filterForm,
        table([
          { label: '提交时间', render: row => time(row.createdAt) },
          { label: '场景', render: row => el('span', { class: 'mono', text: cellText(row.scene) }) },
          { label: '类型', render: row => badge(cellText(row.kind)) },
          { label: '用户 / 目标', render: row => cellText([row.userId, row.targetId].filter(Boolean).join(' · ')) },
          { label: '状态', render: row => statusBadge(row.status) },
          { label: '操作', render: row => el('button', { type: 'button', class: 'button small', text: '查看',
            onclick: () => open(row.id) }) }
        ], items, { empty: '队列为空' }),
        pager(result, offset => navigate(withQuery('/reviews', { ...state, offset })))),
      detailHost
    );
    return container;
  });
}
