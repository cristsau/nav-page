# DOMO NAV — 邮件附件与 Sent 同步

状态：`LOCAL_DONE / RELEASE_AUTHORIZED / NOT_DEPLOYED`。

本候选建立在邮件工作台、加密草稿与 SMTP 队列能力之上，新增收件附件按需下载、发件附件安全暂存，以及 SMTP 成功后的 Sent 文件夹幂等同步。生产环境尚未发布；Sent 同步开关默认关闭，也不会为历史已发送邮件补写 Sent 副本。

## 生产语义索引兼容修复

2026-08-27 的生产只读诊断确认，本地语义索引连续失败并非数据库或文档损坏，而是 OVH 本地缓存的 `node:24-bookworm-slim` 标签实际指向 Alpine/musl。`onnxruntime-node` 的 Linux x64 原生库依赖 glibc 加载器，因此在该错误镜像中触发 `ERR_DLOPEN_FAILED`；普通检索会降级为 BM25，但语义排序不可用。

本候选同时加入以下不可绕过门禁：

- API 基础镜像固定到经 Docker 官方 Registry 核验的 `node:24-bookworm-slim` OCI 索引摘要。
- 镜像构建阶段要求 `/etc/os-release` 的 `ID=debian`，且 `getconf GNU_LIBC_VERSION` 成功。
- 镜像构建阶段直接加载 `onnxruntime-node`；原生运行时不可用时构建立即失败。
- GitHub CI 独立使用 `docker build --pull` 构建生产 API 镜像，并再次验证 release 标签、Debian/glibc 与原生运行时。
- OVH 发布必须拉取固定摘要、构建候选镜像并通过相同门禁后才能切换；不得用 `gcompat` 或修改运行中容器掩盖问题。

## 本地实现范围

### 收件附件按需下载

- 邮件同步阶段仍只保存附件元数据，不主动下载附件正文，也不在浏览器中自动预览。
- 用户明确点击下载时，服务端根据当前用户、邮箱账户、目录位置、UID 和 UIDVALIDITY 重新向 IMAP 拉取原始邮件，再按稳定附件 ID 选取目标附件。
- 下载接口固定使用附件响应，并设置 `no-store`、`nosniff`、同源资源策略和沙箱 CSP，降低浏览器误执行风险。
- 远端目录的 UIDVALIDITY 已变化、邮件 UID 已失效、附件元数据不匹配或大小超限时，下载会拒绝并要求刷新邮箱，不会猜测或返回其他附件。

### 发件附件安全暂存

- 每个附件最大 `10 MiB`，每封邮件最多 `10` 个附件、合计最大 `25 MiB`；每位用户尚未完成投递的附件暂存总量最大 `100 MiB`。
- 附件按 `256 KiB` 分块，以 AES-256-GCM 独立加密保存；文件名、内容类型等元数据也以密文保存。
- 草稿、附件对象和 SMTP outbox 使用同一用户归属约束。附件进入发送队列时由 `draft` 原子转为 `claimed`，避免同一附件被两个投递任务重复认领。
- 浏览器确认发送时使用的草稿 SHA-256 指纹同时绑定规范正文和有序附件清单。附件新增、删除、大小、摘要或顺序变化都会使旧确认失效，必须重新核对。
- 邮件发送完成或进入不可恢复终态后清除附件密文；数据库仅保留有界生命周期与不可逆摘要证据。

### SMTP 投递安全

- 发信前生成并冻结一份完整 MIME，发送信封与 MIME 内容分离；密送地址只进入 SMTP envelope，不写入 MIME 的 `Bcc` 头。
- SMTP 尚未开始前的本地准备失败可以安全重试。
- 一旦开始调用 SMTP，若无法确认服务端是否接受，状态进入 `AMBIGUOUS_DELIVERY_STATE`，系统清除敏感载荷并停止自动重试。该边界用于避免网络中断或数据库失败造成重复外发。
- SMTP 若明确返回部分收件人接受、部分收件人拒绝，状态进入 `PARTIAL_RECIPIENT_REJECTION`：清除 outbox 与附件敏感载荷、停止整封自动重试，并提示用户先人工核对；已冻结的唯一 MIME 仍可按原幂等边界同步一次 Sent。
- 只有 SMTP 未报告同步拒收且已明确接受后，草稿才进入 `sent`；部分送达保持人工核对终态。两种已发生外部接受的结果都会让唯一 Sent 同步任务由 `prepared` 激活为 `pending`。

### Sent 文件夹幂等同步

