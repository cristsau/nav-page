# DOMO NAV

DOMO NAV 是一个面向个人与小团队的私有化导航工作台。它已经从“纯前端本地版”演进到“前端 + Fastify + PostgreSQL”的测试商用架构，支持用户登录、审批注册、云端书签与便签、Telegram 审批、AI 搜索代理和浏览器扩展快速收藏。

当前线上测试地址：

- [https://nav.skrskr.net](https://nav.skrskr.net)

## 当前已实现

- 用户登录、注册、审批
- 书签分组与书签管理
- 备忘录 / 日记 / 分享
  - 日记日期、心情、按月归档
  - 备忘录截止时间、完成状态、搜索与筛选
  - 加密笔记禁止公开分享
- 设置页保存、退出、自定义主题、网站名称、图标、favicon
- 搜索引擎配置与 AI 搜索代理
  - ChatGPT / OpenAI-compatible
  - Brave Search API
  - OpenClaw
- Telegram Bot 配置与审批同步
- 浏览器扩展快速添加当前页
  - 记住上次分组
  - 右键菜单或 `Ctrl+Shift+Y` 一键收藏
  - 同分组网址防重复
- `/quick-add` 快速添加页
- iPhone 快捷指令接入入口

## 技术栈

### 前端

- Vue 3
- Vite 5
- Vue Router 4

### 后端

- Fastify
- PostgreSQL

### 本地缓存 / 迁移来源

- Dexie.js
- IndexedDB

## 本地开发

### 前端

```bash
cd app
npm install
npm run dev
```

默认开发地址：

- [http://localhost:5174](http://localhost:5174)

### 后端

```bash
cd api
npm install
```

## 部署相关

- 线上服务器：`oracle-JP`
- 当前测试域名：`nav.skrskr.net`
- 部署文档：`D:/DomoCodex/projects/NAV/DEPLOYMENT.md`
- 后端规划：`D:/DomoCodex/projects/NAV/BACKEND_PLAN.md`

## 浏览器扩展

网页一键收藏优先推荐浏览器扩展，而不是桌面安装程序：扩展能够直接读取当前标签页的标题、网址和 favicon，权限范围也更小。

- 源码：`D:/DomoCodex/projects/NAV/extension`
- 下载包：`D:/DomoCodex/projects/NAV/app/public/downloads/nav-extension.zip`
- 使用说明：`D:/DomoCodex/projects/NAV/extension/README.md`

## 推荐阅读顺序

如果要继续开发或换电脑接力，优先看：

- `D:/DomoCodex/projects/NAV/STATUS_REPORT.md`
- `D:/DomoCodex/projects/NAV/PROJECT.md`
- `D:/DomoCodex/projects/NAV/DEPLOYMENT.md`
- `D:/DomoCodex/projects/NAV/BACKEND_PLAN.md`
