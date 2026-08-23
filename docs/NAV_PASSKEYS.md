# NAV Passkey / WebAuthn

## 状态边界

Passkey 源码切片已经实现，但 `NAV_WEBAUTHN_ENABLED` 默认是 `false`。在迁移、CI、主域名和
真实设备验收完成前，不应把它描述为生产已启用。

- 唯一 RP ID：`nav.skrskr.net`
- 唯一允许的 WebAuthn Origin：`https://nav.skrskr.net`
- `https://nav.cristsau.cn`：继续支持密码、恢复码登录，但不参与 Passkey 仪式
- 服务端：`@simplewebauthn/server` 13.3.x
- 浏览器端：`@simplewebauthn/browser` 13.3.x

实现以 SimpleWebAuthn 官方的
[服务端文档](https://simplewebauthn.dev/docs/packages/server/)和
[浏览器端文档](https://simplewebauthn.dev/docs/packages/browser/)为准；没有自行实现
WebAuthn 签名、挑战或凭据验证算法。

RP ID 和 Origin 在服务端代码中固定，不允许用环境变量临时改成另一个域名。这样可以防止一次
错误配置让已登记的 Passkey 全部不可用，或让别名域意外扩大认证边界。

## 安全设计

- 挑战写入 PostgreSQL，5 分钟到期，并通过条件 `UPDATE` 原子标记为已使用。
- 挑战在调用官方验证器前完成一次性消费；即使验证失败也不能重放。
- 登记 Passkey 和删除 Passkey 都必须重新输入当前密码。
- 登记挑战同时绑定用户和当前会话；其他账号或会话不能完成该挑战。
- 登录先使用现有 PostgreSQL 持久化 IP 限流，再使用用户名摘要维度限流。
- 登录选项对存在、不存在、未批准或没有 Passkey 的用户名返回相同结构；最终失败只返回通用错误。
- 成功登录继续写入现有 `sessions` 表，并使用原有 HttpOnly/Secure Cookie 和会话撤销机制。
- 使用一次性恢复码重设密码时会同时撤销所有会话并删除现有 Passkey，防止旧认证器立即重新登录。
- 认证器签名计数器在凭据行锁内校验和更新。
- 审计仅写入结构化事件和已有的带密钥指纹，不记录挑战、凭据 ID、公钥或浏览器响应。
- Passkey 公钥和凭据元数据进入 PostgreSQL 备份，但不会进入面向用户的 JSON 数据导出。

## 数据库

迁移 `019_webauthn_passkeys.sql` 新增：

- `webauthn_credentials`：用户、凭据 ID、公钥、计数器、传输方式、设备类型、备份状态和显示名称。
- `webauthn_challenges`：登记/认证挑战、用户/会话绑定、固定 RP/Origin、到期与消费时间。

两张表都使用现有用户/会话外键和级联删除；迁移是附加式的，不改写现有密码、恢复码或会话数据。

## API

公开：

- `GET /api/auth/passkeys/config`
- `POST /api/auth/passkeys/login/options`
- `POST /api/auth/passkeys/login/verify`

登录后：

- `GET /api/auth/passkeys`
- `POST /api/auth/passkeys/register/options`
- `POST /api/auth/passkeys/register/verify`
- `DELETE /api/auth/passkeys/:passkeyId`

除配置读取和凭据列表外，Passkey 操作都要求浏览器 `Origin` 与规范主域完全相等。删除在功能开关
关闭时仍然允许，以便用户清理已有凭据，但仍只允许从规范主域发起且必须验证当前密码。

## 启用步骤

1. 在 GitHub Linux CI 完成 `npm ci`、API 全量测试、迁移校验和 Vite 构建。
2. 对 PostgreSQL 做当前备份，并在隔离 PostgreSQL 16 中执行和验证迁移 019。
3. 先以 `NAV_WEBAUTHN_ENABLED=false` 发布，确认密码、恢复码、会话撤销和两个域名均未回归。
4. 确认反向代理保留真实 HTTPS Origin，主域证书和 `https://nav.skrskr.net` 均稳定。
5. 仅将 API 环境的 `NAV_WEBAUTHN_ENABLED` 改为 `true`，重建 API 后检查配置接口。
6. 在真实 Windows/Edge、iPhone/Safari 至少各完成一次登记、退出、Passkey 登录和删除。
7. 在 `nav.cristsau.cn` 确认页面明确提示密码登录，Passkey options/verify 返回 403。
8. 核对 `auth.passkey.register`、`auth.passkey.login`、`auth.passkey.delete` 审计记录不含敏感载荷。

## 回退

紧急回退只需恢复 `NAV_WEBAUTHN_ENABLED=false` 并重建 API；密码、恢复码和现有会话保持可用。
迁移 019 的表可以保留，避免破坏已登记凭据。只有在明确确认不再需要任何 Passkey 且已有备份时，
才能另行规划数据删除；普通发布回退不得删除这两张表。
