# NAV

轻量、可私有部署的个人导航页，当前支持：

- 书签导航与分组管理
- 备忘录 / 日记
- 多用户登录与审批注册
- 自定义主题与搜索引擎配置
- Telegram 审批接入

## 技术栈

- Vue 3
- Vite 5
- Vue Router 4
- Dexie.js / IndexedDB

## 本地开发

```bash
cd app
npm install
npm run dev
```

默认开发地址：

- [http://localhost:5174](http://localhost:5174)

## 当前状态

已完成：

- 用户系统与审批注册
- 设置页保存 / 退出
- 自定义主题
- 搜索引擎快速切换
- 备忘录预览
- Telegram 可配置接入

待推进：

- 中文文案整理
- ChatGPT Search / Brave Search 实际 API 执行
- 多设备同步
- AI / OpenClaw 接入

## 文档

详细进度与项目目标见：

- [PROJECT.md](D:/DomoCodex/projects/NAV/PROJECT.md)
