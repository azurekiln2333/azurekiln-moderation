// Minimal DOM helpers. Everything renders through createElement/textContent so that
// reported reasons, keyword text, and review payloads can never inject markup.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'value') node.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'required' || key === 'selected') {
      node[key] = Boolean(value);
    } else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export function field(label, input, hint) {
  return el('label', {}, el('span', { text: label }), input, hint ? el('span', { class: 'small muted', text: hint }) : null);
}

export function table(columns, rows, { empty = '暂无数据' } = {}) {
  if (rows.length === 0) return el('p', { class: 'empty', text: empty });
  return el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, columns.map(column => el('th', { text: column.label })))),
    el('tbody', {}, rows.map(row => el('tr', {}, columns.map(column => el('td', {}, column.render(row))))))
  ));
}

export function badge(text, tone) {
  return el('span', { class: `badge${tone ? ' ' + tone : ''}`, text });
}

export function time(value) {
  if (!value) return '—';
  return el('span', { class: 'small', title: String(value), text: formatTime(value) });
}

export function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function toast(message, tone = '') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = el('div', { class: `toast${tone ? ' ' + tone : ''}`, text: message });
  host.append(node);
  setTimeout(() => node.remove(), 6000);
}

export function errorBox(message) {
  return el('div', { class: 'alert error', role: 'alert' }, el('strong', { text: '操作失败' }), el('p', { class: 'small', text: message }));
}

export function confirmAction(message) {
  return window.confirm(message);
}
