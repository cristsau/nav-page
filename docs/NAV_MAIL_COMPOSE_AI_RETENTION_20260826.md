# DOMO NAV — 邮件撰写、AI 助理与有界保留

状态：`LOCAL_DONE / READY_FOR_CI / NOT_DEPLOYED`。本候选建立在迁移 `035_email_mailbox_foundation.sql` 的加密只读邮箱之上，并新增迁移 `036_email_ai_drafts_retention.sql`。只有 GitHub 全量 CI、PostgreSQL 16 隔离恢复和生产双域验收全部通过后，才能改为 `VERIFIED_LIVE`。

## 用户能力

- 在邮件工作台撰写新邮件或回复已经同步且归属当前用户的邮件。
- 草稿先在服务器用邮箱专用密钥加密保存；页面必须显示服务器返回的规范化内容和 SHA-256 指纹，再由用户勾选确认并第二次提交，才会进入 SMTP 队列。
- 邮件详情提供 AI 摘要、行动项、翻译和回信草稿。邮件正文始终被标记为不可信外部数据，不联网、不调用工具；邮箱地址、链接、验证码、卡号、手机号和常见密钥格式会先脱敏。
- AI 回信只进入可编辑草稿，不会自动外发。SMTP 外发也不会触发原邮箱的删除、移动、归档或已读变更。

## 发送安全模型

- 用户草稿和待发送正文只保存 AES-256-GCM 密文；`mail_outbox` 的原有明文字段使用不可投递占位值。
- API 不接受客户端伪造的 `Message-ID` 或 `References`。回复头只能从当前用户拥有的源邮件密文中解出。
- 单封邮件最多 50 个总收件人，主题最多 240 字，正文最多 80,000 字；超限直接拒绝，不静默截断。
- SMTP 成功接受邮件后立即将 outbox 密文清除并把草稿标记为 `sent`。
- SMTP 与 PostgreSQL 无法组成同一事务。若 SMTP 已接受但本地最终状态无法确认，记录会停在 `sending`，十五分钟后转为 `expired / AMBIGUOUS_DELIVERY_STATE` 并清除密文；系统不会自动重发，从而避免重复外发。
- Fastify 日志对收件人、主题、正文、AI 指令等字段做纵深脱敏，Secret 不进入浏览器、Git、PR 或日志。

## 本地缓存与容量

- 默认仅保留 180 天、每个邮箱账户最多 5,000 封本地加密缓存。
- 每次维护最多删除 200 条，并使用 PostgreSQL advisory lock 和 `FOR UPDATE SKIP LOCKED` 防止并发清理。
- 带星标或草稿标志的邮箱缓存受保护。
- 清理只作用于 NAV PostgreSQL 本地缓存、过期加密草稿及已经清除正文的终态 outbox；绝不向 IMAP 发送删除、移动或 `EXPUNGE`。
- API 数据库连接池默认最大 6，worker 默认最大 8、硬性安全下限为 5、统一上限为 32。worker 的 IMAP 主租约与两个 PostgreSQL 唤醒监听会长期占用 3 个连接，低于下限时直接拒绝启动，避免邮件分类和维护任务饥饿。

## CI 和发布门禁

1. 两次执行全部迁移并运行结构验证器，验证 `email_mailbox_state (user_id, source_key)` 复合主键、草稿/队列约束和维护任务。
2. PostgreSQL 16 集成测试必须证明：加密草稿可读、错误确认或错误指纹被拒绝、SMTP 只调用一次、成功后密文清除、重跑不会重复发送。
3. PostgreSQL 16 集成测试还必须证明：超时 `sending` 转为模糊投递终态、草稿标记失败、SMTP 不被调用。
4. 前端构建、API 全量单元测试、原有迁移/恢复/协作/搜索/Web Push 门禁全部通过。
5. 生产发布前创建与精确 merge SHA 对应的规范备份，并在一次性 PostgreSQL 16 中完成恢复、迁移 `036` 和结构验证。
6. 生产只重建 `nav-api`、`nav-web` 和 `nav-mail-worker`；PostgreSQL、CLIProxyAPI、Nginx Proxy Manager 及其他服务保持不动。

## 生产验收

- 两个域名均完成登录态邮件账户、目录、列表、正文、AI 操作和撰写弹窗检查。
- 在隔离环境使用 SMTP stub 验证完整投递生命周期；生产不向真实外部地址擅自发送测试邮件。
- 验证 worker 与 API 使用同一精确 SHA，迁移 `036` 存在，`email_cache_retention` 状态可读取且不包含正文。
- 检查 API/worker 日志不含邮箱密码、密钥、可读正文或完整收件人。

## 明确保留的后续边界

- 当前不把已发送邮件 `APPEND` 到 MXroute 的 Sent 文件夹，也没有附件撰写/上传；SMTP 是否自动留存副本取决于邮箱服务端策略。
- 远端删除、移动、归档、批量标记继续禁用，避免 NAV 与原邮箱状态冲突。
- HTML 邮件仍以安全纯文本显示；附件只显示元数据，不自动下载。

这些能力可在后续独立 PR 中增加，但不能与本次发送安全链路混在一次不可回滚的变更里。
