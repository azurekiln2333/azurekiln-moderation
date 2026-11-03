# 管理后台网页（static bundle）

`public/admin/` 是审核服务的自带管理后台。纯静态资源，无构建步骤、无前端框架、无依赖：
浏览器直接加载 ES module，全部数据通过管理接口以同源 `fetch` 获取。

## 目录

| 路径 | 作用 |
| --- | --- |
| `index.html` | 外壳：导航、账号区、应用选择器、`#/…` 路由挂载点 |
| `admin.css` | 全部样式（含深色模式、移动端） |
| `favicon.svg` | 图标 |
| `js/main.js` | 启动：读取会话、注册路由、登录态跳转、退出 |
| `js/api.js` | **唯一**的接口契约适配层：`BASE`、`ENDPOINTS`、CSRF 与会话处理 |
| `js/router.js` | 基于 hash 的极简路由 |
| `js/dom.js` | DOM 构造辅助。全部用 `createElement`/`textContent`，不使用 `innerHTML` |
| `js/views/*.js` | 各页面：初始化、登录、应用与密钥、词库、IP 规则、先审后发、审核队列、举报、审计、管理员 |

页面（`#/…`）：`/init` `/login` `/password` `/apps` `/keywords` `/ip-rules` `/scenes`
`/reviews` `/reports` `/audit` `/admins`。

## 安全约定

- 不使用 `innerHTML`；举报理由、关键词、审核 payload 等一律按文本渲染。
- 不把任何密钥写进页面：apiKey/adminKey 明文只在创建或轮换的响应里出现一次，
  页面只做一次性展示（`.secret-reveal`），刷新后无法再取回。
- 不使用 `localStorage`/`sessionStorage` 保存会话或令牌：会话由 HttpOnly Cookie 承载。
- 页面自身不发 `inline script`/`inline event handler`，配合
  `Content-Security-Policy: default-src 'self'; script-src 'self'` 才可用。
- 状态变更请求带 `X-CSRF-Token`（来自 `GET {BASE}/csrf` 或 `GET {BASE}/session` 的
  `csrfToken` 字段）；收到 401 时丢弃缓存的令牌。

## 服务端挂载（由 A 在 `src/app.js` 里接一行）

```js
import { registerAdminUi } from './admin-ui/index.js';
// 在 404 处理之前：
registerAdminUi(app, ctx);
```

`registerAdminUi` 只挂静态资源，不注册任何业务接口：

- 仅允许 `GET`/`HEAD`，其他方法返回 405；未知文件返回 404（不做 SPA 全路径回退，
  因为路由在 hash 里）。
- 只放行 `/admin.css`、`/favicon.svg`、`/js/<name>.js` 与 `index.html`，不会把目录里
  新增的其它文件当成资源暴露。
- 设置 `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、
  `Referrer-Policy: no-referrer`、`Content-Security-Policy`；
  外壳页面 `Cache-Control: no-store`。

因此管理后台的 API 必须挂在 `/admin/api/*`（见下），否则 `js/api.js` 的 `BASE` 需要同步改。

## 与 B 的接口契约对接点

`docs/proposals/dynamic-config-contract.md` 落地后，**只需要改 `js/api.js`**：

- `BASE`：管理接口前缀，默认 `/admin/api`。
- `ENDPOINTS`：每个端点一个字符串或函数，页面只调用 `api.*` 方法。
- `request()`：CSRF 头名称、令牌获取方式、会话 Cookie 依赖。

页面假定（B 实现时按契约确认）：

| 用途 | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| 初始化状态 | GET | `/bootstrap/status` | `{required, suggestedUsername?}`；`required!==true` 时初始化页自动关闭 |
| 初始化 | POST | `/bootstrap` | `{token,username,password}`；口令一次性、24 小时有效 |
| 会话 | GET | `/session` | `{username,role,apps:[{appId,name}],csrfToken,oidc?}` |
| 登录 / 退出 / 改密 | POST | `/login` `/logout` `/password` | 登录失败限流时返回 429 |
| 应用 | GET/POST | `/apps`，PATCH/DELETE `/apps/:id` | 列表项含 `{id,appId,name,enabled,keys[]}` |
| 启停 | POST | `/apps/:id/enable` `/apps/:id/disable` | 停用立即生效 |
| 轮换 | POST | `/apps/:id/keys/:kind/rotate` | `kind` 为 `api`/`admin`，`{graceDays}`，响应含一次明文 |
| 吊销 | POST | `/apps/:id/keys/:kind/:keyId/revoke` | |
| 词库 | GET/POST | `/keywords`，PATCH/DELETE `/keywords/:id` | 支持 `category`、`q`、导入/导出 |
| IP 规则 | GET/POST | `/ip-rules`，PATCH/DELETE `/ip-rules/:id` | `type` 为 `ip`/`cidr`/`region` |
| 场景策略 | GET | `/scenes`，GET/PUT `/scenes/:scene` | `{preReview}` |
| 审核队列 | GET | `/reviews`、`/reviews/:id`，POST `/reviews/:id/resolve` | `{decision,reason}` |
| 举报 | GET | `/reports`、`/reports/:id`，POST `/reports/:id/handle` | `{status,result}` |
| 审计 | GET | `/audit` | `action`/`actorId`/`from`/`to` |
| 管理员 | GET/POST | `/admins`，PATCH/DELETE `/admins/:id` | `{username,role,enabled,password?}` |

错误统一按服务现有的 `{error,message,requestId}` 处理，页面会把 `message` 与
`requestId` 一起显示。

## 部署（由 D 处理）

`Dockerfile` 需要新增 `COPY public ./public`，否则镜像里没有后台页面。
`.dockerignore` 已排除 `test/`，无需改动。后台默认仍只绑定 `127.0.0.1`，
对外暴露 `/admin` 请用 `deploy/` 里的 nginx + HTTPS 示例。

## 测试

`test/ext/admin-ui.test.js`：

- 静态服务的路径、内容类型、安全响应头、405/404 行为；
- 外壳无 inline script、引用的资源都存在、导航项都有对应路由；
- 每个 module 都能被解析，相对 import 全部落在 bundle 内；
- bundle 不含密钥、不写入 Web Storage、只访问 `/admin/api`；
- `api.js` 的 CSRF 头、同源 Cookie、401 后清令牌、路径参数编码；
- 词库导入解析与列表状态在 hash 中的往返。
