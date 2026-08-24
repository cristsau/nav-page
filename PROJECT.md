# DOMO NAV Project Overview

## 项目定位

DOMO NAV 是面向个人与小团队的私有化导航工作台。产品主线是“每天找东西、记东西”，
围绕导航、搜索、笔记、图片和 AI 形成一个入口；安全、可恢复和长期可维护优先于继续堆叠功能。

## 当前架构

### 前端

- Vue 3
- Vite 6
- Vue Router 4
- CSS Variables 统一主题 token

### 后端

- Fastify
- PostgreSQL
- 服务端代理 CLI Proxy、Brave Search 与个人图床

### 本地缓存与迁移来源

- Dexie.js
- IndexedDB

认证、设置、导航、笔记、搜索引擎、图片元数据和 AI 代理已经以后端为主；Dexie 主要用于
本地模式、缓存和旧数据迁移，不再是生产数据的唯一来源。

## 当前功能范围

### 导航与搜索

- 分组和书签增删改、拖拽排序、批量移动与批量删除
- 常用入口、设计化兜底图标、两行标题和触屏操作菜单
- 书签手动失效检查与最近状态
- 书签、未加密笔记和 Web 的统一搜索
- 自定义搜索引擎增删改与浏览器快速添加
- 导航 AI 分析和 AI 标签

### 时光、分享与图片

- 备忘录、日记、预览、搜索、筛选、数字 ID 和结构化字段复制
- 截止时间、完成状态和打开 NAV 时同步的到期提醒中心
- 笔记 AI 摘要、润色、续写与编辑辅助
- 独立公开分享文章模板和动态预览元数据
- 图片附件经 NAV 后端上传到个人图床；加密笔记禁止上传公开图床图片
- `/media` 图片库：瀑布流、搜索、分页、引用关系、保留策略、分享、删除和对账

### 设置与 AI

- 主题模式、配色方案、自定义主题、站点名称、Logo 与 favicon
- 搜索引擎后台、数据导入导出和浏览器集成入口
- CLI Proxy Responses API、动态模型目录、“自动最新”和推理强度
- Brave Search API 联网结果与来源

### 用户与安全

- 登录、注册、管理员审批与用户管理
- Telegram 注册通知与管理员审批同步
- 会话列表及单个/其他/全部撤销
- 一次性恢复码、密码恢复和恢复后撤销全部会话
- 登录、注册、恢复、已认证写操作和 AI 的 PostgreSQL 共享限流
- 管理员安全审计查询、导出、受控删除、分层保留和后台任务状态面板
- 排除密钥与未知设置的安全 JSON 导出

### 浏览器与移动端

- 扩展弹窗快速添加当前页、分组选择/创建、右键菜单和快捷键
- `/quick-add` 共用快速添加页
- iPhone 快捷指令接入入口
- iPhone/PWA 主屏幕图标与中文名称

## 能力边界

| 状态 | 能力 |
| --- | --- |
| 已验证生产 | 分享 UI、Responses API、动态模型、导航拖拽/批量、到期提醒中心、手动链接检查、图片库与图片生命周期、双域 CORS、图床删除结果闭环、共享限流、安全审计与有界后台维护 |
| 部分完成 | 生产仍为打开页面时提醒、手动链接检查、安装型 PWA、JSON 数据迁移 |
| 本地源码完成、待 CI/发布 | Passkey；统一搜索/带来源助理/AI 用量；提前提醒；定时链接检查；书签 HTML 与 Markdown 导入导出；命令面板主题/模型；PWA 离线外壳；自动保存与 50 版本历史 |
| 外部配置或独立评估 | 异地存储凭据与外部 dead-man；Web Push/VAPID；中文 tokenizer/BM25 与向量 embedding；完整块编辑器 |

精确生产 SHA、验收证据和剩余门槛以 [STATUS_REPORT.md](./STATUS_REPORT.md) 为准。

## 当前生产

- 主域名：[https://nav.skrskr.net](https://nav.skrskr.net)
- 反代域名：[https://nav.cristsau.cn](https://nav.cristsau.cn)
- 当前已验证提交：`25c9c133ad6c34b857cf13c293aa5a89c8ef04d7`
- 当前 release：`/opt/nav-stack/releases/20260823-233024-25c9c13`

生产发布、回滚和外部配置边界见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 开发与发布原则

- GitHub `master` 是代码主线，生产只发布通过 CI 的精确合并 SHA。
- 个人电脑默认只做源码修改、静态检查和差异审阅；npm 测试与构建交给 GitHub Actions
  或服务器独立 release 目录。
- 服务器不是长期主开发机；发布不在含生产专属文件的长期工作树原地构建。
- 每次生产发布先备份并做隔离恢复，再迁移、切换、双域验收，最后做发布后恢复演练。
- 密钥仅由服务器 owner-only Secret 或环境文件提供，不进入 GitHub、前端或镜像。
- 每个阶段收口后更新 [STATUS_REPORT.md](./STATUS_REPORT.md)，明确“已完成 / 部分完成 / 未完成”。

## 后续优先级

1. 先让 2026-08-24 本地候选通过 GitHub Linux CI、PostgreSQL 16 隔离迁移/恢复和真机验收。
2. 发布后保持新增开关关闭，按 Passkey、提醒、链接检查、AI 用量清理的顺序渐进启用。
3. 用户选定免费存储后填写通用异地备份 Secret，再做首次快照、恢复演练与外部 dead-man。
4. 用真实数据决定是否引入中文 tokenizer/BM25、向量 embedding、Web Push 和完整块编辑器。

## 接力阅读顺序

1. [STATUS_REPORT.md](./STATUS_REPORT.md)
2. [PROJECT.md](./PROJECT.md)
3. [DEPLOYMENT.md](./DEPLOYMENT.md)
4. [BACKEND_PLAN.md](./BACKEND_PLAN.md)

继续开发前应重新核对 GitHub、当前工作区和实时生产状态，不能把本文的历史快照直接当作
下一次发布授权。