- 系统在 SMTP 成功前冻结一份加密 MIME，并写入稳定的 `Message-ID` 与 `X-DOMO-NAV-Id`。
- Sent worker 只选择唯一的 IMAP `\\Sent` SPECIAL-USE 文件夹；若自动发现为零个或多个，任务会阻塞，不会猜测目标目录。管理员也可显式填写精确目录路径。
- 每次 APPEND 前先按稳定头字段搜索 Sent：找到唯一匹配即直接对账完成；发现多个匹配则标记阻塞。
- 真正执行 APPEND 的任务只允许进入一次 `append_attempted`。若 APPEND 返回异常、连接中断或 UID 无法确认，任务进入 `reconcile`，后续只搜索对账，不再次 APPEND，从而避免重复 Sent 副本。
- APPEND 成功后记录 Sent 目录路径、UIDVALIDITY 和 UID，清除冻结 MIME 密文，并将该邮件缓存到 NAV 本地加密邮箱视图。

## 数据库迁移

### `037_email_attachments_sent_sync.sql`

- 为 `email_drafts`、`mail_outbox` 增加可被复合外键引用的 `(id, user_id)` 唯一约束。
- 新增 `email_attachment_objects`，保存附件归属、状态、顺序、大小、摘要和加密元数据。
- 新增 `email_attachment_chunks`，保存逐块 AES-GCM 密文，并以数据库约束限制块数、明文大小和密文长度。

### `038_email_sent_append_jobs.sql`

- 新增 `email_sent_append_jobs`，记录冻结 MIME、SMTP 接受时间、APPEND/对账状态、Sent 路径和最终 UID。
- 状态机限定为 `prepared`、`pending`、`appending`、`reconcile`、`appended`、`blocked`、`cancelled`、`expired`，数据库约束保证密文、时间戳和终态清理一致。
- 新增 `email_sent_append` 维护任务状态，用于观察 backlog、错误码和最近运行情况。

迁移必须按现有顺序先完成 `035`、`036`，再执行 `037`、`038`。两份迁移都必须在一次性 PostgreSQL 16 中连续执行两次并通过结构验证器，才能进入生产发布。

## 配置项

生产值只能写入 release 外部环境配置或只读 Secret 文件，不得进入 Git、PR、日志或浏览器响应。

- `NAV_EMAIL_SENT_APPEND_ENABLED=false`：Sent 同步总开关。首次发布必须保持 `false`。
- `NAV_IMAP_SENT_MAILBOX=`：可选的精确 Sent 目录路径。留空时仅接受唯一的 `\\Sent` SPECIAL-USE 自动发现结果。
- `NAV_EMAIL_SENT_APPEND_INTERVAL_SECONDS=30`：Sent worker 调度间隔。
- `NAV_EMAIL_SENT_APPEND_BATCH_SIZE=5`：单轮最大处理量。
- `NAV_EMAIL_SENT_APPEND_RETENTION_DAYS=30`：尚未完成的冻结 MIME 保留上限；到期后清除密文并进入 `expired`。
- `NAV_IMAP_HOST`、`NAV_IMAP_PORT=993`、`NAV_IMAP_SECURE=true`、`NAV_IMAP_USERNAME`、`NAV_IMAP_PASSWORD_FILE`：附件按需下载与 Sent 同步共用的 IMAP TLS 配置。
- `NAV_EMAIL_ENCRYPTION_KEY_FILE`：邮件正文、附件元数据和附件分块所需的独立加密密钥；必须纳入加密备份。

附件数量与容量限制是服务端安全上限，本候选不把它们暴露为普通管理 UI 配置。

## 建议上线顺序

1. 冻结精确 merge SHA，创建规范数据库与外部配置备份，并在一次性 PostgreSQL 16 中完成隔离恢复。
2. 在隔离库依次执行迁移 `037`、`038`，再次执行全部迁移，运行结构验证器及附件/Sent PostgreSQL 集成测试。
3. 保持 `NAV_EMAIL_SENT_APPEND_ENABLED=false` 发布同一 SHA 的 `nav-api`、`nav-web` 与 `nav-mail-worker`；不重建 PostgreSQL、CLIProxyAPI、Nginx Proxy Manager 或其他服务。
4. 切换前验证候选 API 镜像为 Debian/glibc 且能加载 `onnxruntime-node`；切换后等待语义索引成功清空待处理记录并关闭连续失败告警。
5. 先验收无附件和带附件的草稿确认、上传、删除、发送、失败清理与收件附件下载。
6. 使用专门测试邮箱确认唯一 Sent 目录；必要时填写 `NAV_IMAP_SENT_MAILBOX` 的精确路径。
7. 只在 SMTP、IMAP、维护状态和日志脱敏均通过后，将 `NAV_EMAIL_SENT_APPEND_ENABLED` 改为 `true`，逐封测试 SMTP 接受、Sent APPEND、刷新后可见和断线对账。
8. 最后完成 `nav.skrskr.net` 与 `nav.cristsau.cn` 的桌面和手机验收，再标记为 `VERIFIED_LIVE`。

