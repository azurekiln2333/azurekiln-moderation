import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const adminUiRoot = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'public', 'admin');

const asset = /^\/(?:admin\.css|favicon\.svg|js\/[A-Za-z0-9_.-]+\.js)$/u;

// The admin UI is a static, framework-free bundle. It never receives credentials from the
// server; every privileged call is made by the browser against the admin API with a session
// cookie and a CSRF token, so this router only ever serves files.
export function createAdminUiRouter({ root = adminUiRoot } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next(Object.assign(new Error('Method not allowed'), { status: 405, error: 'method_not_allowed' }));
    }
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
      "connect-src 'self'", "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'"
    ].join('; '));
    // The SPA must not be cached by intermediaries; assets may be revalidated.
    res.set('Cache-Control', req.path === '/' ? 'no-store' : 'public, max-age=0, must-revalidate');
    next();
  });
  router.get('/', (_req, res) => res.sendFile(join(root, 'index.html')));
  router.use((req, res, next) => (asset.test(req.path) ? next() : next(Object.assign(new Error('Not found'),
    { status: 404, error: 'not_found' }))));
  router.use(express.static(root, { index: false, dotfiles: 'deny', redirect: false, fallthrough: false }));
  return router;
}

// Single wiring point for src/app.js: `registerAdminUi(app, ctx)` mounts the bundle at /admin.
export function registerAdminUi(app, _ctx, options = {}) {
  app.use('/admin', createAdminUiRouter(options));
}
