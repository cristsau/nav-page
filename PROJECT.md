# DOMO NAV Project Overview

## 项目定位

DOMO NAV 是一个可私有化部署的导航工作台，目标不是只做静态导航页，而是逐步形成：

- 可登录的个人导航中心
- 可记录便签 / 日记的个人工作台
- 可审批注册的轻量团队入口
- 可接入 AI 搜索与内容整理能力的私有化产品

## 当前技术栈

### 前端

- Vue 3
- Vite 6
- Vue Router 4
- CSS Variables

### 后端

- Fastify
- PostgreSQL

### 本地缓存 / 迁移来源

- Dexie.js
- IndexedDB

说明：

- 当前项目已经不是纯前端 Dexie 版本
- 认证、设置、导航、便签、搜索引擎、Telegram、AI 搜索代理都已逐步迁到后端
- Dexie 现在主要承担本地缓存和旧数据迁移来源的角色

## 当前功能范围

### 导航

- 分组管理
- 书签管理
- 搜索
- 快速添加

### 时光

- 备忘录
- 日记
- 预览
- 分享
- 个人图床图片附件

### 设置

- 主题模式
- 配色方案
- 自定义主题
- 网站名称 / 图标 / favicon
- 搜索引擎管理
- 数据导入导出
- 浏览器集成入口

### 用户系统

- 登录
- 注册
- 审批
- 管理员用户管理
- 会话撤销、恢复码、限流（下一阶段候选，尚未发布）

### Telegram

- 管理员自定义 Telegram Bot Token / Chat ID
- 注册申请通知
- Telegram 审批同步

### AI 搜索

- ChatGPT / OpenAI-compatible
- Brave Search API
- CLI Proxy 动态模型目录与“自动最新”（下一阶段候选，尚未发布）

### 浏览器扩展

- 扩展弹窗快速添加当前页
- 快速选择分组
- 快速创建分组
- 右键菜单添加
- 共享 `/quick-add` 快速添加页

## 当前部署

- 线上地址：[https://nav.skrskr.net](https://nav.skrskr.net)
- 线上服务器：`oracle-JP`

## 开发原则

- 本地开发
- npm 测试和前端生产构建默认交给 GitHub Actions
- GitHub 作为代码主线
- 服务器负责部署，不作为长期主开发机
- 每个阶段收口前先更新 `STATUS_REPORT.md`

## 换电脑继续开发

推荐流程：

1. 先拉取仓库最新代码
2. 先阅读：
   - `D:/DomoCodex/projects/NAV/PROJECT.md`
   - `D:/DomoCodex/projects/NAV/STATUS_REPORT.md`
   - `D:/DomoCodex/projects/NAV/DEPLOYMENT.md`
   - `D:/DomoCodex/projects/NAV/BACKEND_PLAN.md`
3. 再查看当前工作区改动和线上环境

给新的 Codex 直接复制这句就够了：

```text
先 git pull origin master，然后阅读 PROJECT.md、STATUS_REPORT.md、DEPLOYMENT.md、BACKEND_PLAN.md，再查看当前代码和线上环境，按 STATUS_REPORT.md 里的下一步继续实施。
```
