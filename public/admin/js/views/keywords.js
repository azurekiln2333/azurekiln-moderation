// Word list management for one application: list by category, create, edit, delete, and
// batch import/export. Words are displayed as plain text; the service never echoes raw
// matched text back to consumers, but administrators are allowed to see their own dictionary.

import { el, clear, badge, time, toast, errorBox, table } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { listState, withQuery, pager, load, messageOf, cellText } from './common.js';

export const CATEGORIES = ['politics', 'pornography', 'gambling', 'drugs', 'weapons', 'controlled_items',
  'fraud', 'terrorism', 'prohibited_goods', 'advertising', 'custom'];

function categorySelect(selected) {
  return el('select', {}, CATEGORIES.map(code => el('option', { value: code, text: code,
    selected: code === selected })));
}

function createForm(state, done) {
  const word = el('input', { name: 'word', required: true, maxlength: '128' });
  const category = categorySelect('custom');
  const submit = el('button', { type: 'submit', class: 'button primary', text: '添加关键词' });
  const feedback = el('div');
  const form = el('form', { class: 'stack', novalidate: true },
    el('div', { class: 'inline' },
      el('label', { class: 'grow' }, el('span', { text: '关键词' }), word),
      el('label', {}, el('span', { text: '分类' }), category)),
    feedback,
    el('div', { class: 'actions' }, submit));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    clear(feedback);
    submit.disabled = true;
    try {
      await api.createKeyword({ word: word.value.trim(), category: category.value, enabled: true });
      word.value = '';
      toast('已添加', 'ok');
      done();
    } catch (error) {
      feedback.append(errorBox(messageOf(error)));
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

function importForm(done) {
  const text = el('textarea', { placeholder: '每行一个词，或用逗号分隔；也可粘贴 {"words":[...]} 形式的 JSON' });
  const category = categorySelect('custom');
  const submit = el('button', { type: 'submit', class: 'button primary', text: '批量导入' });
  const feedback = el('div');
  const form = el('form', { class: 'stack', novalidate: true },
    el('div', { class: 'inline' },
      el('label', { class: 'grow' }, el('span', { text: '词语' }), text),
      el('label', {}, el('span', { text: '分类' }), category)),
    el('p', { class: 'small muted', text: '已存在的词会被跳过，不会覆盖已有配置。' }),
    feedback,
    el('div', { class: 'actions' }, submit));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    clear(feedback);
    const words = parseWords(text.value);
    if (words.length === 0) { feedback.append(errorBox('没有解析到任何词')); return; }
    submit.disabled = true;
    try {
      const result = await api.importKeywords({ category: category.value, words });
      const created = result?.created ?? result?.imported ?? words.length;
      const skipped = result?.skipped ?? 0;
      toast(`导入完成：新增 ${created} 条，跳过 ${skipped} 条`, 'ok');
      text.value = '';
      done();
    } catch (error) {
      feedback.append(errorBox(messageOf(error)));
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

export function parseWords(raw) {
  const value = String(raw ?? '').trim();
  if (value === '') return [];
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.words) ? parsed.words : [];
      return list.map(item => typeof item === 'string' ? item : item?.word)
        .filter(item => typeof item === 'string' && item.trim() !== '')
        .map(item => item.trim()).slice(0, 5000);
    } catch {
      return [];
    }
  }
  return value.split(/[\r\n,，;；\t]+/u).map(item => item.trim())
    .filter(item => item !== '').slice(0, 5000);
}

async function exportCategory(category, state) {
  try {
    const result = await api.exportKeywords({ category: category || undefined });
    const words = Array.isArray(result?.words) ? result.words
      : Array.isArray(result?.items) ? result.items.map(item => item.word ?? item) : [];
    if (words.length === 0) { toast('该分类没有可导出的词', 'error'); return; }
    const blob = new Blob([`${words.join('\n')}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: `keywords-${category || 'all'}.txt` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`已导出 ${words.length} 个词`, 'ok');
  } catch (error) {
    toast(messageOf(error), 'error');
  }
  return state;
}

export async function keywordsView(main, { query, ctx }) {
  const state = listState(query, { category: '', q: '' });
  await load(main, async container => {
    clear(container);
    const refresh = () => navigate(withQuery('/keywords', state), { replace: true });

    const search = el('input', { value: state.q ?? '', placeholder: '搜索词' });
    const category = el('select', {},
      el('option', { value: '', text: '全部分类', selected: !state.category }),
      CATEGORIES.map(code => el('option', { value: code, text: code, selected: code === state.category })));
    const filterForm = el('form', { class: 'inline', role: 'search' },
      el('label', { class: 'grow' }, el('span', { text: '搜索' }), search),
      el('label', {}, el('span', { text: '分类' }), category),
      el('button', { type: 'submit', class: 'button', text: '筛选' }),
      el('button', { type: 'button', class: 'button', text: '导出当前分类',
        onclick: () => exportCategory(state.category, state) }));
    filterForm.addEventListener('submit', event => {
      event.preventDefault();
      navigate(withQuery('/keywords', { ...state, q: search.value.trim(), category: category.value, offset: 0 }));
    });

    const result = await api.listKeywords({ limit: state.limit, offset: state.offset,
      category: state.category || undefined, q: state.q || undefined });
    const items = result.items ?? [];

    container.append(
      el('h1', { text: '词库' }),
      el('p', { class: 'lede', text: `当前应用 ${ctx.appId ?? ''}。命中启用中关键词的内容会被拦截。` }),
      el('section', { class: 'card' }, el('h2', { text: '新增关键词' }), createForm(state, refresh)),
      el('section', { class: 'card' }, el('h2', { text: '批量导入' }), importForm(refresh)),
      el('section', { class: 'card' }, filterForm,
        table([
          { label: '关键词', render: row => el('span', { text: cellText(row.word) }) },
          { label: '分类', render: row => badge(cellText(row.category)) },
          { label: '状态', render: row => row.enabled === false ? badge('已停用', 'bad') : badge('启用', 'ok') },
          { label: '更新时间', render: row => time(row.updatedAt ?? row.createdAt) },
          { label: '操作', render: row => actions(row, refresh) }
        ], items, { empty: '没有匹配的关键词' }),
        pager(result, offset => navigate(withQuery('/keywords', { ...state, offset }))))
    );
    return container;
  });
}

function actions(row, refresh) {
  const id = row.id;
  const toggle = el('button', { type: 'button', class: 'button small',
    text: row.enabled === false ? '启用' : '停用',
    onclick: async () => {
      try {
        await api.updateKeyword(id, { enabled: row.enabled === false });
        refresh();
      } catch (error) { toast(messageOf(error), 'error'); }
    } });
  const remove = el('button', { type: 'button', class: 'button small danger', text: '删除',
    onclick: async () => {
      if (!window.confirm(`删除关键词「${row.word}」？`)) return;
      try {
        await api.deleteKeyword(id);
        toast('已删除', 'ok');
        refresh();
      } catch (error) { toast(messageOf(error), 'error'); }
    } });
  return el('div', { class: 'actions' }, toggle, remove);
}
