// Initialisation and login pages.
//
// The service prints a one-time bootstrap token to its container log on first start.
// The init page accepts that token once, creates the first administrator, and then closes
// itself forever. When no token is pending the page explains how to obtain one instead of
// exposing a form (see `bootstrapStatus().required`).

import { el, clear, errorBox, toast } from '../dom.js';
import { api, refreshCsrf, setCsrfToken, ApiError } from '../api.js';
import { navigate } from '../router.js';
import { messageOf } from './common.js';

function panel(title, lede, body) {
  return el('section', { class: 'card narrow' },
    el('h1', { text: title }), el('p', { class: 'lede', text: lede }), body);
}

export async function initView(main) {
  clear(main).append(el('p', { class: 'muted', text: '正在检查初始化状态…' }));
  let status;
  try {
    status = await api.bootstrapStatus();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      // No bootstrap endpoint means initialisation is not required by this build.
      navigate('/login', { replace: true });
      return;
    }
    clear(main).append(errorBox(`无法读取初始化状态：${messageOf(error)}`));
    return;
  }
  if (!status || status.required !== true) {
    clear(main).append(panel('初始化已完成', '该服务已经有管理员账号，初始化页已关闭。',
      el('div', { class: 'actions' },
        el('a', { class: 'button primary', href: '#/login', text: '前往登录' }))));
    return;
  }
  const token = el('input', { name: 'token', autocomplete: 'off', spellcheck: 'false', required: true,
    placeholder: '容器日志中的一次性初始化口令' });
  const username = el('input', { name: 'username', autocomplete: 'username', required: true,
    minlength: '3', maxlength: '64', value: status.suggestedUsername ?? '' });
  const secret = el('input', { name: 'password', type: 'password', autocomplete: 'new-password', required: true,
    minlength: '12' });
  const confirm = el('input', { name: 'confirm', type: 'password', autocomplete: 'new-password', required: true,
    minlength: '12' });
  const submit = el('button', { type: 'submit', class: 'button primary', text: '创建超级管理员' });
  const feedback = el('div');

  const form = el('form', { class: 'stack', novalidate: true },
    el('label', {}, el('span', { text: '初始化口令' }), token),
    el('label', {}, el('span', { text: '管理员用户名' }), username),
    el('label', {}, el('span', { text: '密码（至少 12 位）' }), secret),
    el('label', {}, el('span', { text: '确认密码' }), confirm),
    feedback,
    el('div', { class: 'actions' }, submit)
  );

  form.addEventListener('submit', async event => {
    event.preventDefault();
    clear(feedback);
    if (secret.value !== confirm.value) {
      feedback.append(errorBox('两次输入的密码不一致'));
      return;
    }
    if (token.value.trim() === '') {
      feedback.append(errorBox('请填写初始化口令'));
      return;
    }
    submit.disabled = true;
    try {
      const result = await api.bootstrap({ token: token.value.trim(), username: username.value.trim(),
        password: secret.value });
      if (result?.csrfToken) setCsrfToken(result.csrfToken);
      else await refreshCsrf();
      toast('管理员已创建，请登录', 'ok');
      navigate('/login', { replace: true });
    } catch (error) {
      feedback.append(errorBox(messageOf(error)));
    } finally {
      submit.disabled = false;
    }
  });

  clear(main).append(panel('初始化管理后台',
    '这是首次启动。口令只打印在服务日志里且 24 小时内有效；创建管理员后立即作废。',
    el('div', { class: 'stack' },
      el('p', { class: 'small muted',
        text: '获取口令：docker compose logs moderation | grep bootstrap（或查看容器日志中的 moderation.admin.bootstrap 事件）。' }),
      form)));
}

export async function loginView(main, { query } = {}) {
  const next = query?.get('next');
  const username = el('input', { name: 'username', autocomplete: 'username', required: true, maxlength: '64' });
  const password = el('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const submit = el('button', { type: 'submit', class: 'button primary', text: '登录' });
  const feedback = el('div');
  const oidc = el('div');

  const form = el('form', { class: 'stack', novalidate: true },
    el('label', {}, el('span', { text: '用户名' }), username),
    el('label', {}, el('span', { text: '密码' }), password),
    feedback,
    el('div', { class: 'actions' }, submit)
  );

  form.addEventListener('submit', async event => {
    event.preventDefault();
    clear(feedback);
    submit.disabled = true;
    try {
      const result = await api.login(username.value.trim(), password.value);
      if (result?.csrfToken) setCsrfToken(result.csrfToken);
      else await refreshCsrf();
      if (result?.mustChangePassword) {
        toast('首次登录，请修改密码', 'ok');
        navigate('/password', { replace: true });
        return;
      }
      navigate(next && next.startsWith('/') ? next : '/apps', { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        feedback.append(errorBox('登录尝试过于频繁，请稍后再试'));
      } else {
        feedback.append(errorBox(messageOf(error)));
      }
      password.value = '';
      password.focus();
    } finally {
      submit.disabled = false;
    }
  });

  clear(main).append(panel('登录管理后台', '使用管理员账号登录。',
    el('div', { class: 'stack' }, form, oidc)));

  // OIDC is optional. The entry point is only rendered when the backend reports it enabled;
  // an unconfigured service never advertises a login path it cannot serve.
  try {
    const session = await api.session();
    const config = session?.oidc;
    if (config && config.enabled === true && typeof config.loginUrl === 'string') {
      const href = config.loginUrl.startsWith('/admin/') ? config.loginUrl : null;
      if (href) {
        oidc.append(el('p', { class: 'small muted', text: '或使用组织账号登录：' }),
          el('a', { class: 'button', href: href, text: config.label ?? '使用 OIDC 登录' }));
      }
    }
  } catch {
    // Unauthenticated session probes are expected to fail; the form still works.
  }
}

export async function passwordView(main) {
  const current = el('input', { name: 'current', type: 'password', autocomplete: 'current-password', required: true });
  const next = el('input', { name: 'next', type: 'password', autocomplete: 'new-password', required: true, minlength: '12' });
  const confirm = el('input', { name: 'confirm', type: 'password', autocomplete: 'new-password', required: true, minlength: '12' });
  const submit = el('button', { type: 'submit', class: 'button primary', text: '修改密码' });
  const feedback = el('div');
  const form = el('form', { class: 'stack', novalidate: true },
    el('label', {}, el('span', { text: '当前密码' }), current),
    el('label', {}, el('span', { text: '新密码（至少 12 位）' }), next),
    el('label', {}, el('span', { text: '确认新密码' }), confirm),
    feedback,
    el('div', { class: 'actions' }, submit));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    clear(feedback);
    if (next.value !== confirm.value) { feedback.append(errorBox('两次输入的新密码不一致')); return; }
    submit.disabled = true;
    try {
      await api.changePassword({ currentPassword: current.value, password: next.value });
      toast('密码已更新', 'ok');
      navigate('/apps', { replace: true });
    } catch (error) {
      feedback.append(errorBox(messageOf(error)));
    } finally {
      submit.disabled = false;
    }
  });
  clear(main).append(panel('修改密码', '管理员密码至少 12 位。', form));
}
