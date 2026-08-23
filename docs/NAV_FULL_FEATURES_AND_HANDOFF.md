# DOMO NAV 完整功能与跨电脑续作交接

> 更新日期：2026-08-24
> 用途：把本文件交给另一台电脑上的 Codex，快速恢复项目上下文。
> 安全说明：本文不包含用户名、密码、Token、Cookie、私钥、真实 `.env` 或个人数据。

## 1. 当前状态

- GitHub 仓库：`cristsau/nav-page`，应保持 **Private**。
- 主分支：`master`。
- 2026-08-23 最后完成 OVH 双域验收的生产应用 SHA 为
  `25c9c133ad6c34b857cf13c293aa5a89c8ef04d7`（PR #34 合并点）。本工具分支以该 SHA 为基线；
  当前 `origin/master` 与生产仍须在下一次任务分别实时核验。
- PR #26 已把安全审计分层保留与导出、图片删除失败后台退避重试、日志脱敏与容器日志限额合入并发布；迁移 017 已执行，两个后台任务已逐项启用并完成双域验收。
- 主题对比度、弹窗无障碍、Session single-flight/内存复用、统一 401、路由进度与骨架、缓存/真实 IP/canonical、六分类设置页、统一导航、紧凑搜索、横向书签卡和图片库/时光视觉收敛均已进入上述生产 SHA。
- PR #27 已发布迁移 018、后台任务持久状态、管理员状态界面、连续失败阈值/冷却和
  Telegram 失败/恢复通知；生产目标验证通过，运行内告警已经启用。
- 仓库已提供默认不启用的异地备份/保留/隔离恢复 systemd 模板、外部成功心跳和独立
  `OnFailure` 通知；OVH 尚未安装 `restic`、Secret、稳定入口或 timer，不能写成已上线。
- PR #30 已收紧图片删除重试告警语义；PR #31 已加入有预览、当前密码、安全备份回执和
  并发校验的云端替换恢复；PR #32 补齐 Telegram 真实目标投递、零送达告警冷却释放与
  PostgreSQL 16 维护链路演练。三项均已进入当前生产并验收。
- PR #33/#34 已把随机一次性验收管理员、30 分钟服务端 TTL、登录和 Session 过期拒绝、
  启动/每分钟精确回收、固定 canonical 备份锁、验收超时/信号转发、真实 PostgreSQL 16
  账号与备份门禁，以及 host-only CIDR 精确校验合并并发布。首次生产生命周期为
  `status=PASS / cleanup=PASS`，临时账号、marker 与运行时私有目录均清零。
- 生产入口：`https://nav.skrskr.net`、`https://nav.cristsau.cn`。
- AI 兼容入口：`https://ap.skrskr.net`。
- 当前已知生产承载已从异常的 Oracle 主机灾难迁移到 OVH；任何后续发布前必须重新只读核验，不能把本文当作实时状态证明。
- 账户修改、审计删除和 AI 配置来源切换已通过 GitHub CI、生产前备份与隔离恢复演练，并已发布到 OVH。
- 图床双 Token 生产配置与 release-local Secret 只读挂载已经发布并验收；Token 值不进入 Git、文档或浏览器。
- 灾难重建时确认的 OVH 数据边界为 `1` 个用户、`0` 个导航分组、`0` 个书签、`0` 条笔记；这是迁移时证据，不是当前实时业务计数。Oracle 旧数据库仍未恢复。不要把“应用已恢复”误写成“Oracle 个人数据已恢复”。

## 2. 产品定位

DOMO NAV 是一个面向个人与小团队的私有化工作台。核心句是：

> 打开一个网站，完成“找东西、记东西、整理东西、调用 AI”。

产品把导航、统一搜索、笔记/备忘录/日记、图片库、公开分享、AI、账号安全和浏览器快速收藏收在同一入口中。

## 3. 技术架构

### 前端

- Vue 3
- Vite 6
- Vue Router 4
- Dexie / IndexedDB：本地模式、缓存和历史数据迁移
- CSS Variables：暖色深浅主题与统一设计 token
- Lucide 风格内置 SVG 图标；不使用 emoji 作为功能图标

### 后端

- Node.js 24
- Fastify
- PostgreSQL 16
- Cookie 会话认证
- 服务端代理 AI、Brave Search 和个人图床，浏览器不接触服务端密钥

### 外部服务

