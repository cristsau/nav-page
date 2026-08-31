# DOMO NAV Status Report

最后更新：2026-08-28

本页区分 `VERIFIED_LIVE`、`LOCAL_DONE`、`READY_FOR_CI`、`PARTIAL`、`USER_CONFIG_LATER`
和 `UNFINISHED`。仓库中存在脚本或代码，不等于生产
已经安装、启用或形成灾难恢复闭环；每次发布前仍须重新读取 GitHub、OVH 与双域状态。

## 2026-08-28 当前留档基线与运维收口候选

- 最新留档的已验证生产版本（2026-08-27）为
  `15fd83e3f197afb7a03fe119ce118feae26ab10f`，OVH release 为
  `/opt/nav-stack/releases/20260827-231729-15fd83e`。这不是 2026-08-28 的实时
  主机读取结果，后续发布仍须现场复核。
- 本批状态：`LOCAL_DONE / READY_FOR_CI / NOT_DEPLOYED`。没有发布、启用 timer、
  运行备份/恢复、执行磁盘清理、删除 release/镜像或写入生产配置。
- 应用开关继续默认关闭；`ops/env/nav-production-maintenance.env` 只为书签健康检查和
  AI 用量保留提供有界 opt-in：每小时最多 20 条/并发 2，AI 聚合保留 400 天且每次
  最多删除 2,000 行。两项均进入现有管理员维护状态与告警框架。
- `scripts/nav-release-link.sh` 新增经命名/路径校验的 `current`、`rollback` 原子指针；
  canonical backup 与切换共享发布锁，防止一次备份混入两个 release。
- 三个 systemd 候选已改为本地备份、本地保留、最新本地备份的隔离 PostgreSQL 恢复。
  `enable-nav-local-backup-timers` 必须先验证 mode-600 配置、current 指针、固定镜像、
  本地删除下限，以及全部云端开关为 false；启用前还必须实际通过一次备份和隔离恢复。
- 异地 restic 仍为 `USER_CONFIG_LATER / NOT_CONFIGURED / NOT_ENABLED`；没有对象存储
  Secret 时不会安装或启用一个伪装成异地恢复的 timer。
- `nav-controlled-cleanup` 默认只预览，保留 current+rollback 和未知/无 revision 标签的
  镜像；apply 仅允许 30 天日志、Docker dangling layer 与可信的未引用 NAV API 镜像，
  不触碰容器、网络、卷、build cache 或非 NAV 镜像。
- 完整边界与后续启用顺序见
  [`docs/NAV_OPERATIONS_COMPLETION_20260828.md`](./docs/NAV_OPERATIONS_COMPLETION_20260828.md)。

## 2026-08-28 身份 OAuth 与邮箱远端命令候选

- 状态：`LOCAL_DONE / READY_FOR_CI / DEFAULT_OFF / NOT_DEPLOYED`。
- 迁移 `040` 增加 Google/微信外部身份与一次性授权事务；双域回调固定，Google 使用
  state/nonce/PKCE/JWKS，微信只使用稳定 unionid/openid。默认必须先密码登录再绑定；
  verified-email 自动关联默认关闭，开启后也只接受唯一的已审批、已验证邮箱候选。
- Provider Secret、邮箱 OAuth Refresh Token 与内部 HMAC key 只保存为服务器 owner-only
  文件，管理 API 只返回 configured 布尔值。无真实凭据时 Google/微信登录和 Google/Microsoft
  邮箱 OAuth 均保持关闭，不能把结构检查称为外部授权成功。
- 迁移 `041` 增加邮箱远端命令 outbox：用户级幂等、10 秒撤销、UIDVALIDITY/MODSEQ/flags
  冲突保护、写后复核与有界重试。支持已读、星标、归档、移动、Trash 和受二次确认保护的
  永久删除；移动/删除结果不明时不会盲目重试。
- 合成发布验收只验证命令排队、幂等重放和撤销，不触碰真实邮箱；真实 Provider 登录、
  OAuth consent 与专用测试邮箱远端写入仍需外部凭据和人工验收。
