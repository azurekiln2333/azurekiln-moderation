# 审核服务改为数据库动态配置（2026-11-03）

用户要求：审核服务作为多个项目共用的公共服务，接入应用和密钥不能写死在环境变量里，必须改成数据库动态配置并提供管理后台。部署时只需要 `docker-compose.yml`，不需要 `.env`。

## 目标

1. **零密钥部署**
   - `docker compose up -d` 即可运行，不需要 `.env`。
   - 首次启动且数据库里没有管理员时，生成一次性初始化口令，只打印到容器日志，库里存哈希，有效期 24 小时。
   - 用口令进入管理后台的初始化页，创建超级管理员。创建后口令立即作废，初始化页关闭。
   - 已有管理员时不再生成口令。忘记密码时，提供 `docker compose exec moderation node scripts/reset-admin.mjs` 重置。
2. **接入应用（租户）存数据库**
   - 应用的增删改、停用和启用。
   - apiKey 和 adminKey 的签发、轮换、吊销：明文只在创建或轮换时返回一次，库里只存哈希；轮换时支持新旧密钥在一个宽限期内并存。
   - 应用和密钥的变更在几秒内生效，不需要重启。可以用带短 TTL 的内存缓存，变更时立即失效。
3. **管理后台（Web）**：由服务自身提供，路径例如 `/admin`。不引入重型前端框架，界面简洁、清楚、可用。功能包括：
   - 应用和密钥管理；
   - 各应用的词库（分类、增删、批量导入导出）；
   - IP/CIDR 规则；
   - 先审后发开关（按 scene）；
   - 人工审核队列；
   - 举报受理和处理；
   - 审计日志查询；
   - 管理员账号管理。
4. **管理员认证**
   - 内置账号：密码用 argon2 或 scrypt 存储；会话 Cookie 设为 HttpOnly、Secure、SameSite；登录失败要限流。
   - 可选的标准 OIDC 登录：在后台配置 issuer、client_id、client_secret 和允许登录的账号白名单，配置存数据库，不配置就不启用。只用标准 OIDC discovery，不写任何特定网关的逻辑，保持解耦。
5. **兼容和迁移**
   - 启动时如果存在旧的 `MODERATION_APPS_JSON`，就把其中的应用一次性导入数据库（已存在的跳过），并在日志里提示可以删掉这个变量。之后不再依赖它。
   - 现有对外 API（`/v1/text/check` 等）、SDK、鉴权头和返回格式**完全保持兼容**，QFLI 服务端和网关不用改代码。
   - 原有按应用 adminKey 鉴权的 `/v1/admin/*` 接口继续保留。
6. **部署文件**
   - `docker-compose.yml` 去掉 `MODERATION_APPS_JSON` 必填项；`.env.example` 删除，或改为只列可选项。
   - 管理后台默认仍只绑定 `127.0.0.1`。文档说明如何用 nginx 加 HTTPS 对外提供 `/admin`。
   - 同步更新 README、`deploy/README.md`、`.trellis/spec` 和 Compose 测试。

## 要求

- 按本仓库 AGENTS.md 和 `.trellis` 规范，先用 trellis 建任务、做规划，再实现。
- 新增功能都要有测试，覆盖以下场景：
  - 初始化流程；初始化口令一次性有效、过期失效；
  - 密钥哈希存储；轮换宽限期；吊销后立即生效；停用应用后立即拒绝；
  - OIDC 未配置时不暴露登录入口；
  - 旧 JSON 配置的导入；
  - 管理接口的鉴权；CSRF 防护。
- 全量测试和 lint 必须通过。
- 提交用标准 Conventional Commits，作者保持 azurekiln2333，**不加任何署名**。
- 完成后把 main 推送到全部 5 个远端：cnb、github、gitcode、gitee、gitlab（gitlab 走 SSH），不强推。
- 结果写进 trellis 任务目录，然后结束。

## 并行分工（用户要求加速，4 个 pi 同时做）

**先写契约**：主程 A 第一件事是把数据库表结构和管理接口契约写进 `docs/proposals/dynamic-config-contract.md`，在 main 上提交。契约包括：
- 管理接口的路径、请求、响应、错误码；
- 会话和 CSRF 的机制；
- 初始化流程。

B、C、D 先做不依赖契约的部分，契约提交后按契约对接。

**隔离**：每人在自己的 git worktree 和分支上工作，不要几个人共用一个工作目录。
- 创建方式：`git worktree add ../azurekiln-moderation-<代号> -b dyn/<代号>`。
- 只提交自己负责的文件；禁止 `git add -A` 和 `git commit -a`。

| 代号 | 负责文件和内容 |
| --- | --- |
| A（主程） | 数据库迁移，应用和密钥的存储层，密钥哈希与缓存失效，初始化口令，`scripts/reset-admin.mjs`，`MODERATION_APPS_JSON` 一次性导入，对外 `/v1` 接口的兼容性，以及这些功能的测试。**最后负责把 B、C、D 的分支合并到 main**，跑全量测试和 lint，然后推送 5 个远端。 |
| B | 管理后台接口：应用和密钥的增删改、签发、轮换、吊销；管理员账号；登录会话；登录限流；CSRF；可选的 OIDC 登录。代码放在独立目录，例如 `src/admin/`，挂载入口只改一处。附带测试。 |
| C | 管理后台网页：静态资源放在独立目录，例如 `public/admin/`。包含初始化页、登录页，以及应用和密钥、词库、IP 规则、先审后发、审核队列、举报、审计日志、管理员这几个页面。轻量实现，不用重型框架。 |
| D | 部署和文档：`docker-compose*.yml`、`.env.example`、README、`deploy/` 目录（含 nginx 加 HTTPS 对外提供 `/admin` 的示例）、`.trellis/spec`、`test/ext/compose.test.js`。 |

B、C、D 完成后在各自的分支提交，**不要推送**，在终端里说明分支名，然后结束。A 等三个分支都完成后统一合并。