## 回滚原则

- 首选立即关闭 `NAV_EMAIL_SENT_APPEND_ENABLED`，停止新增 Sent APPEND；SMTP 发信和收件附件下载可按独立能力继续运行。
- 应用回滚到发布前精确 release 时保留迁移 `037`、`038` 的表结构，不执行破坏性降级，也不删除未核实的任务记录。
- 若 SMTP 投递结果不确定，保持 `AMBIGUOUS_DELIVERY_STATE`，不得通过手工改状态触发重发。
- 若 APPEND 结果不确定，保持 `reconcile`，只允许搜索对账，不允许再次 APPEND。
- 回滚前后都保留数据库备份、迁移验证报告、维护任务摘要和脱敏日志；不得记录附件正文、邮箱密码、密钥或完整收件人清单。

## 验收清单

- 上传 1 个及多个附件后，草稿返回附件清单；新增、删除或调序会改变草稿确认指纹。
- 超过单件、总量、数量或用户暂存配额时明确拒绝，不留下孤立附件密文。
- SMTP stub 证明带附件 MIME 正确、`Bcc` 不进入 MIME、投递只调用一次；SMTP 模糊失败与部分收件人拒收都不会自动重发。
- SMTP 明确成功后草稿/队列状态正确，附件密文按策略清除。
- 收件附件仅在用户点击时从 IMAP 拉取；UIDVALIDITY 变化、附件不存在和超限均安全拒绝。
- Sent APPEND 前能够唯一发现目标目录；预搜索命中时不再 APPEND。
- APPEND 成功记录 UIDVALIDITY/UID 并清除冻结 MIME；APPEND 模糊失败进入只对账路径，重跑不产生第二份副本。
- 两个域名的桌面与手机端均能显示“已排队、已发送、Sent 同步中、已同步、需人工检查”等真实状态，不把 SMTP 成功误报为 Sent 已完成。
- 语义索引待处理数归零，连续失败数归零，维护状态恢复成功且双域混合检索报告语义能力就绪。
- 数据库、API 响应和日志中不存在可读附件、冻结 MIME、邮箱密码或加密密钥。

## 已知限制

- 本候选不回填历史已发送邮件。只有启用 Sent 同步后新产生且成功进入任务链的邮件才会写入 Sent。
- 收件附件依赖远端邮件 UID 与 UIDVALIDITY；远端邮箱移动、重建目录或删除邮件后，旧下载入口可能失效，需要刷新同步结果。
- 当前附件为明确下载，不提供 HTML 内联资源自动加载、浏览器内自动预览、杀毒扫描或内容转码。
- Sent 同步只支持一个唯一目标目录；多账户、多 Sent 目录路由和跨服务商差异仍需逐账户验收。
- `blocked`、`reconcile`、`AMBIGUOUS_DELIVERY_STATE`、`PARTIAL_RECIPIENT_REJECTION` 都是有意保留的安全终态或人工检查态，不能通过盲目重试消除。
- 本文件描述的是本地候选实现，不代表 GitHub CI、生产迁移、真实 MXroute APPEND 或双域实机验收已经完成。

## 2026-08-27 本地验证记录

- 附件、Sent、模糊投递与部分送达定向回归：`46 / 46` 通过。
- API 全量测试：`649` 项，`638` 通过、`11` 按既有环境条件跳过、`0` 失败。
- 前端 Vite 生产构建：`342` 个模块转换完成，构建通过。
- `node --check`、`git diff --check` 与定向秘密特征扫描通过；未发现被写入候选差异的真实密钥或密码。
- 当前 Windows 开发机没有 Docker、`psql` 或已安装的 WSL Linux 发行版，因此未在本机执行真实 PostgreSQL 16 迁移、SMTP 或 IMAP 集成。上述验证必须由 GitHub PostgreSQL 16 CI 与后续隔离环境完成后，才可授权发布。