- 详细边界见 [`docs/NAV_IDENTITY_AND_MAIL_ROADMAP.md`](./docs/NAV_IDENTITY_AND_MAIL_ROADMAP.md)
  与 [`docs/NAV_MAIL_REMOTE_COMMANDS.md`](./docs/NAV_MAIL_REMOTE_COMMANDS.md)。

## 2026-08-24 实时评论事件流候选

- 状态：`LOCAL_DONE / READY_FOR_CI / NOT_DEPLOYED`；生产仍运行 PR #42 的 4 秒近实时评论版本。
- 新增迁移 `028_realtime_collaboration_events.sql`，使用 PostgreSQL `LISTEN/NOTIFY` 把已提交的
  `note_sync_events` 安全广播到所有 API 实例。
- 新增逐用户、逐笔记鉴权的只读事件 WebSocket；事件仅包含游标和实体元数据，不包含评论正文。
- 前端连接成功后取消 4 秒轮询，断线时指数退避重连，并以 30 秒低频刷新、窗口聚焦、页面恢复
  可见和离线 outbox 完成事件作为兜底。
- 迁移验证检查触发器启用状态及函数定义；GitHub PostgreSQL 16 协作作业将打开真实 WebSocket，
  创建评论并验证 `comment.upsert` 即时送达且载荷没有 `body`。
- 设计、安全边界、CI/发布和回滚门禁见
  [`docs/NAV_REALTIME_COMMENTS_20260824.md`](./docs/NAV_REALTIME_COMMENTS_20260824.md)。

## 2026-08-24 协作、离线、整套灾难恢复与流式恢复候选

- 状态：协作、离线和流式恢复为 `VERIFIED_LIVE`；图床对象与外层代理灾备仍为 `PARTIAL / NOT_CONFIGURED`。
- PR #42 已合并为 `d918f449c0ee90ee363ae5ea7eef4d2025721a84`，OVH release 为
  `/opt/nav-stack/releases/20260824-180310-d918f44`；迁移 026/027、双域协作/离线/流式接口、
  一次性双用户、Yjs WebSocket、合成数据清理与发布后 PostgreSQL 16 隔离恢复均已通过。
- 迁移 `026` 增加协作者、评论、Yjs 文档/更新、增量同步事件、幂等离线收据和设备游标；
  `027` 增加会话绑定的 NDJSON 流式上传暂存表。
- 未加密块笔记支持 owner/editor 实时 CRDT 正文、角色权限、选区/块评论和 4 秒可见页面近实时
  刷新；已访问工作区支持 IndexedDB 离线重开、离线笔记/评论 outbox、Background Sync 与
  前台回退、跨设备增量收敛。
- 恢复上传使用 128 MiB NDJSON 流、2 MiB 单行和 250 条批处理，隔离测试已通过 6,500 条；
  完整灾难恢复脚本新增图床对象、NPM SQLite/代理配置、路径原子恢复、应用前回滚和健康门禁。
- 加密笔记仍禁止服务器协作；图床二进制必须联网；完整 DR 在 OVH 填入对象读取权限和外层代理
  路径并完成可丢弃环境演练前，不能标记为 `VERIFIED_LIVE`。
- 图床对象和 NPM/外层代理因运行凭据与路径未配置，发布后备份明确报告 `NOT_CONFIGURED`；不得
  把已完成的编排代码表述为完整异地灾备闭环。设计、边界和验收清单见
  [`docs/NAV_COLLABORATION_OFFLINE_DR_STREAMING.md`](./docs/NAV_COLLABORATION_OFFLINE_DR_STREAMING.md)。

## 2026-08-24 Web Push 当前设备登记修复

- 状态：`VERIFIED_LIVE / PHYSICAL_BROWSER_DELIVERY_PENDING`。
- 用户现场表现为通知权限已经 `granted`，测试按钮仍禁用；生产只读检查确认
  `web_push_subscriptions` 为 0 行，因此浏览器权限已完成，但 Push subscription/服务器登记未完成。
