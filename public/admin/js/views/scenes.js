// Per-scene pre-review policy: when enabled, content that would otherwise pass is queued
// for manual review and returned to the consumer as decision "review".

import { el, clear, badge, time, toast, errorBox, table } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { listState, withQuery, pager, load, messageOf, cellText } from './common.js';

function toggleRow(row, refresh) {
  const input = el('input', { type: 'checkbox', checked: row.preReview === true,
    'aria-label': `先审后发 ${row.scene}` });
  input.addEventListener('change', async () => {
    input.disabled = true;
    try {
      const result = await api.setScene(row.scene, { preReview: input.checked });
      row.preReview = result?.preReview ?? input.checked;
      toast(`${row.scene} 先审后发已${row.preReview ? '开启' : '关闭'}`, 'ok');
      refresh();
    } catch (error) {
      input.checked = !input.checked;
      toast(messageOf(error), 'error');
    } finally {
      input.disabled = false;
    }
  });
  return input;
}

function addForm(refresh) {
  const scene = el('input', { required: true, maxlength: '64', placeholder: '例如 post' });
  const preReview = el('input', { type: 'checkbox' });
  const submit = el('button', { type: 'submit', class: 'button primary', text: '保存场景策略' });
  const feedback = el('div');
  const form = el('form', { class: 'stack', novalidate: true },
    el('div', { class: 'inline' },
      el('label', { class: 'grow' }, el('span', { text: '场景名（scene）' }), scene),
      el('label', {}, el('span', { text: '开启先审后发' }), preReview)),
    feedback,
    el('div', { class: 'actions' }, submit));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    clear(feedback);
    submit.disabled = true;
    try {
      await api.setScene(scene.value.trim(), { preReview: preReview.checked });
      scene.value = '';
      preReview.checked = false;
      toast('场景策略已保存', 'ok');
      refresh();
    } catch (error) {
      feedback.append(errorBox(messageOf(error)));
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

export async function scenesView(main, { query, ctx }) {
  const state = listState(query);
  await load(main, async container => {
    clear(container);
    const refresh = () => navigate(withQuery('/scenes', state), { replace: true });
    const result = await api.listScenes({ limit: state.limit, offset: state.offset });
    const items = result.items ?? [];
    const enabledCount = items.filter(item => item.preReview).length;

    container.append(
      el('h1', { text: '先审后发' }),
      el('p', { class: 'lede', text: `当前应用 ${ctx.appId ?? ''}。开启后，本会放行的内容会进入人工审核队列。` }),
      el('section', { class: 'card' },
        el('p', { class: 'small muted', text: `本页 ${items.length} 个场景，其中 ${enabledCount} 个已开启。未列出的场景默认为关闭。` }),
        addForm(refresh)),
      el('section', { class: 'card' },
        table([
          { label: '场景', render: row => el('span', { class: 'mono', text: cellText(row.scene) }) },
          { label: '先审后发', render: row => toggleRow(row, refresh) },
          { label: '状态', render: row => row.preReview ? badge('审核后发布', 'warn') : badge('直接发布', 'ok') },
          { label: '更新时间', render: row => time(row.updatedAt) }
        ], items, { empty: '还没有配置任何场景，默认全部直接发布' }),
        pager(result, offset => navigate(withQuery('/scenes', { ...state, offset }))))
    );
    return container;
  });
}
