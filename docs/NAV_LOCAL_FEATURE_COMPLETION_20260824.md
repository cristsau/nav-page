# NAV 本地功能完成候选（2026-08-24）

状态：`LOCAL_DONE / READY_FOR_CI / NOT_DEPLOYED`

本页只描述当前本地候选分支，不代表 GitHub、OVH、双域或生产数据库已经更新。异地存储
凭据、Passkey 和后台任务都保持未配置或默认关闭。

## 候选范围

- 基线：`origin/master` 的 `818c2b3`。
- 本地分支：`codex/nav-feature-completion-20260824`。
- 迁移：在现有迁移之后新增 `019` 至 `022`，均为向前兼容的加法迁移。
- 没有执行 `npm install`、`npm ci`、Vite 本地构建、PostgreSQL 写入或生产操作。

## 已完成源码

### 1. 可后填的异地加密备份

- `scripts/restic-offsite.env.example` 不绑定 R2、B2 或任一厂商，保留通用 S3-compatible
  endpoint、bucket、access key 与 restic 密码占位符。
- 默认 `NAV_OFFSITE_BACKUP_ENABLED=false`，仅填写模板不会上传或启用定时器。
- Secret 只能在服务器 owner-only 文件中填写，不能进入 Git、前端、镜像、日志或本文。
- 用户找到免费存储后，再按 `docs/NAV_BACKUP_RUNBOOK.md` 完成凭据、首次快照、保留策略、
  隔离恢复和 dead-man 验收。

### 2. Passkey / WebAuthn

- 固定 RP ID `nav.skrskr.net` 与 Origin `https://nav.skrskr.net`，反代域保持密码登录。
- 包含登记、登录、删除、挑战一次性消费、持久化限流、恢复码重置联动、审计和设置 UI。
- 默认 `NAV_WEBAUTHN_ENABLED=false`；生产迁移与真实 iPhone/电脑验收前不得开启。

### 3. 统一搜索、资料助理与 AI 用量

- 搜索书签与未加密笔记，支持数字 ID、中文子串、标题/标签优先级和稳定排序。
- PostgreSQL 可用 `pg_trgm` 时增加相近文字匹配；不可用时自动退回零扩展查询。
- 单轮资料助理返回 `S1`、`S2` 来源卡片；上下文做凭据遮盖并隔离提示注入。
- AI 只保存按日聚合的请求数、成功/失败、Token 与延迟，不保存问题、正文或回答。
- 7/30/90 天面板、CSV 和可选价格表已完成；没有核验价格时明确显示未知/部分估算。
- AI 用量清理任务默认关闭且有 advisory lock、批次和运行上限。

### 4. 高频生产力闭环

- 提前提醒：准时、提前 10/30/60 分钟、1 天或 7 天；页面打开时刷新并可显式授权
  浏览器通知。加密笔记通知不泄露标题或正文。
- 失效链接：默认关闭的定时检查、集中异常清单、单条/批量复查，以及 SSRF 防护复用。
- 导入导出：Chrome/Edge Bookmark HTML 预览与原子批量导入；普通 Markdown 与 NAV
  多条笔记格式导入导出；限制大小、数量、协议并去重。
- 命令面板：内置主题切换、自动最新或服务端实际发现的 AI 模型切换；保存失败明确提示。
- PWA：隐私安全的离线外壳、显式更新；不缓存 API、账号、笔记、图片、分享或快速添加。
- 笔记：未加密笔记 1.2 秒自动保存、revision 冲突保护、离开前 flush/保护，以及最近
  50 个版本的预览和恢复。
- 版本恢复、加密/解密会撤销旧公开分享，避免旧 bearer URL 静默重新生效。

## 五个后台维护任务

源码、固定状态表、管理员状态页、运行内 Telegram 告警和迁移校验统一包含：

1. `security_event_retention`
2. `media_delete_retry`
3. `ai_usage_retention`
4. `note_reminder_generation`
5. `bookmark_health_check`

后三项在本候选中新增或扩展，生产首次发布仍保持关闭；不能因代码存在就视为已启用。

## 本地验证结果

- 组合依赖无关测试：76 通过、7 因 Windows 无 Bash 跳过、0 失败。
- 变更 JavaScript 语法检查：63 个文件通过。
- 变更 Vue 脚本语法检查：18 个文件通过。
- `git diff --check` 通过。
- 另一路包含数据库模块的测试在本工作树缺少 `pg` 依赖时无法导入；这是完整 CI 门禁，
  不能被上述依赖无关测试替代。
- 全仓库无依赖扫描另有 299 个测试通过；12 个测试文件仅因未安装 `fastify`/`pg` 无法
  导入，7 个 Bash 门禁跳过。不能把这些导入失败写成业务断言失败，也不能把本地扫描写成
  完整 CI 已通过。

## 合并或发布前仍需完成

1. GitHub Linux CI：完整依赖安装、API 测试、Vite 构建和 Shell 门禁。
2. 一次性 PostgreSQL 16：从当前生产备份隔离恢复，执行 `019` 至 `022`，运行
   `verifyMigrations.js` 和针对性恢复演练。
3. 浏览器：Chrome/Edge 书签导入、通知权限、Service Worker 更新与离线外壳。
4. 真机：iPhone 主屏、Passkey、触屏菜单、提醒中心和双域密码登录边界。
5. 生产：新 release、发布前后备份、失败回滚、双域登录态与后台状态验收。
6. 发布后只逐项小批量启用后台任务；异地存储在用户选定供应商后另行配置。

## 明确暂缓，不冒充已完成

- 真正的中文 tokenizer/BM25 与向量 embedding 检索。当前已提供中文子串、可选 trigram
  容错和带来源检索助理；是否引入额外 PostgreSQL 扩展或 embedding provider，应先用真实
  数据评估相关性、隐私、成本和恢复复杂度。
- 网页完全关闭后的 Web Push/VAPID。当前通知只在 NAV 打开时工作，避免在没有可靠推送
  密钥轮换和真机策略前形成“看似会提醒”的假保证。
- 整套 Notion 式块编辑器与多人协作。当前先完成自动保存、冲突保护和版本历史这些数据安全
  基础；块结构、Yjs 和编辑器大迁移需独立设计与回滚方案。
- 扩展商店提交、签名和审核，以及任何第三方存储账号开通，属于外部平台动作。

## 下一次接力入口

按顺序阅读：

1. 本页
2. `STATUS_REPORT.md`
3. `docs/NAV_PASSKEYS.md`
4. `docs/NAV_SEARCH_AI.md`
5. `docs/NAV_PRODUCTIVITY_COMPLETION.md`
6. `docs/NAV_BACKUP_RUNBOOK.md`

接力时先重新核对 `origin/master`、本地分支、GitHub CI 与实时生产 SHA；不要从本文推断
候选已经推送、合并或上线。
