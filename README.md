# DOMO NAV

DOMO NAV 是面向个人与小团队的私有化导航工作台。它把导航、搜索、笔记、日记、图片库、
账号安全和 AI 整合在一个入口中，后端使用 Fastify + PostgreSQL，前端使用 Vue 3 + Vite。

生产入口：

- [nav.skrskr.net](https://nav.skrskr.net)
- [nav.cristsau.cn](https://nav.cristsau.cn)

精确生产版本、验收证据和已知缺口见 [STATUS_REPORT.md](./STATUS_REPORT.md)。

## 当前源码已实现

- 用户登录、注册审批、Telegram 审批同步、用户名/密码修改、会话撤销、恢复码和密码恢复
- 分组与书签管理、拖拽排序、批量移动/删除和手动失效检查
- 书签、未加密笔记和 Web 的统一搜索；精确数字 ID、中文 BM25、本地向量语义、可选错字容错和自定义搜索引擎管理
- 备忘录、日记、截止时间、可配置提前提醒、页面关闭后的 Web Push、数字 ID、快速复制和公开分享
- CLI Proxy Responses API、动态模型目录、推理强度、导航/笔记 AI、AI 标签和带 S1 来源的单轮个人资料助理
- 不保存问答内容的 AI 日聚合用量、7/30/90 天面板、CSV 与可选单价成本估算
- 图片附件经 NAV 后端上传到个人图床，不写入 NAV 磁盘
- `/media` 图片库：瀑布流、搜索、分页、引用关系、保留策略、分享、删除与对账
- 上传与库管理双 Token 最小权限分离，图片最后引用移除后的受控清理
- 图床删除结果严格校验与持久化，区分物理删除、仅解除引用和缓存状态
- PostgreSQL 共享限流、最小化安全审计、后台任务状态与管理员审计面板
- 浏览器扩展、`/quick-add`、右键菜单/快捷键和 iPhone 快捷指令入口
- iPhone/PWA 主屏幕图标、隐私安全的离线外壳、统一主题 token、触屏操作菜单和命令面板
- Chrome/Edge 书签 HTML 预览导入、Markdown 笔记导入导出和目录级去重
- 定时失效链接检查候选、集中异常清单、单条/批量复查与后台运行状态
- Notion 式单用户块编辑器、未加密笔记自动保存、并发冲突保护和有界版本历史（最近 50 个版本）
- 安全 JSON 导出，以及带预览、当前密码复验和状态签名的替换式恢复候选
- Yjs/CRDT 多人正文协作、角色权限、选区/块评论和近实时评论刷新
- 已访问工作区的完整离线编辑、幂等 outbox、Yjs IndexedDB 持久化及跨设备增量同步
- 128 MiB NDJSON 流式上传恢复、250 条批处理和 6,500 条 PostgreSQL 16 集成演练
- 图床对象、Nginx Proxy Manager 与外层代理配置纳入完整备份/双门禁一键灾难恢复候选

Passkey/WebAuthn、BM25/本地向量语义搜索、Web Push、块编辑器、多人协作、离线同步、流式
恢复和整套灾难恢复的源码状态与生产状态可能不同，必须以状态页的精确证据为准；异地加密备份
仍为 `SOURCE_READY / USER_CONFIG_LATER / NOT_DEPLOYED`。主机外失联监测和扩展商店提交仍需
外部资源或人工流程，详见
[STATUS_REPORT.md](./STATUS_REPORT.md)。

## 技术栈

### 前端

- Vue 3
- Vite 6
- Vue Router 4
- Dexie.js（本地模式、缓存和旧数据迁移）

### 后端

- Fastify
- PostgreSQL 16
- CLI Proxy / Brave Search / CloudFlare-ImgBed 服务端代理

## 验证方式

项目默认不要求在个人电脑运行 npm。源码修改和静态差异检查可在本地完成，完整安装、依赖审计、
PostgreSQL 迁移校验、API 测试与 Vite 生产构建由
[GitHub Actions](./.github/workflows/ci.yml) 执行。生产发布只使用通过 CI 的精确合并 SHA，
并在服务器独立 release 目录完成等价复验。

如确需隔离开发，前端和 API 的标准脚本分别定义在 `app/package.json` 与 `api/package.json`；
不要在含生产专属文件的长期服务器工作树中安装依赖或原地构建。

## 浏览器扩展

网页一键收藏优先使用浏览器扩展：它可以读取当前标签页的标题、网址和 favicon，权限范围小于
桌面安装程序。

- [扩展源码](./extension)
- [扩展说明](./extension/README.md)
- [当前下载包](./app/public/downloads/nav-extension.zip)

## 文档导航

1. [生产状态与剩余门槛](./STATUS_REPORT.md)
2. [产品与架构概览](./PROJECT.md)
3. [部署、回滚与安全边界](./DEPLOYMENT.md)
4. [后端演进计划](./BACKEND_PLAN.md)
5. [备份、自动调度与恢复运行手册](./docs/NAV_BACKUP_RUNBOOK.md)
6. [完整功能与跨电脑续作交接](./docs/NAV_FULL_FEATURES_AND_HANDOFF.md)
7. [共享限流与安全审计](./docs/NAV_SECURITY_CONTROLS.md)
8. [云端 JSON 安全恢复](./docs/NAV_DATA_RESTORE.md)
9. [后台保留与图片删除重试](./docs/NAV_BACKGROUND_MAINTENANCE.md)
10. [Passkey / WebAuthn 安全边界与启用手册](./docs/NAV_PASSKEYS.md)
11. [统一搜索、个人资料助理与 AI 用量](./docs/NAV_SEARCH_AI.md)
12. [提前提醒、链接检查、迁移、PWA 与版本历史候选](./docs/NAV_PRODUCTIVITY_COMPLETION.md)
13. [2026-08-24 本地功能完成候选与外部验收边界](./docs/NAV_LOCAL_FEATURE_COMPLETION_20260824.md)
14. [BM25/本地向量、Web Push 与单用户块编辑器](./docs/NAV_ADVANCED_SEARCH_PUSH_BLOCK_EDITOR.md)
15. [多人协作、离线同步、整套灾难恢复与流式恢复](./docs/NAV_COLLABORATION_OFFLINE_DR_STREAMING.md)

继续开发或发布前，应重新核对 GitHub、当前工作区和实时生产状态；仓库文档不是生产写入授权。
