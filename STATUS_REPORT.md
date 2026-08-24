# DOMO NAV Status Report

最后更新：2026-08-24

本页区分 `VERIFIED_LIVE`、`LOCAL_DONE`、`READY_FOR_CI`、`PARTIAL`、`USER_CONFIG_LATER`
和 `UNFINISHED`。仓库中存在脚本或代码，不等于生产
已经安装、启用或形成灾难恢复闭环；每次发布前仍须重新读取 GitHub、OVH 与双域状态。

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
- 2026-08-24 本工作树创建时的 `origin/master` 为 PR #42 merge：
  `d918f449c0ee90ee363ae5ea7eef4d2025721a84`；后续状态仍须现场读取。
- 最近一次已验证生产 API 应用 SHA：`d918f449c0ee90ee363ae5ea7eef4d2025721a84`。
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
- 最近一次已验证 OVH release：`/opt/nav-stack/releases/20260824-180310-d918f44`。
- PR #42 发布前回滚目标：`/opt/nav-stack/releases/20260824-055950-accf664`；迁移 019–027 均为
  加法迁移，应用回滚时保留。
- 生产域名：
  - `https://nav.skrskr.net`
  - `https://nav.cristsau.cn`
- 2026-08-24 发布后复核：双域首页与 `/api/health` 均为 200，API/Web/PostgreSQL 健康；
  CLIProxyAPI、Nginx Proxy Manager、Vaultwarden 和 Komari 保持运行。

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

- 页面关闭后的标准 Web Push、VAPID、提醒调度和 PWA Service Worker 已启用；浏览器通知权限
  必须由用户逐设备授权，尚未观察到真实 Chrome/Edge/iPhone 的最终通知到达证据。
- 有界定时链接检查、提前提醒、Passkey 与 AI 用量清理源码/迁移已上线，但是否启用取决于各自
  生产开关；Passkey 尚未完成真实设备注册与登录验收。
- 生产安全 JSON、Chrome/Edge 书签 HTML 和 Markdown 导入导出已进入发布版本，但完整生态
  恢复仍不含图床对象与外层代理。
- PWA 离线说明壳、显式更新、Web Push、已访问工作区的完整离线编辑和跨设备增量同步已随
  PR #42 上线；iPhone/iPad 仍必须从主屏幕安装入口授权通知，真实双设备离线并发体验建议继续
  人工验收。
- 云端 JSON 恢复的密码二次确认、只读差异预览和替换边界已随 PR #32 发布；超过 5,000 条的
  NDJSON 流式恢复已随 PR #42 上线并通过 6,500 条 PostgreSQL 16 隔离演练；图床对象和外层
  代理整套恢复仍等待运行配置与可丢弃环境演练。

## 仍未完成

1. 在用户选定免费存储后，为 OVH 填写通用异地备份 Secret，并验收首次快照、远端保留、
   定期隔离恢复、失败报警与外部 dead-man。
2. 由用户在真实 Chrome/Edge/iPhone 主屏应用中逐设备授权并验证“页面关闭仍送达”。
3. 按需逐项启用并真机验收 Passkey、定时链接检查与 AI 用量清理；保持最小批次和独立回滚。
4. 在单独授权的主机维护中，将已合并的恢复就绪修复更新到主机全局恢复工具；当前 release
   已使用稳定就绪门禁完成隔离恢复，本项不影响在线应用功能。
5. 扩展商店开发者账号、签名、提交与审核继续暂缓。

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
