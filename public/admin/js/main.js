// Entry point: resolves the session, wires the navigation chrome, and registers routes.
// The bundle is static; every privileged call goes through js/api.js.

import { el, clear, toast } from './dom.js';
import { api, refreshCsrf, setCsrfToken, setCurrentApp, ApiError } from './api.js';
import { route, setNotFound, setNavigateHook, start, navigate, highlightNav } from './router.js';
import { errorBox } from './dom.js';
import { initView, loginView, passwordView } from './views/auth.js';
import { appsView } from './views/apps.js';
import { keywordsView } from './views/keywords.js';
import { ipRulesView } from './views/ip-rules.js';
import { scenesView } from './views/scenes.js';
import { reviewsView } from './views/reviews.js';
import { reportsView } from './views/reports.js';
import { auditView } from './views/audit.js';
import { adminsView } from './views/admins.js';

const shell = {
  session: null,
  appId: null,
  ctx: { appId: null }
};

const PUBLIC_ONLY = new Set(['/login', '/init']);
const pages = [
  ['/apps', appsView, '应用与密钥'],
  ['/keywords', keywordsView, '词库'],
  ['/ip-rules', ipRulesView, 'IP 规则'],
  ['/scenes', scenesView, '先审后发'],
  ['/reviews', reviewsView, '审核队列'],
  ['/reports', reportsView, '举报'],
  ['/audit', auditView, '审计日志'],
  ['/admins', adminsView, '管理员']
];

function chrome(visible) {
  document.getElementById('topbar').hidden = !visible;
}

function setWhoami(session) {
  const who = document.getElementById('whoami');
  const logout = document.getElementById('logout');
  const selector = document.getElementById('app-select');
  if (!session) {
    chrome(false);
    if (selector) selector.parentElement.hidden = true;
    logout.hidden = true;
    return;
  }
  who.textContent = session.username ? `${session.username}（${session.role ?? 'admin'}）` : '已登录';
  logout.hidden = false;
  const apps = Array.isArray(session.apps) ? session.apps : [];
  if (apps.length > 1) {
    clear(document.getElementById('app-select'));
    for (const app of apps) {
      document.getElementById('app-select').append(el('option', { value: app.appId ?? app.id,
        text: app.name ? `${app.name}（${app.appId ?? app.id}）` : String(app.appId ?? app.id),
        selected: (app.appId ?? app.id) === shell.appId }));
    }
    selector.parentElement.hidden = false;
  } else {
    selector.parentElement.hidden = true;
  }
  const app = apps.find(item => (item.appId ?? item.id) === shell.appId);
  shell.ctx = { appId: shell.appId, app, session };
  setCurrentApp(shell.appId);
}

async function loadSession() {
  try {
    const session = await api.session();
    shell.session = session ?? null;
    const apps = Array.isArray(session?.apps) ? session.apps : [];
    shell.appId = shell.appId ?? apps[0]?.appId ?? apps[0]?.id ?? session?.appId ?? null;
    if (session?.csrfToken) setCsrfToken(session.csrfToken);
    if (shell.appId) setCurrentApp(shell.appId);
    return shell.session;
  } catch (error) {
    shell.session = null;
    if (!(error instanceof ApiError)) toast('无法连接管理接口', 'error');
    return null;
  }
}

setNavigateHook(async ({ handler, params, query, path, title }) => {
  const main = document.getElementById('main');
  if (PUBLIC_ONLY.has(path) || path === '/password') {
    chrome(path === '/password' && Boolean(shell.session));
    await handler(main, { params, query, ctx: shell.ctx });
    return;
  }
  if (!shell.session) {
    chrome(false);
    navigate(`/login?next=${encodeURIComponent(path)}`, { replace: true });
    return;
  }
  chrome(true);
  highlightNav(path);
  document.title = title ? `${title} · 审核服务管理后台` : '审核服务管理后台';
  await handler(main, { params, query, ctx: shell.ctx });
});

export async function boot() {
  document.getElementById('topbar').hidden = true;
  await loadSession();
  await refreshCsrf();

  route('/init', initView, { title: '初始化' });
  route('/login', loginView, { title: '登录' });
  route('/password', passwordView, { title: '修改密码' });
  for (const [path, handler, title] of pages) route(path, handler, { title });

  setNotFound((main) => {
    clear(main).append(errorBox('页面不存在'), el('p', { class: 'actions' },
      el('a', { class: 'button primary', href: '#/apps', text: '返回应用列表' })));
  });

  const logout = document.getElementById('logout');
  logout.addEventListener('click', async () => {
    try { await api.logout(); } catch { /* the session may already be gone */ }
    shell.session = null;
    shell.appId = null;
    setCurrentApp(null);
    setWhoami(null);
    navigate('/login', { replace: true });
  });

  const selector = document.getElementById('app-select');
  selector.addEventListener('change', () => {
    shell.appId = selector.value;
    setCurrentApp(shell.appId);
    setWhoami(shell.session);
    navigate('/apps', { replace: true });
  });

  setWhoami(shell.session);

  if (!shell.session && !window.location.hash) {
    navigate('/login', { replace: true });
  }
  start();
  if (shell.session) {
    chrome(true);
    setWhoami(shell.session);
    highlightNav(window.location.hash.replace(/^#/, '') || '/');
  }
}

const appRoot = document.getElementById('app');
if (appRoot) {
  appRoot.dataset.state = 'ready';
  boot().catch(error => {
    const main = document.getElementById('main');
    clear(main).append(errorBox(error instanceof Error ? error.message : '管理后台加载失败'));
  });
}
