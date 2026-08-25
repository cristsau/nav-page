# DOMO NAV 身份登录与邮件入口实施边界

状态：本地设计基线，未启用外部 OAuth，未配置任何平台 Secret。

## 已实现的本地候选

- 助理支持每个对话独立选择“自动跟随最新模型”或服务端目录中的固定模型，并选择 Responses API 推理强度。
- WebAuthn 精确允许 `https://nav.skrskr.net` 与 `https://nav.cristsau.cn`。
- 两个域名使用不同 RP ID，用户需分别登记 Passkey；一个域名的凭据不会被另一个域名静默接受。
- 主导航增加只读“邮件”页，读取现有加密邮件事件，不对原邮箱执行删除、移动、归档或回复。
- 设置名称改为“邮件服务（SMTP / IMAP）”，不再把界面绑定到 MXroute 品牌。

## Google 登录建议

优先实现 Google OpenID Connect Authorization Code Flow，并保留现有用户名、密码、恢复码和 Passkey。

安全约束：

1. 生产控制台必须分别精确登记两个 HTTPS 回调地址：
   - `https://nav.skrskr.net/api/auth/oauth/google/callback`
   - `https://nav.cristsau.cn/api/auth/oauth/google/callback`
2. 使用一次性、短时、服务端保存的 `state`，并校验 `nonce`；Web 客户端使用 PKCE。
3. Client Secret 只能从服务器只读 Secret 文件读取，不能写入数据库、浏览器配置或 Git。
4. 仅接受 Google 返回的已验证邮箱；首次登录仍进入 DOMO NAV 的注册审批流程。
5. 已有账号只允许登录后主动“关联 Google”，或由管理员明确确认；不能仅凭同名邮箱自动合并账号。
6. 解绑前必须确认账号仍有密码、Passkey、恢复码或另一个可用身份，避免把用户锁在门外。
7. OAuth 账号关联、解绑和登录均写入安全审计，但不记录令牌、授权码或用户资料正文。

参考：

- Google OpenID Connect: <https://developers.google.com/identity/openid-connect/openid-connect>
- Google OAuth 2.0 Web Server Flow: <https://developers.google.com/identity/protocols/oauth2/web-server>

## 微信登录建议

微信登录可以增加，但应排在 Google 之后。实施前必须由管理员登录微信开放平台，确认当前账号可创建或已拥有“网站应用”，取得实际 AppID、回调域名资格和当前平台要求。由于这些资格与审核状态属于外部账户事实，代码不能假设已经具备。

接入时沿用 Google 的账号关联、安全审计、审批和防锁号规则；微信身份以平台稳定标识保存，不能用昵称或未验证邮箱作为账号主键。

## 建议的数据模型

新增 `user_identities`：

- `user_id`
- `provider`：`google` / `wechat`
- `provider_subject_hash`：稳定平台标识的带密钥摘要
- `email_normalized` 与 `email_verified`（平台确实提供时）
- `created_at`、`last_used_at`
- 唯一约束：`(provider, provider_subject_hash)`

新增短期 `oauth_login_states`：

- 仅保存 `state` 摘要、PKCE verifier 的加密值、`nonce` 摘要、发起域名、过期时间和一次性使用时间。
- 回调必须回到发起登录的同一允许域名，消费后立即失效。

## 邮件入口的产品边界

第一版“邮件”是 DOMO NAV 的重要邮件视图，而不是完整 Webmail：

- 展示最近 100 条已接入、已加密保存的邮件事件。
- 支持 Tier 1/2/3 筛选、标题/发件人/判断原因搜索和只读正文。
- 未配置时直接引导到“邮件与云备份”。
- 只有 IMAP 连接成功后才显示同步结果。
- 暂不实现发信、删除、移动、归档、附件同步和 OAuth-only 邮箱授权。

后续若要成为完整邮箱客户端，应另立安全评审，重点处理 OAuth 令牌、附件恶意内容、远程图片追踪、HTML 清洗、发送确认和误操作恢复。

## 推荐上线顺序

1. 本批 AI 选择器、双域 Passkey、只读邮件页和通用命名。
2. 在两个域名各做一次真实 Passkey 登记、登录、删除验收。
3. 配置并验收 SMTP / IMAP 后启用邮件入口。
4. 单独开发 Google 登录，先在测试 Client 上完成账号关联与防锁号演练。
5. 微信开放平台资格确认后，再决定是否投入微信登录。