- CLIProxyAPI：OpenAI-compatible / Responses API 网关与管理中心
- Brave Search API：Web 搜索来源
- CloudFlare-ImgBed 兼容图床：图片存储与删除
- Telegram Bot：注册通知、审批同步和管理员配置测试
- Nginx Proxy Manager / Nginx：HTTPS 与反向代理

### 主要目录

| 路径 | 用途 |
| --- | --- |
| `app/` | Vue 前端 |
| `api/` | Fastify API、迁移和测试 |
| `extension/` | Chrome/Edge 浏览器扩展 |
| `docs/` | 安全、备份和交接文档 |
| `ovh/nginx.conf` | OVH `nav-web` 的 `conf.d/default.conf` 代理与静态缓存模板 |
| `.github/workflows/ci.yml` | GitHub Actions 测试与构建 |
| `docker-compose.backend.yml` | API 与 PostgreSQL 编排基线 |

## 4. 完整功能清单

### 4.1 登录、用户与账号安全

- 登录、退出和当前会话读取
- 新用户注册申请
- 管理员批准/拒绝注册
- Telegram 注册通知与审批同步
- 用户列表和注册历史
- PostgreSQL 共享限流：登录、注册、恢复、已认证写操作和 AI 请求
- 会话列表：设备、IP、浏览器、创建/活跃/到期时间
- 撤销单个会话、其他设备会话或全部会话
- 一次性恢复码：生成、轮换、复制和下载
- 使用恢复码重设密码；恢复成功后撤销全部会话
- 安全审计：登录、退出、恢复、会话撤销和管理员操作
- 审计仅展示截断 HMAC 指纹，不展示原始 IP 或 User-Agent
- 按当前筛选导出 CSV/JSON；单次最多 10,000 条，导出行为也会写入审计
- 90/180/365 天分层保留任务，使用跨副本锁和有界批次，已完成数据库备份、隔离恢复、过期数量复核与生产启用

本轮已上线：

- 设置中修改用户名：必须输入当前密码；用户名唯一；成功后保留当前会话并同步页面状态
- 设置中修改密码：必须输入当前密码；新密码至少 12 个字符且不能与旧密码相同；成功后撤销全部会话并要求重新登录
- 用户名与密码修改写入独立安全审计事件
- 安全审计默认折叠，首次展开时才读取数据
- 管理员可选择当前页审计记录删除，每批最多 100 条
- 删除必须再次输入当前密码
- 删除完成后新建一条 `admin.security_events.delete` 审计，记录删除数量而不记录密码或事件正文
- 图片清理失败可手动重试；生产后台会按指数退避继续重试，且每次重试前重新确认
  图片仍为自动保留、待清理并且没有笔记引用
- 后台任务最近成功/失败、耗时、计数与连续失败状态已上线；只持久化白名单计数和错误代码
- 连续失败达到阈值后会通知已配置 Telegram 的管理员，并在恢复时通知一次；完整主机离线仍需外部 dead-man

### 4.2 导航与书签

- 分组新增、编辑、删除和排序
- 书签新增、编辑、删除和拖拽排序
- 多选、全选、批量移动和批量删除
- 分组内排序管理
- 当前页快速添加书签卡
- 浏览器读取标题、URL 和 favicon 后快速收藏
- 重复 URL 检测
- 手动链接健康检查及最近检查状态
- AI 分析书签和 AI 自动标签
- 常用入口、两行标题和设计化兜底图标
- 桌面悬停轻操作；触屏常驻/菜单操作，不依赖 hover
- 书签卡渲染已移除会在隐藏时间轴冻结的初始 TransitionGroup 动画

### 4.3 统一搜索与搜索引擎

- 首页统一搜索书签
- 搜索未加密笔记/备忘录/日记
- Web 搜索
- 搜索结果键盘导航
- 自定义搜索引擎新增、编辑和删除
- 搜索引擎切换
- Brave Search 页面内结果
- AI 带来源回答入口
- `Cmd/Ctrl+K` 命令面板：搜索、跳转、创建书签/笔记/日记等高频动作

当前边界：

- 中文 BM25、错别字模糊检索和向量语义检索仍未完成
- 个人数据 RAG 助理和 AI 用量/成本面板仍未完成

### 4.4 备忘录、日记与笔记

- 备忘录和日记创建、编辑、删除
- 标题、正文、标签、置顶和完成状态
- 截止时间
- 到期提醒中心、已读和完成处理
- 搜索与筛选
- 数字 ID
- 快速复制整条内容
- 内容中的数字、ID、名称、网址等结构化值悬停/点击复制
- AI 摘要、润色、续写和编辑辅助
- 图片附件
- 独立预览与编辑界面
- 公开分享、撤销分享和分享管理

