# DOMO NAV 身份登录与邮件入口实施边界

## 2026-09-07 最新决策：个人邮箱下线

本节覆盖下方历史邮件路线。项目所有者要求停止个人邮箱功能，聚焦现有导航、时光、AI、媒体和账号安全。
本地候选已移除邮件入口、邮箱 OAuth 管理、IMAP/分类/摘要/附件任务和 AI 邮件操作；仅保留注册验证、
审批、系统告警所用的 SMTP 通道。数据库和已发布迁移不删除，旧代码保留用于历史数据恢复测试。
状态为 `LOCAL_CANDIDATE / NOT_PUSHED / NOT_DEPLOYED`，不是生产下线完成。
详细范围和发布门槛见 [邮箱下线计划](./NAV_MAIL_RETIREMENT_20260907.md)。Google OIDC 与现有账号绑定边界不变。

## 以下为 2026-09-04 及以前的实现记录

状态：`CODE_DONE / BRAND_VERIFIED / CLIENT_CONFIGURATION_PENDING`。身份 OAuth 与 OAuth-only 邮箱 Provider 已形成可测试的代码；2026-09-04 项目所有者提供的 Google Auth Platform 页面显示 DOMO NAV 品牌已通过验证。该证据不等于 OAuth Client、Secret、真实绑定、双域登录或生产验收已经完成。

## 已实现的本地候选

- 助理支持每个对话独立选择“自动跟随最新模型”或服务端目录中的固定模型，并选择 Responses API 推理强度。
- WebAuthn 精确允许 `https://nav.skrskr.net` 与 `https://nav.cristsau.cn`。
- 两个域名使用不同 RP ID，用户需分别登记 Passkey；一个域名的凭据不会被另一个域名静默接受。
- 主导航“邮件”页读取现有加密邮件缓存，并在本批候选中加入受冲突保护的远端已读、星标、归档、移动、Trash 与永久删除命令。
- 设置名称改为“邮件服务（SMTP / IMAP）”，不再把界面绑定到 MXroute 品牌。
- 新增 Google OIDC 与微信网站 OAuth 的服务端身份框架、登录页入口、登录后绑定/安全解绑和管理员自助配置 UI。
- 新增 Google / Microsoft 邮箱 Refresh Token Provider，向 IMAP 提供 XOAUTH2 `accessToken`，向 SMTP 提供 Nodemailer OAuth2 auth；默认关闭且不影响现有密码模式。

## Google 登录（本地候选已实现）

优先实现 Google OpenID Connect Authorization Code Flow，并保留现有用户名、密码、恢复码和 Passkey。

安全约束：

1. 生产控制台必须分别精确登记两个 HTTPS 回调地址：
   - `https://nav.skrskr.net/api/auth/oauth/google/callback`
   - `https://nav.cristsau.cn/api/auth/oauth/google/callback`
2. 使用 10 分钟一次性服务端状态、签名 HttpOnly Cookie、`state` / `nonce` 摘要与 Authorization Code + PKCE S256；回调事务原子消费，不能重放。
3. Client Secret 只能从服务器只读 Secret 文件读取，不能写入数据库、浏览器配置或 Git。
4. 仅接受 Google 返回的已验证邮箱。默认必须先密码登录再主动绑定，不创建或绕过审批。
5. “按已验证邮箱自动关联”是默认关闭的管理员开关；即便开启，也只匹配已审批且 DOMO NAV 邮箱已验证的唯一现有账号。
6. 绑定和解绑均要求当前密码；临时验收账号禁止操作，密码登录凭据保留，避免锁号。
7. OAuth 账号关联、解绑和登录均写入安全审计，但不记录令牌、授权码或用户资料正文。

控制台字段、两条精确回调、DOMO NAV 管理界面填写位置和双域验收顺序见
[`NAV_GOOGLE_LOGIN_SETUP.md`](./NAV_GOOGLE_LOGIN_SETUP.md)。登录功能只申请
`openid email profile`；下方邮箱 OAuth 仅为历史记录，不再是当前开放能力。

参考：

- Google OpenID Connect: <https://developers.google.com/identity/openid-connect/openid-connect>
- Google OAuth 2.0 Web Server Flow: <https://developers.google.com/identity/protocols/oauth2/web-server>

## 微信登录（本地候选已实现，平台资格待确认）

