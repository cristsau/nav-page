# NAV

轻量、可私有部署的个人导航页，当前已经从“纯前端本地版”演进为：

- Vue 3 + Vite 前端
- Fastify 后端
- PostgreSQL 云端数据
- Dexie / IndexedDB 本地缓存与迁移来源

当前线上测试站：

- [https://nav.skrskr.net](https://nav.skrskr.net)

## 当前能力

- 书签导航与分组管理
- 备忘录 / 日记
- 多用户登录与审批注册
- 自定义主题与搜索引擎配置
- Telegram 审批接入
- AI 搜索代理
  - ChatGPT / OpenAI-compatible
  - Brave Search API
  - OpenClaw
- 浏览器扩展快速添加当前页

## 技术栈

### 前端

- Vue 3
- Vite 5
- Vue Router 4

### 后端

- Fastify
- PostgreSQL

### 本地缓存

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

如果要在服务器侧部署当前后端：

- [scripts/deploy-backend.sh](D:/DomoCodex/projects/NAV/scripts/deploy-backend.sh)
- [docker-compose.backend.yml](D:/DomoCodex/projects/NAV/docker-compose.backend.yml)

## 当前状态

已完成：

- 后端认证与注册审批
- PostgreSQL 主数据接入
- 设置页保存 / 退出
- 自定义主题
- 搜索引擎快速切换
- 便签预览与分享
- Telegram 可配置接入
- AI provider 测试连接按钮
- 浏览器扩展骨架与下载包

待继续推进：

- Telegram 真实联调与体验收口
- AI provider 真实联调
- 中文文案乱码清理
- 浏览器扩展体验优化
- 商业版交付文档与审计 / 备份 / 限流

## 文档入口

继续开发前，优先看这几份：

- [PROJECT.md](D:/DomoCodex/projects/NAV/PROJECT.md)
- [STATUS_REPORT.md](D:/DomoCodex/projects/NAV/STATUS_REPORT.md)
- [DEPLOYMENT.md](D:/DomoCodex/projects/NAV/DEPLOYMENT.md)
- [BACKEND_PLAN.md](D:/DomoCodex/projects/NAV/BACKEND_PLAN.md)

其中：

- `STATUS_REPORT.md` 是当前进度、已完成项、待办项、下一步计划的主文档
- `PROJECT.md` 是项目定位和总体说明
