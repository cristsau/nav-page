# NAV Project Overview

## 项目定位

NAV 是一个可私有部署的个人导航页系统，当前目标不是只做“静态导航首页”，而是逐步演进成：

- 可登录的个人导航中心
- 可记录便签 / 日记的个人工作台
- 可审批注册的轻量团队入口
- 可接入 AI 搜索与内容整理能力的私有化产品

## 当前技术栈

### 前端

- Vue 3
- Vite 5
- Vue Router 4
- CSS Variables

### 后端

- Fastify
- PostgreSQL

### 本地缓存 / 数据迁移

- Dexie.js
- IndexedDB

说明：

- 当前项目已经不是纯前端 Dexie 版本
- 认证、设置、导航、便签、搜索引擎、Telegram、AI 代理都在逐步迁到后端
- Dexie 现在主要承担本地缓存和迁移来源的角色

## 当前功能范围

### 导航

- 分组管理
- 书签管理
- 书签搜索
- 快速添加

### 时光

- 备忘录
- 日记
- 预览
- 分享

### 设置

- 主题模式
- 配色方案
- 自定义主题
- 网站图标 / favicon
- 搜索引擎管理
- 数据导入导出
- 浏览器集成入口

### 用户系统

- 登录
- 注册
- 审批
- 管理员用户管理

### Telegram

- 管理员自定义 Telegram Bot Token / Chat ID
- 注册申请通知
- Telegram 审批同步

### AI 搜索

- ChatGPT / OpenAI-compatible
- Brave Search API
- OpenClaw

## 当前部署

- 测试站点：[https://nav.skrskr.net](https://nav.skrskr.net)
- 测试服务器：`oracle-JP`

## 当前开发原则

- 本地开发
- GitHub 作为代码主线
- 服务器负责部署，不作为长期主开发机
- 未确认前不急于提交，先在线上测试环境验证

## 最重要的进度文档

如果下次继续实施，请优先看：

- `D:/DomoCodex/projects/NAV/STATUS_REPORT.md`

这个文件应始终作为“当前进度、已完成项、剩余工作、下一步动作”的主文档。 

## 换电脑继续开发

如果后面换到另一台电脑继续让 Codex 帮你开发，最稳的方式是：

1. 先拉取仓库最新代码
2. 先阅读：
   - `D:/DomoCodex/projects/NAV/PROJECT.md`
   - `D:/DomoCodex/projects/NAV/STATUS_REPORT.md`
   - `D:/DomoCodex/projects/NAV/DEPLOYMENT.md`
   - `D:/DomoCodex/projects/NAV/BACKEND_PLAN.md`
3. 再查看当前工作区改动和线上环境

这样新的 Codex 即使没有当前聊天记录，也能快速恢复上下文。 
