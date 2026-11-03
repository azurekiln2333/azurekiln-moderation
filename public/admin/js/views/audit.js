// Audit log query. Audits store IDs and categories rather than raw submitted text, so this
// page only renders the fields the service returns.

import { el, clear, badge, time, table } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { listState, withQuery, pager, load, cellText } from './common.js';

const DECISION_TONE = { pass: 'ok', block: 'bad', review: 'warn' };

export async function auditView(main, { query, ctx }) {
  const state = listState(query, { action: '', actorId: '', from: '', to: '' });
  await load(main, async container => {
    clear(container);
    const action = el('input', { value: state.action ?? '', maxlength: '128', placeholder: '例如 text.check',
      list: 'audit-actions' });
    const actorId = el('input', { value: state.actorId ?? '', maxlength: '128', placeholder: '操作人' });
    const from = el('input', { type: 'date', value: state.from ?? '' });
    const to = el('input', { type: 'date', value: state.to ?? '' });
    const filterForm = el('form', { class: 'inline', role: 'search' },
      el('label', { class: 'grow' }, el('span', { text: '动作' }), action,
        el('datalist', { id: 'audit-actions' },
          ['text.check', 'image.check', 'ip.check', 'review.policy', 'review.resolve', 'report.submit',
            'report.handle', 'keyword.create', 'keyword.update', 'keyword.delete', 'ip_rule.create',
            'app.create', 'app.key.rotate', 'admin.login'].map(value => el('option', { value })))),
      el('label', { class: 'grow' }, el('span', { text: '操作人' }), actorId),
      el('label', {}, el('span', { text: '起始日期' }), from),
      el('label', {}, el('span', { text: '结束日期' }), to),
      el('button', { type: 'submit', class: 'button', text: '查询' }));
    filterForm.addEventListener('submit', event => {
      event.preventDefault();
      navigate(withQuery('/audit', { ...state, action: action.value.trim(), actorId: actorId.value.trim(),
        from: from.value, to: to.value, offset: 0 }));
    });

    const result = await api.listAudit({ limit: state.limit, offset: state.offset,
      action: state.action || undefined, actorId: state.actorId || undefined,
      from: state.from || undefined, to: state.to || undefined });
    const items = result.items ?? [];

    container.append(
      el('h1', { text: '审计日志' }),
      el('p', { class: 'lede', text: `当前应用 ${ctx.appId ?? ''}。保留 365 天，只记录 ID 与分类，不记录原文与密钥。` }),
      el('section', { class: 'card' }, filterForm,
        table([
          { label: '时间', render: row => time(row.createdAt) },
          { label: '动作', render: row => el('span', { class: 'mono', text: cellText(row.action) }) },
          { label: '操作人', render: row => cellText(row.actorId) },
          { label: '目标', render: row => el('span', { class: 'mono', text: cellText(row.targetId) }) },
          { label: '结果', render: row => row.decision ? badge(row.decision, DECISION_TONE[row.decision] ?? '') : '—' },
          { label: '数据', render: row => el('code', { class: 'small', text: row.data ? JSON.stringify(row.data) : '—' }) }
        ], items, { empty: '没有匹配的记录' }),
        pager(result, offset => navigate(withQuery('/audit', { ...state, offset }))))
    );
    return container;
  });
}
