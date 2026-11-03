# 动态配置改造：表结构与接口契约（A 主程冻结版）

本文是 `docs/proposals/dynamic-config.md` 的执行契约。**A、B、C、D 四个分支都以本文件为准**，实现期间不得单方面改动路径、字段名、错误码；确需变更时先在 main 上改本文件并提交，再在群里说明。`/v1/*` 现有对外契约（根 README）完全不变，本文只新增内容。

约定：本文件所有 JSON 字段为 camelCase，时间均为 UTC ISO 8601 字符串；所有管理响应禁止出现明文密钥、密钥哈希、口令、口令哈希、session token、CSRF token 之外的敏感派生值。

---

## 1. 分层与文件归属

| 层 | 路径前缀 | 挂载点 | 负责 |
| --- | --- | --- | --- |
| 对外 v1 API | `/v1/*` | 现有 `router` | A（保持不变，仅鉴权来源由环境变量改为数据库） |
| 管理后台 API | `/admin/api/*` | 新 `adminRouter` | B |
| 管理后台网页 | `/admin/*` | 静态资源 + 页面 | C |
| 部署与文档 | `docker-compose*.yml`、`deploy/**`、README、`.trellis/spec/**` | 无 | D |

**A 提供、B 使用的模块边界**（`src/admin/` 内可 import，但不得改写）：

```js
// src/config/store.js —— 应用与密钥的数据层（A 所有）
listApps()                                  // -> [{appId,name,status,createdAt,updatedAt}]
getApp(appId)                               // -> 上面对象 / null
createApp_(input)                           // 见 §4，返回同上；appId 冲突抛 409
updateApp(appId, patch)                     // patch: {name?,status?}；返回同上
deleteApp(appId)                            // 物理删除：应用、密钥、词库、IP 规则，返回 {deleted:true}
issueKeys(appId, {graceMs})                 // -> {apiKey, adminKey, keyId, graceUntil} 明文只此一次
rotateKeys(appId, {graceMs})                // -> 同上；旧密钥进入宽限期
revokeKeys(appId, {reason})                 // 立即吊销当前全部生效密钥（含宽限期内旧密钥）
listKeys(appId)                             // -> [{keyId,status:'active'|'grace'|'revoked',createdAt,expiresAt,revokedAt,lastUsedAt}]
resolveToken(appId, token)                  // -> 'admin' | 'api' | null（鉴权；内部使用）
invalidateAudienceCache()                   // 由 A 的缓存层实现，B 改动密钥后必须调用
```

```js
// src/admin/index.js —— B 所有
export function initialize(ctx) { /* 建表（namespace 'admin'）、设置 ctx.admin = {...} */ }
export function registerRoutes(adminRouter, ctx) { /* 注册 §5 全部路由 */ }
export function isInitialized(ctx) { /* 是否已有超级管理员 */ }
```

```js
// src/admin-auth.js —— A 所有（B 只调用，不改）
issuePasswordResetCode()  // 生成一次性初始化口令，返回 {code, expiresAt}；库里只存哈希
consumePasswordResetCode(code) // 校验并作废，成功返回 true
passwordResetCodeState()  // -> {available:boolean, expiresAt:string|null}，供初始化页探测
hashPassword(password)    // -> 'scrypt$<n>$<r>$<p>$<saltB64>$<hashB64>'
verifyPassword(password, stored) // -> boolean，常数时间比较
```

`ctx.admin` 由 B 设置，至少提供：

```js
ctx.admin.requireSession(roles?)   // 中间件；roles 省略表示任意已登录管理员
ctx.admin.sessionFrom(req)         // -> {adminId, username, role, csrfToken} | null
ctx.admin.csrfGuard                // 中间件；写请求校验 X-CSRF-Token
ctx.admin.recordLogin({adminId, username, ok, ip, userAgent})  // 由 B 记审计
```

