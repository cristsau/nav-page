# DOMO NAV — MXroute 邮件、通知中心与独立 AI 助理

状态：代码完成后默认关闭，必须先迁移、备份、配置密钥并逐项验收再启用。

## 架构边界

- Cloudflare 继续负责 DNS 解析与 NAV Web 代理；域名邮件的 MX/SMTP/IMAP 服务由 MXroute 承接。
- MXroute 负责 SMTP 发信与 IMAP 收信。主机名必须使用 MXroute 账户显示的实际 `Server Name`，不要填写 `nav.skrskr.net`、`ap.skrskr.net` 或示例域名。
- SMTP 使用 TLS 465；IMAP 使用 TLS 993；账号均为完整邮箱地址。
- 浏览器 Web Push 只发送“DOMO NAV 有一条重要提醒”这类通用文案。发件人、主题、正文、验证码和链接都不会进入推送载荷。
- 邮件原文在 PostgreSQL 中仅保存 AES-256-GCM 密文。AI 助理只要引用了邮件，其回答同样加密保存；对话表的明文字段只留通用占位文字和来源 ID。密钥是独立的 32 字节服务端密钥，不复用笔记密码，也不进入数据库、Git 或环境变量。
- AI 助理只读检索导航、未加密笔记、备忘录提醒及邮件分类结果，不具备删除、修改或外部执行工具。
- 仓库中原有 Telegram 配置与兼容接口暂时保留，避免旧部署升级时断裂；本次新增的注册、邮件、提醒和维护告警流程均不会调用 Telegram。后续确认线上不再有任何旧调用后，再单独做可回滚的清理 PR。

## 已实现功能

1. 通知中心：未读数、查看、全部已读、删除；支持重要邮件、邮件摘要、注册申请和后台任务告警。
2. Web Push：通知中心的通用消息复用现有设备订阅；敏感详情只能登录后查看。
3. 注册邮件：申请人先验证邮箱，再进入管理员审批；管理员收到站内通知和邮件；审批结果发回申请邮箱。验证链接过期后可以隐私保护方式重发，页面不泄露邮箱是否存在。
4. MXroute 收件：IMAP IDLE 为主、定时轮询兜底；只读取 INBOX 新邮件；忽略附件和远程资源；单封大小有硬上限。
5. 邮件分级：确定性高危/营销规则加 AI 六维分类；AI 不可用时保守进入 Tier 2，明显高危进入 Tier 1。
6. 去重：邮件 Message-ID 防重，同时使用事件签名和状态签名抑制相同状态的重复提醒。
7. 摘要：Tier 2 在配置的本地小时生成站内摘要和通用 Web Push。
8. 独立助理页 `/assistant`：SSE 流式回答、对话历史、搜索、删除、Markdown 导出与来源卡片；邮件通知可直接打开加密详情。

## 上线前需要准备的值

不要在聊天、PR、Issue 或文档里粘贴真实密码。

- `NAV_SMTP_HOST` / `NAV_IMAP_HOST`：MXroute 实际 Server Name。
- `NAV_SMTP_USERNAME` / `NAV_IMAP_USERNAME`：完整邮箱地址。
- `NAV_SMTP_FROM_ADDRESS`：发件邮箱。
- `NAV_ADMIN_EMAIL_RECIPIENTS`：管理员收件地址，可用逗号分隔。
- `NAV_EMAIL_OWNER_USERNAME`：接收邮件数据的现有 NAV 用户名。
- `smtp-password`：邮箱 SMTP 密码，只读、仅属主可读。
- `imap-password`：邮箱 IMAP 密码，只读、仅属主可读。若两者相同也保持两个文件，方便独立轮换。
- `email-encryption-key`：随机 32 字节，建议以 64 位十六进制保存。丢失后历史邮件不可恢复，必须纳入加密异地备份。

密钥文件的目标挂载路径已经写入 `docker-compose.backend.yml`。生产主机的 `NAV_SECRETS_DIR` 必须指向当前 release 专属目录。

## Cloudflare DNS 与 MXroute 检查点

