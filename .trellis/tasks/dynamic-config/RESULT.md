# 动态配置改造：完成记录

任务书：[docs/proposals/dynamic-config.md](../../../docs/proposals/dynamic-config.md)
执行契约：[docs/proposals/dynamic-config-contract.md](../../../docs/proposals/dynamic-config-contract.md)

## 结果

审核服务不再依赖 `MODERATION_APPS_JSON`。应用、密钥、管理员、会话、OIDC 配置全部存数据库，
管理后台由服务自身提供（`/admin`），`docker compose up -d` 零密钥启动。对外 `/v1/*` 契约未变。

主分支：`main`，最终提交 `c38ae40`，已推送到 cnb / github / gitcode / gitee / gitlab（快进，未强推）。

## 分工与提交

| 分支 | 内容 | 关键提交 |
| --- | --- | --- |
| main（A） | 契约冻结 | `9676016` docs(proposals) |
| main（A） | 数据层：迁移 v2/v3、应用与密钥存储、密钥哈希与缓存失效、初始化口令、`reset-admin.mjs`、旧 JSON 导入、`/v1` 兼容 | `8510030`、`24666dd`、`ff7e24f` |
| dyn/B | 管理后台 API：`src/admin/**`（应用/密钥、管理员、会话、限流、CSRF、OIDC、租户路由） | `5a7e5cd` |
| dyn/C | 管理后台网页：`public/admin/**`、`src/admin-ui/index.js` | `1d87ea8` |
| dyn/D | 部署与文档：compose、`.env.example`、README、`deploy/**`、`.trellis/spec`、compose 测试 | `f77c2bb`、`0fd5242` |

合并后由 A 做的集成修复：

| 提交 | 内容 |
| --- | --- |
| `f96d402` | 前端 API 客户端改为按契约路径；租户路由传入 service 模块（scenes/reviews/reports 曾 404）；静态资源根目录修正（`/admin/` 曾 404）；允许无请求体的 DELETE（前端删除曾 415） |
| `7af2a89` | 未知/保留（`_system`）/非法 appId 在 `/admin/api/apps/:appId/**` 上一律 404（此前返回空集合，写接口可打到任意 id） |
| `87585e4` | `/admin` 静态服务统一走 `src/admin-ui`，去掉重复实现 |
| `d919399` | 文档承诺的 `/admin/setup`、`/admin/login` 由 404 改为重定向到 hash 路由 |
| `ff7e24f` | **升级缺陷修复**：老库中已存在但尚无密钥的应用，此前被导入逻辑跳过，升级后所有请求 401 且日志提示可删变量；现改为无活跃密钥时接管旧密钥 |
| `b005f9d` | 把管理后台不变量写进 `.trellis/spec/backend/moderation-contract.md` |
| `c38ae40` | 用 Node 直接驱动真实 `public/admin/js/api.js` 打真实服务的端到端测试 |

## 验证

- `npm test`：137 项，132 通过，5 跳过（需要 Docker Compose CLI 的 compose 测试，本机无 Docker），0 失败。
- `npm run lint`：61 个文件语法检查通过。
- `node --test scripts/publish-ci.test.mjs`：7 通过。
- 手工验证（临时脚本，未提交）：
  - 空库首启打印一次性口令；重启复用同一口令，只打印 `moderation.setup_pending`，不重复生成。
  - `docker compose` 场景外的生产启动：`/healthz` 200、`/admin/` 200、匿名 `/v1` 401。
  - 旧库（仅 core/1，含应用与词库）升级到 core/3 后数据保留，旧 API 密钥继续可用。
  - 管理后台全流程：初始化 → 登录 → 建应用/密钥 → 词库导入导出 → IP 规则 → 先审后发 → 审核/举报/审计 → 轮换/吊销 → 停用应用。

## 已知边界

- rate limit 的 IP 桶在 `trust proxy=false` 下对所有经 nginx 的请求都是 `127.0.0.1`，即 IP 桶实际是全局桶；
  按用户名+IP 的桶仍按账号生效。改动它会引入代理头伪造风险，故保持现状并记录在此。
- OIDC 的 ID token 只在使用 TLS 的 token endpoint 响应内解码并校验 `iss/aud/exp/nonce` 与白名单，
  不额外做 JWKS 签名验证（机密客户端 code flow 的通行信任模型），已在 spec 中写明。
- 浏览器端未做真实浏览器测试；以 Node 驱动真实前端 API 模块 + 静态资源与 CSP 断言代替。