**A 在 `src/app.js` 中只做这三件事**：1) 迁移 core schema v2；2) `app.use('/admin', staticAssets)`；3) `app.use('/admin/api', jsonParser, demoRouter)` 按顺序挂载 B 的 `registerRoutes`；4) 启动时生成/校验初始化口令与 `MODERATION_APPS_JSON` 导入。B 需要 A 在 `app.js` 里加的挂载点只能由 A 改，A 已实现并预先留好，B 直接写 `src/admin/**` 即可。

---

## 2. 数据库表结构（core namespace，v2）

所有表由 core migration v2 建立（`migrations/002-dynamic-config.sql`）。`applications` 表已存在（`app_id TEXT PRIMARY KEY, created_at TEXT NOT NULL`），v2 用 `ALTER TABLE` 增加列，不改历史迁移文件。

```sql
-- 应用（租户）。app_id 不可修改；停用即 status='disabled'。
ALTER TABLE applications ADD COLUMN name TEXT;                 -- 展示名，可空，<= 128 字符
ALTER TABLE applications ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','disabled'));
ALTER TABLE applications ADD COLUMN updated_at TEXT;
-- 回填：UPDATE applications SET updated_at = created_at WHERE updated_at IS NULL;
-- 说明：旧库读到 status 默认 active；*_at 回填后再由代码保证非空。

-- 应用密钥（apiKey / adminKey 同表，均只存哈希）
CREATE TABLE app_keys (
  key_id TEXT PRIMARY KEY,                 -- 不透明 ID（uuid）
  app_id TEXT NOT NULL REFERENCES applications(app_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('api','admin')),
  token_hash TEXT NOT NULL UNIQUE,         -- hex(sha256(plaintext))；定长 64
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','grace','revoked')),
  created_at TEXT NOT NULL,
  expires_at TEXT,                         -- grace 到期时间；active/revoked 为 NULL
  revoked_at TEXT,
  revoked_reason TEXT,                     -- <= 128
  last_used_at TEXT                        -- 仅供参考，可空
);
CREATE INDEX app_keys_app_kind ON app_keys(app_id, kind, status);
CREATE INDEX app_keys_expiry ON app_keys(status, expires_at);

-- 管理员账号
CREATE TABLE admin_users (
  admin_id TEXT PRIMARY KEY,               -- uuid
  username TEXT NOT NULL UNIQUE,           -- 3..64，^[A-Za-z0-9._@-]+$，存原始大小写
  username_lower TEXT NOT NULL UNIQUE,     -- 小写，用于唯一性与登录查找
  display_name TEXT,                       -- <= 128，可空
  password_hash TEXT NOT NULL,             -- 'scrypt$...' 见 §3
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('super','admin','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  mfa_secret TEXT,                         -- 预留，本期恒为 NULL
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,                       -- 登录失败锁定的截止时间，可空
  last_login_at TEXT,
  password_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT                          -- 管理员 admin_id 或 NULL（初始化创建）
);
CREATE INDEX admin_users_role_status ON admin_users(role, status);

-- 管理员会话（浏览器 Cookie 的 token 只存哈希）
CREATE TABLE admin_sessions (
  session_id TEXT PRIMARY KEY,             -- uuid
  token_hash TEXT NOT NULL UNIQUE,         -- hex(sha256(token))
  admin_id TEXT NOT NULL REFERENCES admin_users(admin_id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,                -- 每会话一个，仅通过 /admin/api/session 返回
  ip TEXT,                                 -- 可空，仅记录，不做强绑定
  user_agent TEXT,                         -- <= 256
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX admin_sessions_admin ON admin_sessions(admin_id, expires_at);

-- 登录限流：按“用户名 + 客户端 IP”与“仅客户端 IP”两个维度的滑动窗口
CREATE TABLE admin_login_attempts (
  id TEXT PRIMARY KEY,
  bucket TEXT NOT NULL,                    -- 'user:<lower>@<ip>' 或 'ip:<ip>'
  success INTEGER NOT NULL CHECK (success IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX admin_login_attempts_bucket ON admin_login_attempts(bucket, created_at);
CREATE INDEX admin_login_attempts_retention ON admin_login_attempts(created_at);

-- 一次性初始化口令（库里只存哈希；全库最多一条有效记录）
CREATE TABLE setup_tokens (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,          -- hex(sha256(code))
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,                -- created_at + 24h
  consumed_at TEXT                         -- 非空即作废
);

-- 可选 OIDC 登录配置（后台录入，存数据库；未配置即不启用）
CREATE TABLE oidc_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  issuer TEXT NOT NULL,                    -- https URI
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,             -- 仅存字符串，响应中永不回显
  allowed_emails TEXT NOT NULL DEFAULT '', -- 逗号或换行分隔的邮箱/域名白名单（@example.com 表示整域）
  scopes TEXT NOT NULL DEFAULT 'openid email profile',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**保留策略**：`applications`、`app_keys`、`admin_users`、`setup_tokens`、`oidc_settings` **不是**清理目标；`admin_sessions`（过期或已吊销且 `expires_at < cutoff`）、`admin_login_attempts`（`created_at < cutoff`）由 A 注册 `ctx.cleanupHandlers` 按 365 天统一清理。

---

## 3. 密钥、口令与会话算法（固定，不得各写一套）

- 应用密钥：明文由 `crypto.randomBytes(32).toString('base64url')` 生成（43 字符）；有效期判断与比对一律用 `sha256`；**不解密不存明文**；同一 `token_hash` 全局唯一。校验使用 `timingSafeEqual`。
- 轮换宽限期：默认 1 小时（`MODERATION_KEY_GRACE_MS` 可覆盖，1 分钟 ~ 7 天），旧密钥 `status='grace'` 且 `expires_at=now+grace`；清除只影响新请求的解析顺序（同 app 同 kind 允许 >=1 条 grace）。到期后惰性变 `revoked`。
- 密码：`scrypt` N=2^15, r=8, p=1, salt 16B，key 64B，存 `scrypt$32768$8$1$<saltB64>$<hashB64>`；校验用 `timingSafeEqual`。**不引入新依赖**。
- 初始化口令：32 字节随机 → base32/base64url 明文只在容器日志打印一次；库里存 `sha256`；24 小时有效；消费即 `consumed_at`，重复消费 410。
- 会话 Cookie 名 `moderation_admin`，值 = 32 字节 base64url token；**库中存 sha256(token)**。属性固定：`HttpOnly; Path=/; SameSite=Lax; Max-Age=43200; Secure`（`Secure` 恒开；本地 http 由 §5.9 的 `MODERATION_ADMIN_INSECURE_COOKIE=1` 显式关闭）。空闲 30 分钟、绝对 12 小时过期；`last_seen_at` 每次请求推进，最多每 60 秒写库一次。
- 登出、改密、禁用账号、`POST /admin/api/sessions/revoke-all` 立即吊销相关会话行（`revoked_at` 非空）。
- CSRF：双重提交 + 服务端绑定。写请求（POST/PUT/PATCH/DELETE）必须带 `X-CSRF-Token`，值与 `admin_sessions.csrf_token` 常数时间比较；同时要求 `Origin`（若有）与请求 Host 同源，`Sec-Fetch-Site`（若有）不得为 `cross-site`。登录/初始化/登出接口同样校验 Origin，但不要求 `X-CSRF-Token`。

---

## 4. 初始化流程

1. 启动：core 迁移完成 → 若 `admin_users` 中不存在 `role='super' AND status='active'` 的账号：
   - 若 `setup_tokens` 中无未消费未过期记录，生成新口令，日志打印一行 JSON：
     `{"event":"moderation.setup_code","code":"<明文>","expiresAt":"...","hint":"POST /admin/api/setup with this code"}`
     （`code` 只在这一次日志中出现；测试可用 `options.onSetupCode` 回调注入，不读日志。）
   - 若已有未过期口令，不重复生成，只打印 `{"event":"moderation.setup_pending","expiresAt":"..."}`。
2. 初始化页（C）：`GET /admin/setup`；先 `GET /admin/api/setup`（匿名）得到 `{required, available, expiresAt}`。
3. `POST /admin/api/setup {code, username, password, displayName?}`（匿名，需 Origin 校验）→ 201 `{admin:{adminId,username,displayName,role,createdAt}}`，并**直接签发会话 Cookie**（等价于已登录）。成功后 `consumed_at` 写入，其他未消费口令一律作废，初始化页从此 `required:false`、路由返回 409 `already_initialized`。
4. 已有超级管理员时，启动不生成口令；`GET /admin/api/setup` 返回 `{required:false, available:false, expiresAt:null}`。
5. 忘记密码：`docker compose exec moderation node scripts/reset-admin.mjs [--username <name>]`——无参数时只重置 `role='super'` 的账号并打印随机新密码一次、强制 `must_change_password=1`、吊销该账号全部会话；带 `--username` 时重置该账号。脚本幂等，库不存在时报错退出码 1。
6. 口令过期或已消费后仍需要初始化（极端情况：所有超管被删）：同一个 `reset-admin.mjs --bootstrap` 可重新生成口令并打印。

---

## 5. 管理后台 API（B 实现，C 消费）

统一前缀 `/admin/api`。除标注“匿名”外，全部要求有效会话 Cookie。响应错误一律沿用统一信封 `{error,message,requestId}`（`requestId` 由 A 的中间件注入，B 不要自己生成）。

### 5.0 通用

- 分页：`?limit=50&offset=0`，`limit` 1..100，`offset` 0..1000000，返回 `{items,total,limit,offset}`（复用 `ctx.pagination`）。
- 写请求 `Content-Type: application/json`，JSON 上限 256 KiB。
- 资源不存在 404 `not_found`；字段非法 400 `invalid_request`；唯一冲突 409 `conflict`；未登录 401 `unauthorized`；角色不足 403 `forbidden`；CSRF 失败或跨站 403 `csrf_failed`；登录限流 429 `rate_limited`（带 `Retry-After` 秒）；初始化重复 409 `already_initialized`；口令无效/过期 410 `setup_code_invalid`；OIDC 未配置 404 `not_configured`。
- 角色：`super`（全部，含管理员管理）、`admin`（业务数据，含应用/密钥/词库/规则/审核/举报/审计）、`viewer`（只读 GET，写操作 403）。**除 B 自身 `GET /session`/`POST /logout` 外，`/admin/api/admins*` 与 `/admin/api/settings/oidc*` 仅 `super`。** 所有写操作记 `audit_events`，`app_id` 用特殊值 `_system`（该值在 `applications` 中预先插入一条 `status='disabled'` 的系统应用，禁止对外使用其 id 鉴权），`actor_id` 填 `admin:<adminId>`，`action` 见各接口。

### 5.1 认证

| 方法/路径 | 说明 |
| --- | --- |
| `GET /admin/api/setup` | 匿名。`{required, available, expiresAt}` |
| `POST /admin/api/setup` | 匿名。body `{code,username,password,displayName?}`；201，并在响应头 `Set-Cookie` 建立会话；无口令 410 `setup_code_invalid`；已初始化 409 `already_initialized` |
| `GET /admin/api/auth/config` | 匿名。`{passwordLogin:true, oidc:{enabled:boolean, loginUrl:string|null, issuer:string|null}}`；**未配置或 `enabled=0` 时 `oidc.enabled=false` 且 `loginUrl=null`**（C 据此不显示 OIDC 入口） |
| `POST /admin/api/session` | 匿名。body `{username,password}`；200 `{admin:{...}, csrfToken, expiresAt}` + `Set-Cookie`。失败 401 `invalid_credentials`（不区分用户不存在/密码错）；锁定或超限 429 `rate_limited` + `Retry-After`；账号 `disabled` 401 `account_disabled` |
| `GET /admin/api/session` | 返回 `{admin:{adminId,username,displayName,role,status,mustChangePassword,lastLoginAt}, csrfToken, expiresAt}`；未登录 401 |
| `DELETE /admin/api/session` | 登出，吊销当前会话；200 `{ok:true}`；幂等 |
| `POST /admin/api/session/password` | 本人改密 `{currentPassword,newPassword}`；200 `{ok:true}`，吊销**其他**会话 |
| `POST /admin/api/session/revoke-all` | 吊销本人全部会话（含当前）→ 200 `{ok:true}` |
| `GET /admin/api/auth/oidc/start` | 匿名。未启用 404 `not_configured`；302 到 issuer 的 authorization endpoint，`state`+PKCE 存服务端（`admin_sessions` 之外的短时表或带签名的 Cookie 均可，10 分钟内有效，一次性） |
| `GET /admin/api/auth/oidc/callback` | 匿名。校验 `state`/`code`、`nonce`、`iss`、`aud`、`exp`；白名单外 403 `forbidden`；成功建会话后 302 到 `/admin/`；失败 302 到 `/admin/login.html?error=oidc` |

`POST /admin/api/session` 限流：同一 `lower(username)+ip` 15 分钟内失败 5 次 → 429（`Retry-After` 为剩余秒数，至少 60）；同一 `ip` 15 分钟内失败 20 次 → 429。成功登录清除该 `user+ip` 桶的失败计数。

### 5.2 应用

| 方法/路径 | 角色 | 请求 | 成功响应 | audit action |
| --- | --- | --- | --- | --- |
| `GET /admin/api/apps` | viewer | `?status=active\|disabled` | 200 列表 `{appId,name,status,keySummary:{api:'active'\|'grace'\|'none',admin:...},createdAt,updatedAt}` | — |
| `POST /admin/api/apps` | admin | `{appId,name?}` | 201 **`{app:{...}, keys:{apiKey,adminKey}}`（明文仅此一次）** | `admin.app.create` |
| `GET /admin/api/apps/:appId` | viewer | — | 200 `{appId,name,status,createdAt,updatedAt}` | — |
| `PATCH /admin/api/apps/:appId` | admin | `{name?,status?}` | 200 app 对象 | `admin.app.update` |
| `DELETE /admin/api/apps/:appId` | super | — | 200 `{deleted:true}` | `admin.app.delete` |
| `GET /admin/api/apps/:appId/keys` | viewer | — | 200 `{items:[{keyId,kind,status,createdAt,expiresAt,revokedAt,lastUsedAt}]}` | — |
| `POST /admin/api/apps/:appId/keys` | admin | `{graceMs?}` | 201 `{apiKey,adminKey,graceUntil}`（明文仅此一次） | `admin.key.issue` |
| `POST /admin/api/apps/:appId/keys/rotate` | admin | `{graceMs?}` | 200 `{apiKey,adminKey,graceUntil}`；旧密钥进宽限 | `admin.key.rotate` |
| `POST /admin/api/apps/:appId/keys/revoke` | admin | `{reason?}` | 200 `{revoked:true}`；即刻 401 | `admin.key.revoke` |

`appId` 规则与现有一致：`^[A-Za-z0-9_-]{1,64}$`，创建后不可改。`name` 1..128。`graceMs` 1000*60..1000*86400*7，默认取服务配置。停用应用（`status='disabled'`）后，用其密钥调用任何 `/v1/*` 立即 401。删除应用需二次确认由 C 负责（前端输入 appId），接口不做确认参数。

### 5.3 词库、IP 规则、先审后发、审核队列、举报、审计

全部为**按应用**操作，路径带 `:appId`，语义与现有 `/v1/admin/*` 完全一致（字段、校验、错误码、分页），只是鉴权改为管理员会话：

| 方法/路径 | 对应 v1 接口 |
| --- | --- |
| `GET/POST /admin/api/apps/:appId/keywords`、`PATCH/DELETE /admin/api/apps/:appId/keywords/:id` | `/v1/admin/keywords` |
| `GET /admin/api/apps/:appId/keywords/export` → `{items:[{word,category,enabled}]}`（不分页，最多 50000 条，超出 413 `payload_too_large`） | 新增 |
| `POST /admin/api/apps/:appId/keywords/import` body `{items:[{word,category,enabled?}], mode:'merge'\|'replace'}`，返回 `{created,updated,skipped,total}`；单批 <= 5000 条 | 新增 |
| `GET/POST /admin/api/apps/:appId/ip-rules`、`PATCH/DELETE /admin/api/apps/:appId/ip-rules/:id` | `/v1/admin/ip-rules` |
| `GET /admin/api/apps/:appId/scenes`、`GET/PUT /admin/api/apps/:appId/scenes/:scene` | `/v1/admin/scenes` |
| `GET /admin/api/apps/:appId/reviews`、`GET /admin/api/apps/:appId/reviews/:id`、`POST /admin/api/apps/:appId/reviews/:id/resolve` | `/v1/admin/reviews` |
| `GET /admin/api/apps/:appId/reports`、`GET /admin/api/apps/:appId/reports/:id`、`POST /admin/api/apps/:appId/reports/:id/handle` | `/v1/admin/reports` |
| `GET /admin/api/apps/:appId/audit` | `/v1/admin/audit` |

导入/导出/复核的边界：`import` 整批在一个事务内完成，任何一条非法则整批 400 且不写入；`replace` 先删除该 app 该批覆盖范围内的旧词（同 category）再写。所有写入后必须调用 A 的 `invalidateAudienceCache(appId)` 并让关键词缓存失效（复用关键词模块的 `matcher.invalidate`，A 会把 matcher 挂到 `ctx.keywordMatcher`）。

### 5.4 管理员管理（仅 super）

| 方法/路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /admin/api/admins` | `?status=&role=` | 列表 `{adminId,username,displayName,role,status,lastLoginAt,createdAt,mustChangePassword}` |
| `POST /admin/api/admins` | `{username,password,displayName?,role?}` | 201 `{adminId,username,displayName,role,status,createdAt}`；密码 12..200 字符 |
| `PATCH /admin/api/admins/:adminId` | `{displayName?,role?,status?}` | 200 同上（不含密码） |
| `POST /admin/api/admins/:adminId/password` | `{newPassword, mustChangePassword?}` | 200 `{ok:true}`；吊销该账号全部会话 |
| `DELETE /admin/api/admins/:adminId` | — | 200 `{deleted:true}`；不可删除自己；不可删除最后一个 `active` 的 super（409 `last_super_admin`） |

### 5.5 OIDC 设置（仅 super）

| 方法/路径 | 说明 |
| --- | --- |
| `GET /admin/api/settings/oidc` | `{enabled,issuer,clientId,clientSecretSet:boolean,allowedEmails:[...],scopes,updatedAt}`；**永不返回 client_secret 明文** |
| `PUT /admin/api/settings/oidc` | `{enabled,issuer,clientId,clientSecret?,allowedEmails?,scopes?}`；`clientSecret` 省略则保留旧值；启用前必须能完成 discovery（失败 400 `invalid_request`，消息为 `OIDC discovery failed`） |
| `DELETE /admin/api/settings/oidc` | 删除配置，`enabled` 视为 0 |

### 5.6 健康与元信息

| 方法/路径 | 说明 |
| --- | --- |
| `GET /admin/api/meta` | viewer。`{version,setupRequired:boolean,oidcEnabled:boolean,apps:number,admin:{adminId,username,role}}` |
| `GET /healthz` | 不变：匿名 `{status:'ok'}`，不含任何配置信息 |

---

## 6. 与 `/v1` 的兼容

- `/v1` 的路径、请求字段、响应字段、错误码、`X-App-Id` + `Authorization: Bearer` 头**全部不变**。
- 鉴权来源改为数据库：`resolveToken(appId, token)` 返回 `admin|api|null`。**adminKey 仍可调用 `/v1/admin/*`，apiKey 在其上仍 403**；行为与今天一致。
- 缓存：内存缓存 `appId -> {status, keys:[{hash,kind,status,expiresAt}]}`，TTL 5 秒；任何密钥/应用变更在**同进程内立即失效**，其他进程最迟 5 秒（优于 10 分钟要求）。测试必须覆盖“吊销后立刻 401”和“跨进程 5 秒内生效”。
- 旧 `MODERATION_APPS_JSON` 导入：启动时若变量存在且非空，解析并逐个 `createApp_` + `issueKeys`（`appId` 已存在则跳过），日志打印 `{"event":"moderation.apps_imported","created":[appId...],"skipped":[appId...]}` 并追加 `{"event":"moderation.config_env_deprecated"}`；导入失败（JSON 非法/key 太短）不阻止启动，只记录 `{"event":"moderation.apps_import_failed"}`，因为数据库已有配置可用。**变量为空/缺失时完全静默，不再因缺少它而启动失败。**
- 首次以空库启动且既无管理员也无 `MODERATION_APPS_JSON`：服务正常运行，`/v1/*` 返回 401，仅管理后台可用。

---

## 7. 配置项（环境变量，全部可选）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MODERATION_DB_PATH` | `./var/moderation.sqlite` | 不变 |
| `HOST` / `PORT` | `127.0.0.1` / `4310` | 不变 |
| `MODERATION_APPS_JSON` | 无 | 兼容项，仅首次导入用 |
| `MODERATION_KEY_GRACE_MS` | `3600000` | 轮换宽限期 |
| `MODERATION_SESSION_TTL_MS` | `43200000` | 会话绝对期限 |
| `MODERATION_SESSION_IDLE_MS` | `1800000` | 空闲期限 |
| `MODERATION_ADMIN_INSECURE_COOKIE` | `0` | 置 1 时才省略 `Secure`，仅供本地 http 调试 |
| `MODERATION_PUBLIC_ORIGIN` | 无 | 可选，OIDC 回调与 Origin 校验使用的对外源，如 `https://mod.example.cn` |

---

## 8. 测试要求（各分支各自覆盖，A 合并后跑全量）

- A：迁移幂等/校验和、密钥哈希与明文不落库、轮换宽限期、吊销即刻生效、停用应用即刻 401、跨进程 5 秒刷新、口令 24 小时过期与一次性、旧 JSON 导入与重复启动幂等、`/v1` 全量兼容（现有 50 个测试不回归）、`reset-admin.mjs` 行为。
- B：登录/登出/会话过期/空闲过期/改密吊销其他会话、密码错误与限流 429、CSRF 缺失/错误 403、Origin 跨站 403、角色矩阵（viewer 写 403、admin 管理 403、super 通过）、OIDC 未配置时 `auth/config` 不暴露入口且 `start` 404、全部应用/密钥/管理员 CRUD 与审计写入。
- C：页面能加载、无外部 CDN、CSP 安全、初始化页与登录页流程、各页面增删改查走契约接口（用合同里的路径与字段）。
- D：Compose 无 `MODERATION_APPS_JSON` 必填、`.env.example` 只列可选项、nginx 示例把 `/admin` 反代到 4310、README/`deploy/README.md` 说明初始化与重置流程、`test/ext/compose.test.js` 更新。

---

## 9. 接口冻结说明

本契约在 main 首次提交后即为冻结版本。B/C/D 只用这里出现的路径与字段；需要新增字段时，先通知 A，由 A 在 main 上更新本文档，再实现。合并顺序：A（数据层）→ B → C → D，冲突由 A 解决，A 负责最终 `npm test`、`npm run lint` 和推送五个远端。
