import { el, clear, errorBox, time, toast } from '../dom.js';
import { navigate } from '../router.js';
import { ApiError } from '../api.js';

export const PAGE_SIZE = 50;

// A tiny list controller: keeps unit state in the URL hash so refreshes and bookmarks work.
export function listState(query, defaults = {}) {
  const state = { limit: defaults.limit ?? PAGE_SIZE, offset: 0 };
  for (const [key, value] of Object.entries(defaults)) {
    const raw = query.get(key);
    state[key] = raw === null ? value : raw;
  }
  const offset = Number(query.get('offset') ?? 0);
  if (Number.isSafeInteger(offset) && offset >= 0) state.offset = offset;
  const limit = Number(query.get('limit') ?? state.limit);
  if (Number.isSafeInteger(limit) && limit >= 1 && limit <= 100) state.limit = limit;
  return state;
}

export function withQuery(path, state) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state).sort(([a], [b]) => a.localeCompare(b))) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'offset' && value === 0) continue;
    if (key === 'limit' && value === PAGE_SIZE) continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

export function pager({ total, limit, offset }, onChange) {
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);
  const previous = el('button', { type: 'button', class: 'button small', text: '上一页',
    disabled: offset === 0, onclick: () => onChange(Math.max(0, offset - limit)) });
  const next = el('button', { type: 'button', class: 'button small', text: '下一页',
    disabled: offset + limit >= total, onclick: () => onChange(offset + limit) });
  return el('div', { class: 'pager' }, previous, el('span', { text: `第 ${start}–${end} 条，共 ${total} 条` }), next);
}

export function messageOf(error) {
  if (error instanceof ApiError) {
    const suffix = error.requestId ? `（请求 ${error.requestId}）` : '';
    return `${error.message}${error.code ? ` [${error.code}]` : ''}${suffix}`;
  }
  return error instanceof Error ? error.message : '未知错误';
}

export function isUnauthorized(error) {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

// Wraps async view work: renders a loading note, catches failures, and re-routes on 401.
export async function load(main, work) {
  const container = el('div', { class: 'stack' }, el('p', { class: 'muted', text: '正在加载…' }));
  clear(main).append(container);
  try {
    const content = await work(container);
    clear(main);
    if (content) main.append(content);
    else main.append(container);
    return content;
  } catch (error) {
    if (isUnauthorized(error)) { navigate('/login', { replace: true }); return null; }
    clear(main).append(errorBox(messageOf(error)));
    toast(messageOf(error), 'error');
    return null;
  }
}

export function switchValue(value, onChange, { label = '' } = {}) {
  const input = el('input', { type: 'checkbox', checked: Boolean(value), 'aria-label': label || undefined });
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

export function shortId(id) {
  const text = String(id ?? '');
  return text.length > 12 ? `${text.slice(0, 8)}…` : text;
}

export function cellText(value) {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

export { el, clear, errorBox, time, toast };