当前边界：

- 到期提醒主要在打开 NAV 时同步，尚无完整离线/系统推送
- Notion 式块编辑器、自动保存版本历史和多人协作尚未完成

### 4.5 图片与图床

- 笔记内选择或粘贴图片
- 图片经 NAV 后端转发到个人图床，NAV 不把图片二进制长期写入应用磁盘
- 上传 Token 与图库管理 Token 权限分离
- 图片元数据和引用关系存 PostgreSQL
- `/media` 图片库瀑布流
- 图片搜索、游标分页和状态筛选
- 大图预览、复制地址和分享
- 查看被哪些笔记引用
- 保留策略
- 图床对账
- 删除失败重试
- 删除笔记图片时解除引用；最后引用消失后按来源能力受控清理图床对象
- 严格区分物理删除、仅解除引用、原文件已不存在和缓存状态

### 4.6 AI

- CLIProxyAPI 服务端调用，密钥不进入前端
- AI 设置支持两种明确的配置来源：
  - `服务器托管 CLI Proxy（推荐）`：服务器只读 Secret 提供地址与专用密钥；页面可查看生效地址但不能覆盖 Secret
  - `自定义 API`：允许填写 Proxy Base URL 或 OpenAI-compatible Endpoint，并单独保存当前账号自己的密钥
- 自定义 API 模式绝不会读取或复用服务器托管密钥，避免把专用密钥发送到任意地址
- 自定义外发请求默认要求 HTTPS，并在访问前拒绝本机、私有网络和异常重定向
- Responses API
- 动态读取 `/v1/models`
- 模型下拉最多展示约 6 个候选
- “自动：最新 GPT”选择当前可用稳定通用模型
- 推理强度选择
- 内置联网搜索开关
- Brave Search 结果与 AI 来源
- 导航 AI 分析与标签
- 笔记 AI 摘要、润色、续写和编辑
- 服务端连接测试

运维注意：

- Management Center 管理密钥与 AI 调用 API Key 是两套独立秘密
- 任何密钥只能从服务器 owner-only Secret 文件或环境注入
- 不把密钥写入 GitHub、本文、前端、镜像或聊天
- CLIProxyAPI 存活不等于已有可用 provider；发布验收必须验证模型目录和一次受控调用

### 4.7 分享

- 为笔记创建随机分享码
- 撤销分享
- 独立公开文章模板，不复用内部“备忘录详情”壳
- 分享页隐藏内部类型标题和后台式统计语言
- 分享页独立标题、正文结构和响应式排版
- 服务端生成公开页面和动态预览元数据

### 4.8 浏览器与移动端

- Chrome/Edge 扩展弹窗快速收藏当前页
- 分组选择与创建
- 右键菜单保存
- 默认快捷键 `Ctrl+Shift+Y`
- `/quick-add` 快速添加页
- 设置中填写自建 NAV 地址并按需申请站点权限
- iPhone 快捷指令入口
- 主屏幕图标、中文名称和 Web App 元数据
- 响应式手机/平板布局
- 触屏书签操作菜单

当前边界：尚无完整 Service Worker、离线缓存和 Web Push。

### 4.9 设置

- 站点名称、Logo 和 favicon
- 明暗主题、配色方案和自定义主题
- 卡片密度与布局选项
- 搜索引擎后台
- AI Endpoint、服务端密钥状态、模型、推理强度和联网搜索
- AI 配置来源切换、当前服务器托管地址只读展示、自定义地址与自定义密钥
- Brave Search 接入
- 浏览器扩展下载和快速添加说明
- Telegram 管理配置
- 用户与注册审批
- 账号资料、会话与恢复码
- 管理员安全审计
- 数据导入导出

### 4.10 数据导入、导出、备份与恢复

- 从本地 IndexedDB 向 PostgreSQL 迁移
- 云端 JSON 导出
- 安全 JSON 导入
- 导出排除密码验证器、API Key、Telegram Token 和未知设置
- PostgreSQL 压缩备份入口
- 隔离恢复演练入口
- 备份/恢复运行手册：`docs/NAV_BACKUP_RUNBOOK.md`
- 安全控制文档：`docs/NAV_SECURITY_CONTROLS.md`

当前边界：后台任务的运行内失败/恢复告警已经发布；自动异地加密备份的仓库调度候选已
具备，但 OVH 配置、首次云端快照、定时隔离恢复、主机外报警/dead-man 和完整生态一键恢复
仍需单独上线与验收。

