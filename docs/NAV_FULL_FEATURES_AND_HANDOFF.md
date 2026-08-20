# DOMO NAV 完整功能与跨电脑续作交接

> 更新日期：2026-08-20
> 用途：把本文件交给另一台电脑上的 Codex，快速恢复项目上下文。
> 安全说明：本文不包含用户名、密码、Token、Cookie、私钥、真实 `.env` 或个人数据。

## 1. 当前状态

- GitHub 仓库：`cristsau/nav-page`，应保持 **Private**。
- 主分支：`master`。
- 本轮开始时的远端基线：`86ede7a001d585ea929e698afdcae0976a3cbde0`。
- 本轮开发分支：`codex/nav-account-audit-controls`。
- 本轮独立工作树：`D:\DomoCodex\projects\NAV-account-audit-controls`。
- 生产入口：`https://nav.skrskr.net`、`https://nav.cristsau.cn`。
- AI 兼容入口：`https://ap.skrskr.net`。
- 当前已知生产承载已从异常的 Oracle 主机灾难迁移到 OVH；任何后续发布前必须重新只读核验，不能把本文当作实时状态证明。
- 本轮账户修改与审计删除功能属于 **本地候选**；在 GitHub CI、合并、备份和生产验收完成前，不得写成“已上线”。

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

本轮新增候选：

- 设置中修改用户名：必须输入当前密码；用户名唯一；成功后保留当前会话并同步页面状态
- 设置中修改密码：必须输入当前密码；新密码至少 12 个字符且不能与旧密码相同；成功后撤销全部会话并要求重新登录
- 用户名与密码修改写入独立安全审计事件
- 安全审计默认折叠，首次展开时才读取数据
- 管理员可选择当前页审计记录删除，每批最多 100 条
- 删除必须再次输入当前密码
- 删除完成后新建一条 `admin.security_events.delete` 审计，记录删除数量而不记录密码或事件正文

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

当前边界：自动异地加密备份、失败报警、外部 dead-man 和完整生态一键恢复仍需继续建设。

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

## 6. 安全边界

- 密码使用 scrypt 哈希，不保存明文
- 会话 Token 只保存 SHA-256 摘要
- Cookie 使用生产安全属性；跨域必须按当前反代与 HTTPS 重新验收
- 认证、恢复、写操作和 AI 使用持久化限流
- 可信代理必须精确配置，不能无条件信任任意 `X-Forwarded-For`
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
6. 检查本轮分支是否已推送；如果没有，先从当前电脑导出补丁或等待本轮发布，不要猜测重写。
7. 完整 npm 安装、依赖审计、API 测试与 Vite 构建优先交给 GitHub Actions；个人电脑默认只做源码、静态和差异检查。
8. 只有 CI 通过、PR 合并、生产前备份与恢复门禁通过并取得明确发布授权后，才能发布。

## 8. 本轮验收清单

### 代码/CI

- [x] JS 语法检查通过
- [x] 定向无依赖与隐私测试通过（15/15）
- [x] Git 差异与空白检查通过
- [ ] GitHub Actions API 全测通过
- [ ] Vite 生产构建通过
- [ ] 依赖审计结果已审阅

### 登录态 UI

- [ ] 当前密码错误时用户名不变
- [ ] 重复用户名返回清晰提示
- [ ] 修改用户名后设置页标题立即更新
- [ ] 新密码少于 12 个字符被拒绝
- [ ] 两次新密码不一致被拒绝
- [ ] 修改密码后当前与其他设备全部退出
- [ ] 旧密码不能登录，新密码可以登录
- [ ] 用户名/密码操作出现在安全审计中
- [ ] 安全审计首次进入设置时保持折叠且不发起列表请求
- [ ] 展开后筛选、分页和复制保持正常
- [ ] 删除模式支持逐条选择与全选本页
- [ ] 错误当前密码不能删除
- [ ] 正确密码只删除所选记录
- [ ] 删除后存在新的“删除安全审计记录”事件
- [ ] 手机端按钮、密码输入和复选框可触达

### 生产发布

- [ ] 锁定精确 Git merge SHA
- [ ] 发布前 PostgreSQL 与配置备份
- [ ] 隔离恢复演练成功
- [ ] 迁移重复执行安全
- [ ] API/DB 容器健康且重启计数无异常
- [ ] `nav.skrskr.net` 登录态验收
- [ ] `nav.cristsau.cn` 登录态验收
- [ ] 安全 Cookie 与双域 CORS 验收
- [ ] 失败时可按固定旧 SHA 回滚应用；不破坏发布后的新数据

## 9. 后续优先级

1. 自动异地加密备份、恢复演练、失败报警和 dead-man。
2. 审计自动保留策略、失败告警和导出；手工删除不是保留策略的替代品。
3. Passkey/WebAuthn；先确定唯一、长期稳定的 RP ID。
4. 提前/离线提醒和定时失效链接检查。
5. 中文 BM25、拼写容错和向量搜索。
6. 把 AI 收敛成带引用来源的个人数据助理，并增加用量/成本面板。
7. 最后评估块编辑器、自动保存和版本历史重构。

## 10. 可直接交给家里 Codex 的提示词

```text
请先完整阅读 docs/NAV_FULL_FEATURES_AND_HANDOFF.md，然后只读核对 Git 当前分支、
origin/master、未提交内容、GitHub PR/CI 和实时生产状态。不要从历史工作树拼接代码，
不要读取或输出任何 Secret、密码、Token、Cookie、私钥或真实 .env。

本轮重点是继续验收/发布“账户用户名与密码修改 + 安全审计默认折叠和受保护删除”。
如果候选尚未合并，先审查差异并跑 CI；如果已经合并，发布前先列出影响、备份、
回滚、验收和排除项，并等待我明确授权。任何生产删除、数据库写入、DNS、代理、
容器重建或服务重启都不能从这份交接自动获得授权。
```