- 本分支把启用过程拆成系统权限、浏览器订阅、服务器登记三步，成功后自动向当前设备发送测试
  通知；测试按钮不再回退到其他设备，并提供脱敏的分步错误信息。
- PR #41 已合并到 `accf664da3742b6f8a1277f283aac1f8318a90b4` 并发布到 OVH release
  `/opt/nav-stack/releases/20260824-055950-accf664`；只重建 `nav-web`，双域服务端/页面状态、
  自动测试触发与刷新持久化路径已验收。真实普通 Edge/Chrome 关闭页面后的系统通知到达仍需
  用户在对应操作系统浏览器完成最终观察。
- 详细证据与上线门禁见
  [`docs/NAV_WEB_PUSH_DEVICE_REGISTRATION_FIX.md`](./docs/NAV_WEB_PUSH_DEVICE_REGISTRATION_FIX.md)。

## 2026-08-24 高级搜索、Web Push 与块编辑器历史发布快照

- 状态：该批功能为 `VERIFIED_LIVE`，真实设备通知授权除外；当前整体生产基线以上方 PR #42
  快照为准。
- PR [#37](https://github.com/cristsau/nav-page/pull/37) 已把迁移 `019` 至 `025`、Passkey 源码、
  统一搜索/带来源助理、AI 用量、提前提醒、定时链接检查、Chrome/Edge 与 Markdown 导入导出、
  PWA 离线外壳、自动保存/50 个版本，以及本地中文 BM25、固定 revision 多语言向量、标准
  Web Push/VAPID 和 Tiptap 单用户块编辑器合并到 `a9eff0d`。
- PR [#38](https://github.com/cristsau/nav-page/pull/38) 已把 Service Worker 明确 no-cache 与
  PostgreSQL 16 恢复就绪竞态修复合并到 `788be84`；合并后 master CI `32689782306` 五项全绿。
- PR #37/#38 当时的 OVH release 为 `/opt/nav-stack/releases/20260824-031310-a9eff0d`，API 镜像为
  `nav-ovh-api:a9eff0d7888fd29f8888a503a336af86371c3b80`。PR #38 的 Nginx 修复已在该 release
  内同步生效；恢复工具源码已修复，主机全局工具更新留待独立维护授权。
- 语义模型缓存使用 OVH Docker volume；VAPID 私钥使用 release-local 只读 Secret。两者均不
  进入 Git、镜像、前端、日志或本文。
- 加密笔记不进入派生搜索索引，Push 不暴露加密标题/正文，块 JSON 加密仍只在浏览器完成。
- Web Push 服务端、订阅接口和测试链已通过；最终“页面关闭仍收到通知”必须由用户在每台
  Chrome/Edge 设备授权，iPhone/iPad 必须先添加到主屏幕后授权，因此标记为 `USER_ACTION_REQUIRED`。
- 完整边界、回滚与真机验收见
  [`docs/NAV_ADVANCED_SEARCH_PUSH_BLOCK_EDITOR.md`](./docs/NAV_ADVANCED_SEARCH_PUSH_BLOCK_EDITOR.md)。

## 当前源码与生产基线

- GitHub：`cristsau/nav-page`（Private），默认分支 `master`。
- 2026-08-27 最后一次独立留档的 GitHub/生产 merge SHA 为 PR #57：
  `15fd83e3f197afb7a03fe119ce118feae26ab10f`；后续状态仍须现场读取。
- 最近一次留档的已验证生产 API 应用 SHA：`15fd83e3f197afb7a03fe119ce118feae26ab10f`。
- 当前生产源码包含的连续 PR：
  - [#28 发布文档校准](https://github.com/cristsau/nav-page/pull/28)
  - [#29 异地备份调度候选](https://github.com/cristsau/nav-page/pull/29)（源码已包含，运行环境仍为
    `NOT_CONFIGURED / NOT_ENABLED`）
  - [#30 图片删除重试告警正确性](https://github.com/cristsau/nav-page/pull/30)
  - [#31 云端恢复防误操作门禁](https://github.com/cristsau/nav-page/pull/31)
- 已在此前发布的应用 PR：
  - [#26 有界后台维护](https://github.com/cristsau/nav-page/pull/26)
  - [#27 后台任务可观测性](https://github.com/cristsau/nav-page/pull/27)
- 最新合并并发布的应用 PR：
  - [#32 维护通知投递与 PostgreSQL 集成门禁](https://github.com/cristsau/nav-page/pull/32)
  - [#33 一次性管理员与发布验收门禁](https://github.com/cristsau/nav-page/pull/33)
  - [#34 主机 CIDR 精确验收修复](https://github.com/cristsau/nav-page/pull/34)
  - [#37 高级搜索、Web Push 与块编辑器](https://github.com/cristsau/nav-page/pull/37)
  - [#38 恢复就绪与 PWA 缓存加固](https://github.com/cristsau/nav-page/pull/38)
  - [#41 当前设备 Web Push 登记修复](https://github.com/cristsau/nav-page/pull/41)
  - [#42 协作、离线、完整灾备编排与流式恢复](https://github.com/cristsau/nav-page/pull/42)
  - PR #56 邮件工作台、通知规则、邮件 AI 与语义修复
  - PR #57 生产验收托管配置热修
- 最近一次留档的已验证 OVH release：`/opt/nav-stack/releases/20260827-231729-15fd83e`。
- 对应回滚 release：`/opt/nav-stack/releases/20260827-145131-5f6c8ef`。
- 生产域名：
  - `https://nav.skrskr.net`
  - `https://nav.cristsau.cn`
- 2026-08-27 发布后复核：双域首页、邮件页、`/api/health`、会话、退出和 CORS 均通过；
  API/mail-worker/Web 健康且重启计数为 0，PostgreSQL、CLIProxyAPI、Nginx Proxy Manager、
  Vaultwarden 和 Komari 未重建。

PR #30 的图片删除重试告警正确性、PR #31 的云端安全恢复、PR #32 的 Telegram 精确目标
投递与独立 PostgreSQL 16 维护演练，以及 PR #33/#34 的一次性管理员发布验收生命周期与
主机 CIDR 精确校验，均已进入上述生产 SHA 并完成验收。当前状态为 `VERIFIED_LIVE`。当前
仓库分支可能在本文提交后继续前进，不能用本快照替代 Git 现场核验。

一次性管理员工具已在首次生产发布中完成 `status=PASS / cleanup=PASS`。临时账号、marker 与
`/run/nav-release-acceptance.*` 私有目录均清零；真实管理员长期密码没有进入 release，也未被
该生命周期读取或修改。

## 当前生产已完成

### UI、分享与移动端

- 七套内置配色（含 Linear）与自定义主题、亮/暗/跟随系统、刷新持久化。
- 统一设计 token、辅助文字对比度门禁、统一桌面/手机主导航与设置六分类。
- 路由进度、启动骨架、Session single-flight/内存复用、页面可见时后台复验和统一 401 失效。
- 弹窗焦点、Esc、ARIA、标签、44px 触控尺寸、长表单固定头尾与手机操作菜单。
- 公开分享独立文章模板；`nav.skrskr.net` 为 canonical，双域继续支持应用登录。

### 导航、搜索、笔记与提醒

- 分组与书签增删改、拖拽排序、多选、批量移动/删除、常用入口、两行标题和兜底图标。
- 手动失效链接检查并保存最近状态。
- 首页统一搜索书签、未加密笔记和 Web；搜索引擎后台支持增删改。
- 备忘录、日记、数字 ID、快速复制、结构化字段悬停复制、截止时间和到期提醒中心。
- 命令面板支持页面跳转、新建书签/备忘录/日记、提醒与站内搜索。
- 导航 AI 分析/标签和笔记 AI 摘要、润色、续写与编辑辅助。

### 图片库与图床生命周期

- 图片经 NAV 服务端上传到个人图床；浏览器不接触 Token，NAV 不持久化图片二进制。
- 上传与库管理双 Token 按同一目录最小权限分离，并由 release-local Secret 只读挂载。
- `/media` 支持瀑布流、搜索、游标分页、引用、保留策略、分享、删除、对账和失败重试。
- 移除最后引用后只清理 `retention=auto` 图片；删除前重新校验引用，结果按物理删除、
  仅解除引用、legacy 和缓存状态持久化并给出保守提示。
- 加密笔记禁止向公开图床上传图片。

### AI、账号与安全

- CLI Proxy Responses API、动态 `/v1/models` 目录、最多六个候选、“自动最新”、推理强度和
  内置联网搜索；密钥仅由服务端 owner-only Secret 提供。
- 注册审批、Telegram 通知/同步、用户名与密码修改、会话查看/撤销、一次性恢复码和密码恢复。
- Passkey/WebAuthn 的迁移、API、登录页与账号安全页已发布；固定 RP ID/Origin，默认关闭，
  尚未启用或完成真实设备验收，因此不计入已验证生产能力。
- 登录、注册、恢复、已认证写操作和 AI 使用 PostgreSQL 原子共享限流。
- 安全审计保存最小化结构化字段和带密钥摘要，支持筛选、分页、CSV/JSON 导出和受控删除。
- 分层审计保留：常规成功 90 天、拒绝/失败 180 天、恢复/账号/管理员敏感操作 365 天。
- API 日志凭据脱敏；API/PostgreSQL 容器日志有大小、数量和压缩上限。

### 后台维护与告警

- 迁移 017 的有界安全审计清理与图片删除失败退避重试已启用；跨副本使用 advisory lock。
- 迁移 018 的 `maintenance_job_status` 固定保存两行任务状态，不随运行次数增长。
- 两个任务已完成成功运行，连续失败为 0；设置页默认折叠并按需读取状态。
- Telegram 目标已通过明确标注的测试消息；运行内告警已启用，连续失败阈值为 3，冷却为
  21600 秒，恢复后通知一次。
- 运行内告警无法报告 OVH 主机、容器、网络或调度器整体离线，仍需主机外 dead-man。

### 邮件工作台、邮件 AI 与语义索引

- 桌面三栏、手机渐进式邮件工作台支持服务端列表、详情、搜索和筛选。
- 账户、分类、域名、发件人和会话级通知规则支持立即、摘要、仅站内与静默；关键通知保留
  确认保护。
- 邮件 AI 支持带来源摘要、跨邮件检索和“预览后确认”的加密草稿操作，默认不直接发送
  真实邮件。
- 语义索引已固定 Debian/glibc 推理镜像；2026-08-27 验收为 384 维、任务成功、连续失败 0、
  待处理 0，旧 `ERR_DLOPEN_FAILED` 已清零。
- 合成邮件与一次性管理员完成双域验收后已清理；真实发信和远端邮箱修改未在验收中执行。

## 2026-08-31 邮件实时收取与附件翻译候选

- 状态：`LOCAL_DONE / PR_CI_IN_PROGRESS / NOT_DEPLOYED`。源码、迁移、定向测试和前端生产
  构建已完成并进入 GitHub PR/CI；本批没有执行生产迁移或修改 OVH 容器。
- 邮件正文 AI 翻译继续沿用既有能力；新增附件内容 AI 翻译只在用户明确点击后从 IMAP 重取
  所选附件，并仅处理通过归属、类型、UTF-8 编码、512 KiB 和 12,000 字符门禁的安全文本。
- `042_email_ingest_pipeline.sql` 新增无明文载荷的持久分类队列和同步 generation。IMAP 抓取
  完成加密入库即提交并发布 SSE，AI 分类/通知随后独立消费；积压会连续有界排空。
- 邮件页“立即收信”通过 PostgreSQL generation/NOTIFY 唤醒唯一 worker，5 秒内重复请求在
  数据库合并；页面显示等待、追平或失败，API 不创建第二条 IMAP 同步链路。
- 分类 worker 支持 `SKIP LOCKED` 抢占、未来重试、死信和陈旧任务恢复；任务行只保存身份和
  泛化状态，不保存邮件明文或附件内容。
- 本地 API 全量测试为 745 项、734 通过、0 失败、11 跳过；邮件定向回归和独立竞态审查通过，
  Vite 生产构建通过。当前电脑没有 Docker 或本地 PostgreSQL 16 监听，因此真实 PostgreSQL 16
  迁移重复执行、结构校验与邮件集成仍是 GitHub CI 合并前硬门禁；加法迁移不做 schema down，
  应用回滚保留 `042` 和已安全入库的数据。
- P1 仍计划在 Provider 支持时启用 CONDSTORE/QRESYNC，对 flags 与 expunge 做有界主动对账；
  PDF/Office 仅在独立安全评审后做隔离、无网络、受限的纯文本提取，不执行宏、远程资源或 OCR。
- 完整实施边界和验收门槛见
  [`docs/NAV_MAIL_REALTIME_TRANSLATION_20260831.md`](./docs/NAV_MAIL_REALTIME_TRANSLATION_20260831.md)。

## PR #37/#38 高级功能发布与恢复证据（历史）

- PR #37 与 #38 已合并；`a9eff0d` master CI `32685311488` 和最终 `788be84` master CI
  `32689782306` 的 `test-and-build`、`restore-postgres-integration`、
  `maintenance-postgres-integration`、`advanced-features-postgres-integration` 与
  `release-acceptance-postgres-integration` 五项均成功。
- 源码归档 SHA-256 `f97ea74b0d48d478c5d3983d4337ed23afe613628b1ae6a033af6a33d023e90d`
  在 OVH 解包前核验；API 与 Vite 均在 OVH 隔离构建环境完成，本机没有运行 npm 测试或构建。
- 发布前 canonical 备份完成 manifest 校验，并使用稳定 PostgreSQL 主进程门禁在隔离
  PostgreSQL 16 中恢复通过；由此发现并修复了临时初始化 postmaster 的就绪竞态。
- 迁移 `019` 至 `025` 已连续应用；发布后备份在隔离 PostgreSQL 16 中恢复为 25 张表并精确
  核对迁移 ledger 到 `025_block_editor.sql`。
- 本次只重建 `nav-api` 与 `nav-web`；PostgreSQL、CLIProxyAPI、NPM、Vaultwarden、Komari
  及其他非目标容器 ID 保持不变，API/Web 重启计数均为 0。
- 双域通过健康、CORS、登录会话、混合搜索、块保存/版本、Web Push 服务端状态、缓存、
  Service Worker、退出和一次性管理员自动清理验收。
- 脱敏验收证据保存在当前 OVH release 的受限 `evidence` 目录，主要高级功能证据为
  `ACCEPTANCE_ADVANCED_FEATURES.txt`；不在仓库复制凭据、Cookie、Secret 或备份正文。

## 备份与恢复现状（PARTIAL）

- 仓库已有 `scripts/nav-backup.sh`、`scripts/nav-restore-rehearsal.sh`、环境示例和
  `docs/NAV_BACKUP_RUNBOOK.md`；受控发布会做发布前后备份与隔离恢复演练。
- 仓库已补充三组默认不启用的 systemd 调度模板、独立 `OnFailure` 通知、只在成功后发送的
  双 dead-man 心跳、最新备份选择器和只安装不启用的部署脚本；生产配置和现场验收完成前
  状态仍是 `SOURCE_READY / NOT_DEPLOYED`。
- 2026-08-24 OVH 只读复核确认：三组 NAV 备份/保留/恢复 service 与 timer 模板已经安装，但
  timer 全部为 `disabled`；`restic`、`/etc/nav/nav-backup.env` 与
  `/etc/nav/restic-offsite.env` 仍不存在。主机全局恢复工具存在，但哈希与仓库当前修复版不同。
- 因此当前仍没有自动异地加密上传、远端保留清理、备份失败外部报警或定期恢复演练；现状是
  “调度骨架已安装、未配置、未启用”，不能写成已形成异地灾备。
- 图床对象和外层代理配置的完整备份/恢复编排已随 PR #42 进入生产源码；生产尚未填入对象读取凭据、
  NPM 路径并完成干净环境演练，因此闭环状态仍为 `PARTIAL`。

## 生产仍为部分完成

- 应用内高级功能已经进入 2026-08-27 生产基线；逐设备浏览器通知、Passkey 与跨域 RP 行为仍
  需要保留真实设备回归，不用历史“源码存在”替代现场体验证据。
- 邮件工作台、通知规则和 AI 草稿已验收；真实发信、远端邮箱修改以及外部 OAuth provider
  同意流程不在合成验收中自动执行。
- JSON/NDJSON 恢复、图床/代理灾备编排已有源码与隔离数据库证据；图床对象读取凭据、外层
  NPM 精确路径和完整可丢弃主机演练仍未形成闭环。
- 2026-08-28 的本地自动备份/timer/release-link/清理批次尚未发布或启用；生产当前不能宣称
  已有自动本地恢复演练或自动异地加密备份。

## 仍未完成

1. 邮件 P0 低延迟收取、持久 AI 队列、连续排空、API 唤醒 worker、延迟观测和安全文本附件
   翻译已完成本地开发并进入 PR/CI；GitHub 全量 CI 通过前不得标记 `CI_VERIFIED`，发布验收前
   不得标记 `VERIFIED_LIVE`。
2. 邮件 P1 的 CONDSTORE/QRESYNC、flags/expunge 对账与 PDF/Office 安全文本提取尚未实现；
   需要独立门禁，不能用正文翻译或普通附件下载冒充完成。
3. 让 2026-08-28 运维收口批次通过 GitHub Linux CI；之后按发布前备份/隔离恢复/回滚/双域
   验收门禁发布，不能直接用本地测试替代。
4. 现场建立并核验 `/opt/nav-stack/current` 与 `rollback`；先运行 local timer `--check`，
   经单独授权、一次真实本地备份和隔离恢复后再启用三个 timer。
5. 仅在 dry-run 审阅确认后，另行授权受控清理；本批没有删除任何 release、镜像或日志。
6. 用户选定免费存储后填写通用异地备份 Secret，再验收首次加密快照、远端保留、exact-ID
   恢复与外部 dead-man；未提供 Secret 时保持未配置。
7. 外部 OAuth provider 的开发者应用、回调域名、凭据与同意屏幕仍需用户/平台流程；扩展商店
   开发者账号、签名、提交与审核继续暂缓。

## 仍建议用户手工验收

1. 电脑和手机分别经两个域名登录，确认会话设备与来源符合预期。
2. 生成恢复码并离线保存；用可丢弃账号确认一枚恢复码只能使用一次。
3. 下载一次完整 JSON 导出，人工确认恢复范围和页面提示。
4. 在真实 iPhone/触屏设备验收书签菜单、命令入口、提醒中心和图片库操作。
5. 首次使用账号修改或审计删除时，以单条、可回退方式人工确认。

## 发布边界

- 生产只发布通过 CI 的精确 merge SHA，并使用独立 release 目录。
- 每次生产发布先备份、隔离恢复，再迁移、切换、双域验收，最后做发布后恢复演练。
- Secret 不进入 Git、文档、镜像、前端或日志。
- 后续生产登录态验收必须使用随机一次性管理员；真实管理员长期密码不得进入 release。
  候选 SHA 必须先包含并通过一次性账号工具的 CI，账号生命周期、自动清理和硬中断恢复门禁见
  [`docs/NAV_PRODUCTION_RELEASE_ACCEPTANCE.md`](./docs/NAV_PRODUCTION_RELEASE_ACCEPTANCE.md)。
- 生产数据库写入、定时器启用、凭据安装、DNS/代理修改、容器重建、服务重启和删除均需
  单独列出影响、备份、回滚与验收，并取得明确授权。
