# DOMO NAV — 邮件与云备份自助配置

状态：本分支为本地发布候选。代码、接口和设置页已实现；在合并并发布到生产前，线上仍保持原有邮件关闭状态。

## 解决的问题

- 管理员可以在“设置 → 邮件与云备份”中填写 MXroute SMTP/IMAP 参数，不再需要把邮箱密码写进仓库或聊天。
- 管理员可以填写 Cloudflare R2、Backblaze B2、Wasabi、MinIO 等 S3 兼容对象存储，并执行只读连接测试。
- 所有密码和访问密钥都是只写字段：浏览器只能看到“已配置”，API 永远不会返回原值。
- 修改主机、账号、Bucket 或密钥会立即让旧验证失效；必须先保存、再测试，测试通过后才能启用相关任务。
- 邮件任务可以在 API 运行期间安全地重新配置；不需要为了开关 SMTP/IMAP 而重启整个数据库或代理栈。

## 管理员操作流程

### MXroute 邮件

1. 在 MXroute 面板确认真实 Server Name、完整邮箱账号与密码。
2. 填写 SMTP 主机、邮箱账号、发件地址和密码，保存配置。
3. 点击“测试 SMTP”。只有 TLS 465 验证成功后，才能启用发送队列和注册邮件。
4. 填写 IMAP 主机、归属 NAV 用户、完整邮箱账号和密码，保存配置。
5. 点击“测试 IMAP”。只有 TLS 993 验证成功后，才能启用智能收件和每日摘要。
6. Cloudflare 只负责 DNS；邮件服务记录必须使用 MXroute 提供的 MX/SPF/DKIM，邮件主机不能经过橙云代理。

### S3 兼容云备份

1. 创建一个只属于 NAV 备份 Bucket 的最小权限访问密钥。
2. 填写 HTTPS Endpoint、Bucket、Region、前缀、寻址方式和访问密钥，保存配置。
3. 点击“只读测试存储”。测试只执行 `ListObjectsV2`，最多请求一个对象，不上传、不删除。
4. 测试通过后可以打开“允许主机任务上传加密备份”。这只生成主机任务所需配置；Web/API 进程不会执行 root 备份或恢复。
5. OVH 上的备份 timer 仍需由运维人员单独安装和启用。UI 会分别显示“配置已保存”“存储已验证”“主机任务已安装”“timer 已启用”，不会把其中任何一步误报成完整异地备份。

## 服务器目录与权限

生产 Compose 使用：

```text
NAV_INTEGRATIONS_DIR=/etc/nav/integrations
NAV_MANAGED_INTEGRATIONS_DIR=/etc/nav/integrations
```

同一绝对路径以可写 bind mount 提供给 `nav-api`。目录必须是普通目录、不能是符号链接，权限为 `0700`；配置、Secret 和生成的环境文件均为 `0600`。

目录可能包含：

```text
integrations.json
smtp-password
imap-password
email-encryption-key
s3-access-key-id
s3-secret-access-key
s3-session-token
restic-password
restic-offsite.env
cloud-backup.env
cloud-backup-agent.json
```

这些文件不得提交 Git，不得复制到 Issue/PR/聊天，也不得出现在应用日志。API 日志已对对应请求字段做脱敏。

## API 边界

所有接口都要求已登录管理员，并返回 `Cache-Control: private, no-store`：

- `GET /api/admin/integrations`：只返回公开配置、布尔状态和验证时间。
- `PUT /api/admin/integrations/mail`：保存邮件配置与只写 Secret。
- `POST /api/admin/integrations/mail/test-smtp`：验证已保存的 SMTP 配置。
- `POST /api/admin/integrations/mail/test-imap`：验证已保存的 IMAP 配置。
- `PUT /api/admin/integrations/cloud-backup`：保存对象存储配置与只写 Secret。
- `POST /api/admin/integrations/cloud-backup/test`：对已保存配置执行只读 S3 测试。

页面不会把尚未保存的密码直接送到测试接口；必须先保存，避免用户误以为测试的是屏幕上尚未落盘的值。

## 安全约束

- SMTP 固定 TLS 465，IMAP 固定 TLS 993，TLS 最低版本 1.2，证书必须有效。
- S3 Endpoint 必须使用 HTTPS，禁止 URL 内嵌凭据、查询参数和 fragment。
- SMTP、IMAP 与 S3 连接前会拒绝本机、私网、链路本地和不可解析的主机。
- 私有网络中的受信 MinIO/邮件服务必须由运维人员显式设置 `NAV_ALLOW_PRIVATE_INTEGRATION_ENDPOINTS=true`；默认保持关闭，且不复用 AI 的私网放行开关。
- HTTP 重定向被拒绝，避免凭据被带到不同目标。
- Secret 不进入 `integrations.json`，配置读取接口只返回 `...Configured` 状态。
- 邮件正文与引用邮件的 AI 回答继续使用独立 AES-256-GCM 密钥加密。
- Restic 密码由服务器生成，备份在上传前加密；丢失该密码将无法恢复云端仓库，必须另行纳入安全恢复凭据保管。

## 发布与验收

发布时需要同时重建 `nav-api` 和 `nav-web`，但不需要新数据库迁移。发布前仍须执行 canonical PostgreSQL 备份与隔离恢复演练。

最低验收项：

- 双域登录和设置分类正常。
- Secret 保存后刷新页面只显示“已配置”，浏览器响应中没有原值。
- 未保存修改时测试按钮禁用并提示先保存。
- SMTP、IMAP、S3 错误只返回安全摘要，不回显密码、访问密钥或上游完整响应。
- 未验证时无法启用发送、收件或云上传；修改连接字段后旧验证自动失效。
- AI 助理在没有站内来源时仍调用已配置模型回答问候和一般知识；需要私人数据但没有来源时明确说明缺少依据。
- 当前生产邮件开关在真实连接验收完成前保持关闭；云备份 timer 在首次成功上传和恢复演练前不得标记为“已完成异地备份”。

## 回滚

- 关闭邮件和云上传开关不会删除任何邮件事件、通知、备份或 Secret。
- 应用回滚不会修改 PostgreSQL 029/030 结构。
- 旧应用不会读取 `/etc/nav/integrations`；保留该目录即可再次升级，不要在回滚时删除密钥。
- 任何生产恢复仍必须走独立授权、最后时刻备份、隔离验证和明确切换流程，Web 页面不提供直接恢复按钮。
