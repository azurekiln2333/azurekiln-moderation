// Hash router. Hash-based routing keeps the bundle a pure static asset: the server only
// has to serve index.html at /admin/ and never needs a catch-all route.

const routes = [];
let notFound = null;
let onNavigate = () => {};

export function route(path, handler, options = {}) {
  routes.push({ path, handler, title: options.title ?? '', chrome: options.chrome !== false });
}

export function setNotFound(handler) {
  notFound = handler;
}

export function setNavigateHook(hook) {
  onNavigate = hook;
}

export function currentPath() {
  const raw = window.location.hash.replace(/^#/, '');
  return raw.startsWith('/') ? raw : '/';
}

export function splitPath(path) {
  return path.split('?')[0].split('/').filter(Boolean);
}

export function queryOf(path = currentPath()) {
  const index = path.indexOf('?');
  return new URLSearchParams(index === -1 ? '' : path.slice(index + 1));
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (window.location.hash === target) render();
  else if (replace) { window.history.replaceState(null, '', target); render(); }
  else window.location.hash = target;
}

function match(segments) {
  for (const entry of routes) {
    const parts = splitPath(entry.path);
    if (parts.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segments[index]);
      else if (part !== segments[index]) { ok = false; break; }
    }
    if (ok) return { entry, params };
  }
  return null;
}

export function render() {
  const path = currentPath();
  const segments = splitPath(path);
  const found = match(segments);
  const view = found ? found.entry : notFound ? { handler: notFound, title: '', chrome: false, params: {} } : null;
  if (!view) return;
  const params = found ? found.params : {};
  onNavigate({ ...view, params, path, query: queryOf(path) });
}

export function start() {
  window.addEventListener('hashchange', render);
  if (!window.location.hash) window.history.replaceState(null, '', '#/');
  render();
}


export function highlightNav(activePath) {
  const nav = document.getElementById('topnav');
  if (!nav) return;
  const section = '/' + (splitPath(activePath)[0] ?? '');
  for (const link of nav.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? '';
    if (href === `#${section}`) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}