## 5. 本轮新增 API 契约

### 修改用户名

`PUT /api/auth/account/username`

请求：

```json
{
  "username": "new-name",
  "currentPassword": "current password"
}
```

行为：验证当前密码、用户名格式和唯一性；成功后保留当前会话。

### 修改密码

`PUT /api/auth/account/password`

请求：

```json
{
  "currentPassword": "current password",
  "newPassword": "at least 12 characters"
}
```

行为：更新密码哈希和 `password_changed_at`，撤销该用户全部会话并清理当前 Cookie。

### 删除审计记录

`POST /api/admin/security-events/delete`

请求：

```json
{
  "eventIds": ["100", "101"],
  "currentPassword": "current password"
}
```

行为：仅管理员可用；每次最多 100 个正整数 BIGINT ID；事务内验证当前密码并删除，然后插入新的删除操作审计。

### 后台维护状态

`GET /api/admin/maintenance/status`

行为：仅管理员可用并禁止缓存；返回安全审计清理和图片删除重试的启用状态、间隔、最近成功/失败、耗时、白名单计数、连续失败和通知投递状态。不会返回异常正文、URL、图片名、Token 或 Telegram 配置。

### AI 配置来源

AI 配置仍保存在当前用户的 `appConfig.search.providers.chatgpt` 中：

```json
{
  "useServerManaged": true
}
```

- `true` 或字段缺失：当服务器托管 CLI Proxy 已完整配置时，后端强制使用服务器地址和只读 Secret。
- `false`：后端使用该用户保存的 `mode`、`apiMode`、`endpoint` / `cliProxyBaseUrl` 与用户自己的 API Key，不读取服务器 Secret。
- 模型目录公开响应只返回是否可用及生效的非秘密地址，不返回 API Key、Secret 文件路径或授权头。
- 从旧版导入时允许迁移 `useServerManaged`，但导出仍排除所有 API Key。

## 6. 安全边界

- 密码使用 scrypt 哈希，不保存明文
- 会话 Token 只保存 SHA-256 摘要
- Cookie 使用生产安全属性；跨域必须按当前反代与 HTTPS 重新验收
- 认证、恢复、写操作和 AI 使用持久化限流
- NPM 必须规范化并追加实际入站 peer；`nav-web` 原样转发 XFF 而不二次追加 Docker 地址
- API 可信代理必须逐个精确配置，不能使用 `trustProxy: true`、Docker 宽网段或无条件信任 XFF
- `v.ps-JP` 作为固定外层代理时只信任现场核验的单个公网地址，停用后移除
- `nav.skrskr.net` 是公开分享 canonical/OG/复制链接主域；`nav.cristsau.cn` 保留独立 Cookie 登录别名
- Vite `/assets/` 可长期 immutable；HTML、manifest、API 与动态分享页不得使用长期缓存
- 图床 library Token 必须从当前 release 的 owner-only Secret 目录只读挂载；Compose 通过必填 `NAV_SECRETS_DIR` 解析宿主机路径，不能回退到全局硬编码目录，也不能只恢复 upload Token
- 审计只记录结构化事件、必要 UUID、数量和带密钥摘要
- 加密笔记不得自动上传到公开图床
- 所有删除都必须明确区分“数据库解除引用”和“源对象物理删除”
- 生产数据库删除、迁移、重建容器、DNS、代理和发布都需要单独授权

## 7. 家里 Codex 的推荐接力步骤

1. 克隆或打开 `cristsau/nav-page` 私有仓库。
2. 先运行只读命令确认身份和基线：

   ```powershell
   git status --short --branch
   git remote -v
   git fetch origin --prune
   git rev-parse HEAD
   git rev-parse origin/master
   ```

3. 不要在有未提交内容的长期目录中强行切分支、reset 或覆盖文件。
4. 为新任务建立 `codex/` 前缀的独立工作树。
5. 阅读顺序：
   - 本文件
   - `STATUS_REPORT.md`
   - `README.md`
   - `PROJECT.md`
   - `DEPLOYMENT.md`
   - `docs/NAV_SECURITY_CONTROLS.md`
   - `docs/NAV_BACKUP_RUNBOOK.md`
   - `docs/NAV_PRODUCTION_RELEASE_ACCEPTANCE.md`
6. 只读确认 PR #34、`origin/master` 和实时生产；本文记录的 `25c9c13…` 只是 2026-08-23
   源码与生产验收快照，不能代替当前核验。
