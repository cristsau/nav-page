# DOMO NAV

DOMO NAV 是面向个人与小团队的私有化导航工作台。它把导航、搜索、笔记、日记、图片库、
账号安全和 AI 整合在一个入口中，后端使用 Fastify + PostgreSQL，前端使用 Vue 3 + Vite。

生产入口：

- [nav.skrskr.net](https://nav.skrskr.net)
- [nav.cristsau.cn](https://nav.cristsau.cn)

精确生产版本、验收证据和已知缺口见 [STATUS_REPORT.md](./STATUS_REPORT.md)。

## 当前已实现

- 用户登录、注册审批、Telegram 审批同步、会话撤销、恢复码和密码恢复
- 分组与书签管理、拖拽排序、批量移动/删除和手动失效检查
- 书签、未加密笔记和 Web 的统一搜索；自定义搜索引擎管理
- 备忘录、日记、截止时间、到期提醒中心、数字 ID、快速复制和公开分享
- CLI Proxy Responses API、动态模型目录、推理强度、导航/笔记 AI 和 AI 标签
- 图片附件经 NAV 后端上传到个人图床，不写入 NAV 磁盘
- `/media` 图片库：瀑布流、搜索、分页、引用关系、保留策略、分享、删除与对账
- 上传与库管理双 Token 最小权限分离，图片最后引用移除后的受控清理
- （待发布候选）图床删除结果严格校验与持久化，区分物理删除、仅解除引用和缓存状态
- （待发布候选）PostgreSQL 共享限流、最小化安全审计 API 与管理员审计面板
- 浏览器扩展、`/quick-add`、右键菜单/快捷键和 iPhone 快捷指令入口
- iPhone/PWA 主屏幕图标、统一主题 token、触屏操作菜单和命令面板
- 安全 JSON 导入导出、本地备份工具和隔离恢复演练

部分完成和未完成项目包括生产发布验收、审计保留/告警、自动异地备份/报警、Passkey、
离线/提前提醒、定时链接检查、个人数据 RAG 与编辑器版本历史，详见
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
5. [备份与恢复运行手册](./docs/NAV_BACKUP_RUNBOOK.md)

继续开发或发布前，应重新核对 GitHub、当前工作区和实时生产状态；仓库文档不是生产写入授权。