- Cloudflare 中保留 MXroute 提供的 MX 记录，优先级和目标必须与 MXroute 控制台一致；不要猜测或照抄其他账号的值。
- MXroute 提供的 SPF 与 DKIM DNS 记录必须在 Cloudflare 中完整保留；DMARC 建议先以报告模式验证，再逐步收紧。
- 邮件主机名的 A/CNAME 记录必须是 **DNS only**，不能使用 Cloudflare 橙云代理 SMTP/IMAP。
- 如果曾启用 Cloudflare Email Routing，必须确认它没有改写或与 MXroute 的 MX 记录冲突。
- NAV 服务器连接的是 MXroute 面板显示的实际 `Server Name`，而不是 Cloudflare 中的 NAV 站点域名。
- `NAV_SMTP_FROM_ADDRESS` 应使用 MXroute 中真实存在、允许发信的邮箱；不要伪造其他域名的 From 地址，否则即使 SMTP 登录成功，也可能被 SPF/DMARC 拒收。

## 常见排错

- “已进入发送队列”只代表 PostgreSQL 已接收任务，不代表 MXroute 已投递。请在“设置 → 用户管理 → MXroute 邮件通道”查看配置状态，并用管理员测试功能完成真实收信验收。
- 测试邮件未收到时，依次检查 MXroute Server Name、完整邮箱账号、secret 文件权限、垃圾邮件目录，以及 Cloudflare 中 MX/SPF/DKIM 是否完全匹配 MXroute 面板。
- SMTP/IMAP 主机如果填写为站点域名，或对应记录开启了 Cloudflare 橙云，连接通常会失败；邮件协议记录必须保持 DNS only。
- 验证邮件可用登录页的隐私保护入口重发。无论邮箱是否存在，接口都返回相同结果，避免泄露注册状态。

## 推荐启用顺序

每一步完成后观察后台维护状态，再进入下一步：

1. 保持所有新开关为 `false`，执行 029、030 迁移并完成隔离 PostgreSQL 恢复演练。
2. 配置 SMTP 与三份 secret 文件，只打开 `NAV_MAIL_DELIVERY_ENABLED=true`；在“设置 → 用户管理 → MXroute 邮件通道”发送测试邮件，并核对队列正文发送后已清空。
3. 打开 `NAV_REGISTRATION_EMAIL_ENABLED=true`，用非管理员邮箱完成“申请、验证、审批、结果邮件”闭环。
4. 配置 IMAP 与邮件属主，只打开 `NAV_EMAIL_INGEST_ENABLED=true`；首期默认 `NAV_IMAP_INITIAL_LOOKBACK=1000`、`NAV_IMAP_BATCH_SIZE=100`，核对分类、批量游标和重复抑制。加密邮箱缓存、独立 worker 与只读工作台的完整边界见 `NAV_MAILBOX_SYNC_FOUNDATION.md`。
5. 已有 Web Push 设备正常后打开 `NAV_EMAIL_DIGEST_ENABLED=true`。
6. 最后才启用 `NAV_MAINTENANCE_ALERTS_ENABLED=true`。SMTP 任务自身失败时依赖站内通知与 Web Push，不会递归写入自己的发送队列。

## 验收清单

- 双域登录状态正常，`/assistant` 可刷新持久化。
- 助理回答的每个来源都属于当前登录用户，且没有访问加密笔记。
- 浏览器网络面板中的 Web Push 注册、通知 API、助理 SSE 均不包含邮箱密码或邮件正文。
- 注册验证 token 只存在 URL fragment，验证后立即从地址栏清除。
- PostgreSQL 中 `email_events.content_encrypted` 不含可读主题/正文。
- 引用了邮件的对话中，`assistant_messages.content_sensitive=true`，真实回答只存在 `content_encrypted`，明文 `content` 不含邮件内容。
- 关闭 AI 或使 AI 临时不可用时，邮件进入确定性/保守分级，助理降级为来源列表。
- 删除对话只影响当前用户；通知和邮件详情同样做用户归属检查。
- SMTP 成功后 `mail_outbox.text_body` 与 `html_body` 被清空。
- IMAP 断线可重连；UID 状态不会导致已处理邮件重复入库。

## 回滚

- 功能回滚优先关闭四个开关：邮件发送、注册邮件、IMAP 收件、摘要任务。
- 029、030 仅新增列和表。应用回滚可保留这些结构，避免破坏已产生的数据。
- 不要在没有独立可恢复备份前删除邮件加密密钥或新表。

## 官方参考

- [MXroute SMTP / IMAP / POP Connection Details](https://mxroutedocs.com/general/smtpimappopdetails/)
- [ImapFlow client API](https://imapflow.com/docs/api/imapflow-client/)
- [ImapFlow message fetching](https://imapflow.com/docs/examples/fetching-messages/)