7. 完整 npm 安装、依赖审计、API 测试与 Vite 构建优先交给 GitHub Actions；个人电脑默认只做源码、静态和差异检查。
8. 只有 CI 通过、PR 合并、生产前备份与恢复门禁通过并取得明确发布授权后，才能发布。

## 8. 本轮验收清单

### 代码/CI

- [x] JS 语法检查通过
- [x] 新 UI 集成候选纯 Node 测试通过（68/68）；旧版本定向无依赖与隐私测试也已通过
- [x] Git 差异与空白检查通过
- [x] GitHub Actions API 全测通过
- [x] Vite 生产构建通过
- [x] 依赖审计结果已审阅；`nanoid` lock 条目已升级到无该高危公告的 `3.3.18`
- [x] PR `#18` 至 `#34` 已按独立批次合并，最新 `master` CI 通过
- [x] PR `#26/#27` 的分支、PR 与合并后 `master` CI 均通过
- [x] PR `#28/#29` 已合并且 GitHub CI 通过；异地备份仍为源码候选，尚未安装到 OVH
- [x] PR `#30/#31` 已合并且 GitHub CI 与独立 PostgreSQL 16 恢复演练通过，并随 PR #32 发布
- [x] PR #32 的 Telegram 精确目标投递、零送达冷却释放与 PostgreSQL 16 维护集成测试通过
- [x] PR #33/#34 的 Linux root Shell、一次性管理员 PostgreSQL 16、canonical backup
  PostgreSQL 16、恢复与维护 PostgreSQL 集成门禁全部通过
- [x] PR `#26/#27` 新增差异未发现 Token、API Key 或真实 `.env`

### UI、性能与无障碍（已发布并验收）

- [x] 七套内置主题（含 Linear）分别提供亮/暗辅助文字 token，并以背景、卡片和输入区域不低于 `4.5:1` 为门禁
- [x] Session 首次 single-flight、内存复用、页面重新可见时后台复验及受保护请求 `401` 统一失效
- [x] 路由顶部进度、启动骨架、设置六分类懒加载及统一桌面/手机主导航
- [x] 弹窗焦点、Esc、ARIA、标签、44px 触控和空状态修复
- [x] 静态缓存、精确信任代理、真实 IP 转发链和规范分享域名源码修复
- [x] 首页、导航卡、图片库和时光页视觉密度收敛
- [x] 已完成生产前数据库备份、隔离恢复、构建产物与 Compose/Nginx 门禁
- [x] 已完成双域登录态、真实 IP、缓存头、分享 canonical、图床、AI 和桌面/手机响应式验收

### 登录态 UI

- [x] 账户修改、安全审计折叠/选择删除和手机端布局通过源码测试与生产构建
- [x] 双域以真实 Cookie 完成登录、会话读取、设置读取和管理员审计读取
- [x] AI“配置来源”默认使用服务器托管，生效 Base URL 与 Endpoint 只读展示
- [x] 自定义 API 的启用、格式、地址和密钥控件已在生产构建中启用
- [x] 自定义 API 不会读取或回退借用服务器 Secret（后端定向测试覆盖）
- [x] 服务器托管模型目录与一次 Responses API 真实连接测试通过
- [ ] 为避免修改管理员凭据或删除真实审计，本次没有在生产执行“真的改用户名/密码”和“真的删除审计”；首次使用时按单条、可回退方式人工确认
- [ ] 手机端真实设备触控验收尚待使用者完成

### 后台维护可观测性（已发布并验收）

- [x] 新增迁移 018，状态表固定按任务更新，不会随运行次数无限增长
- [x] 第二副本因 advisory lock 跳过时不会覆盖最后一次完成状态
- [x] 连续失败阈值、六小时默认冷却、Telegram 分目标投递和恢复通知已实现
- [x] 持久化仅包含白名单计数、时间与经过清洗的错误代码
- [x] 设置页默认折叠，展开后并行读取审计和后台任务状态
- [x] 39 个无需项目依赖的针对性、隐私、无障碍与设置导航测试通过；源码语法和差异检查通过
- [x] 依赖安装、路由集成测试、完整 API 回归和 Vue 构建由 GitHub CI 通过
- [x] PR #27 已合并，迁移 018 已执行，生产固定两行任务状态且两个任务最近运行成功
- [x] Telegram 目标收到明确标注的测试消息；告警阈值 3、冷却 21600 秒已启用
- [x] PR #32 已验证“零送达不占用完整冷却”、恢复通知和真实 PostgreSQL 16 维护链路

### 生产发布