微信登录可以增加，但应排在 Google 之后。实施前必须由管理员登录微信开放平台，确认当前账号可创建或已拥有“网站应用”，取得实际 AppID、回调域名资格和当前平台要求。由于这些资格与审核状态属于外部账户事实，代码不能假设已经具备。

代码沿用一次性签名 `state`、同域回调、账号关联、安全审计、审批和防锁号规则。微信网站 OAuth 不提供标准 OIDC `nonce`/PKCE 回显能力，因此本地仍生成并校验事务 nonce 摘要，但外部协议只能依赖一次性签名 state。身份优先使用 `unionid`，无 unionid 时使用 `openid`，再以服务器 HMAC 摘要保存；绝不按昵称或邮箱合并。

## 建议的数据模型

迁移 `040_oauth_identity.sql` 新增 `oauth_identities`：

- `user_id`
- `provider`：`google` / `wechat`
- `subject_digest`：稳定平台标识的服务器 HMAC 摘要，原始 subject 不落库
- `email_verified_at`（平台确实提供且通过校验时）
- `created_at`、`last_used_at`
- 唯一约束：`(provider, provider_subject_hash)`

新增短期 `oauth_authorization_requests`：

- 仅保存 `state` 摘要、`nonce` 摘要、发起域名、流程、过期时间和一次性使用时间；PKCE verifier 只存在短时签名 HttpOnly Cookie 中。
- 回调必须回到发起登录的同一允许域名，消费后立即失效。

## OAuth-only 邮箱 Provider

- 支持 Google 固定 Token Endpoint 与 Microsoft tenant-scoped v2 Token Endpoint 的标准 Refresh Token 流。
- Client Secret 与 Refresh Token 使用 owner-only `0600` 文件；API 只返回 `configured` 布尔值，不回显正文。
- 管理员可在无 Secret 时先保存禁用配置并检查固定端点/结构；这不等同于真实授权成功。
- 只有 Client ID、Client Secret、Refresh Token 全部存在、Provider 已启用并被选中后才切换 IMAP/SMTP OAuth。
- 当前 OAuth 骨架不代替 Provider Consent 流；管理员仍须在 Google/Microsoft 控制台创建应用并安全取得 refresh token。

## 邮件入口与远端命令边界

“邮件”仍不是完整 Webmail，但本批已从只读视图推进为受控邮箱工作台：

- 展示最近 100 条已接入、已加密保存的邮件事件。
- 支持 Tier 1/2/3 筛选、标题/发件人/判断原因搜索和只读正文。
- 未配置时直接引导到“邮件与云备份”。
- 只有 IMAP 连接成功后才显示同步结果。
- 本批候选通过数据库 outbox、用户级幂等键、10 秒撤销、UIDVALIDITY/MODSEQ/flags 前置条件和写后复核执行远端命令。
- 支持已读/未读、星标/取消、归档、移动、Trash；永久删除还要求输入 `DELETE_PERMANENTLY`，且邮件必须位于 Trash/Junk 或已带 `\\Deleted`。
- 移动/删除结果不明确时进入冲突状态，不盲目重试；flags 操作只在目标状态可安全确认时对账。
- 真实邮箱远端写入不属于合成发布验收，必须由专用测试邮箱另行完成一次端到端验证后才能声明真实 Provider 已验证。

后续若要成为完整 Webmail，仍应另立安全评审，重点处理 OAuth 同意流、附件恶意内容、远程图片追踪、完整 HTML 编辑、会话/草稿同步和误操作恢复。

## 推荐上线顺序

1. 先合并本地代码并在隔离 PostgreSQL 验证 `040` 迁移、约束、回滚策略与定向测试。
2. 在 Google 测试 Client 精确登记双域回调，完成 state/nonce/PKCE、绑定、审批、自动关联默认关闭、解绑与审计验收。
3. 确认微信开放平台网站应用资格后，以测试 AppID 完成双域回调和稳定 subject 验收。
4. 邮箱 OAuth 先以测试账号取得 refresh token，验证 IMAP XOAUTH2 / SMTP OAuth2；未通过前保持 selected provider 为空。
5. 真实 Secret 写入生产 owner-only 文件后再逐项启用，任一 Provider 验收失败只关闭对应开关，不影响密码登录和密码邮箱模式。