以下勾选项是 `25c9c13…` 已上线版本的带日期验收，不代表下一次发布时的实时状态：

- [x] 锁定精确 Git merge SHA：`25c9c133ad6c34b857cf13c293aa5a89c8ef04d7`
- [x] 发布前 PostgreSQL 压缩备份与配置副本完成
- [x] 发布前、发布后均在隔离、无网络 PostgreSQL 16 容器中恢复为 17 张表、17 条迁移
- [x] 本次无新迁移；迁移数量与发布源码一致，迁移 018 固定保留两条任务状态
- [x] 本次只重建 `nav-api`；`nav-web`、DB、CLIProxyAPI、NPM、Vaultwarden、Komari 容器 ID
  均保持不变，API 健康且重启计数为 `0`
- [x] 一次性管理员生命周期与精确清理通过；临时账号、marker 和 `/run` 私有目录均为 `0`
- [x] `nav.skrskr.net` 登录态验收
- [x] `nav.cristsau.cn` 登录态验收
- [x] Cookie 为 `Secure`、`HttpOnly`、`SameSite=None`；双域互相跨域预检通过
- [x] 双域返回的前端 `index.html` SHA-256 与发布构建完全一致
- [x] 两项后台任务状态、运行内告警策略和 Telegram 测试目标通过
- [x] 失败时可按固定上一 release 回滚应用；PostgreSQL 与 CLIProxyAPI 不参与应用回滚

### 生产发布证据

- OVH 发布目录：`/opt/nav-stack/releases/20260823-233024-25c9c13`
- 本次 `nav-web` 未重建；双域继续复验的前端 `index.html` SHA-256：
  `2c21947bd73fae227534ba15645106f87954db32be9a122843a2e934f5a4c8c4`
- 精确源码归档和 PostgreSQL 备份哈希保存在该 release 的受限 evidence 中，不在交接文档复制正文
- 生产前门禁、切换、登录态、Telegram 目标、告警启用和发布后恢复证据保存在 release 的受限 `evidence` 中
- 仅应用回滚脚本：`/opt/nav-stack/releases/20260823-233024-25c9c13/rollback-release.sh`；固定目标为
  `/opt/nav-stack/releases/20260823-191619-9b05013`
- 不在本文保存备份正文、凭据、Cookie 或 Secret；哈希只用于完整性核对。
- 后续发布登录态验收使用随机一次性管理员和自动清理；工具与硬中断边界见
  `docs/NAV_PRODUCTION_RELEASE_ACCEPTANCE.md`，不再依赖真实管理员的 release 明文密码。

## 9. 后续优先级

1. 自动异地加密备份、恢复演练、备份失败报警和外部 dead-man。
2. Passkey/WebAuthn；先确定唯一、长期稳定的 RP ID。
3. 提前/离线提醒和定时失效链接检查。
4. 中文 BM25、拼写容错和向量搜索。
5. 把 AI 收敛成带引用来源的个人数据助理，并增加用量/成本面板。
6. 最后评估块编辑器、自动保存和版本历史重构。

## 10. 可直接交给家里 Codex 的提示词

```text
请先完整阅读 docs/NAV_FULL_FEATURES_AND_HANDOFF.md，然后只读核对 Git 当前分支、
origin/master、未提交内容、GitHub PR/CI 和实时生产状态。不要从历史工作树拼接代码，
不要读取或输出任何 Secret、密码、Token、Cookie、私钥或真实 .env。

截至 2026-08-23，账户与审计控制、AI 配置、图床双 Token、主题/无障碍、Session、
缓存/代理、设置/导航、视觉收敛、迁移 017/018、两个后台任务状态、云端安全恢复和运行内
Telegram 失败/恢复告警，以及一次性管理员发布验收生命周期已经发布到 OVH SHA 25c9c13。
当前 GitHub master 可能已继续前进；
先只读核对 origin/master、实时生产 SHA、
双域、容器健康、备份和当前数据库边界；不要推断 Oracle 旧个人数据已恢复。当前首要生产
缺口是把仓库已有的自动异地加密备份候选安全配置到 OVH，完成首次云端快照、定期隔离恢复、
备份失败报警和主机外 dead-man 验收。新改动仍须先经 GitHub CI 和 PR 门禁；生产登录态
验收不得读取真实管理员长期密码，应使用一次性管理员全生命周期工具。
下一项工作必须单独列出影响、备份、回滚、验收和排除项，并等待我明确授权。任何
生产删除、数据库写入、DNS、代理、容器重建或服务重启都不能从这份交接自动获得授权。
```
