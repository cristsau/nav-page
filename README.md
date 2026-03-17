# NAV - 个人导航页

<div align="center">

![NAV Logo](./docs/logo.png)

**轻量化、Notion 风格的个人导航页**

[![Vue](https://img.shields.io/badge/Vue-3.x-4FC08D?logo=vue.js)](https://vuejs.org/)
[![Vite](https://img.shields.io/badge/Vite-5.x-646CFF?logo=vite)](https://vitejs.dev/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

[功能特性](#功能特性) · [快速开始](#快速开始) · [文档](./PROJECT.md)

</div>

---

## ✨ 功能特性

- 🔖 **书签管理** - 分组管理、拖拽排序、快速搜索
- 📝 **个人便签** - Notion风格块编辑器、Markdown支持
- 🤖 **AI 辅助** - 自动整理书签、智能分组、网页摘要（预留）
- 🌙 **暗色模式** - 护眼深色主题，自动跟随系统
- 📱 **移动端适配** - 完美响应式设计
- 🔌 **浏览器扩展** - 一键添加当前页面
- 💾 **本地存储** - 数据完全本地化，隐私安全
- 📥 **批量导入** - 支持 Chrome/Firefox 书签导入

## 🚀 快速开始

### 方式一：一键安装（推荐）

```bash
bash <(curl -L -s https://your-domain.com/install.sh)
```

### 方式二：手动安装

```bash
# 克隆项目
git clone https://github.com/cristsau/nav-page.git
cd nav-page

# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev
```

### 方式三：使用模板创建

```bash
npx create-nav-page my-nav
cd my-nav
pnpm dev
```

## 📦 项目结构

```
nav-page/
├── app/                 # 主应用
│   ├── src/
│   │   ├── modules/     # 功能模块
│   │   ├── shared/      # 共享资源
│   │   └── styles/      # 样式文件
│   └── ...
├── extension/           # 浏览器扩展
├── scripts/             # 脚本文件
└── PROJECT.md           # 详细文档
```

## 🛠️ 开发命令

```bash
pnpm dev          # 启动开发服务器
pnpm build        # 构建生产版本
pnpm preview      # 预览生产版本
pnpm lint         # 代码检查
```

## 🌐 部署

### Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/cristsau/nav-page)

### Netlify

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/cristsau/nav-page)

### Docker

```bash
docker build -t nav-page .
docker run -p 3000:80 nav-page
```

## 🔌 安装浏览器扩展

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择项目中的 `extension` 目录

## 📖 文档

详细文档请查看 [PROJECT.md](./PROJECT.md)

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

[MIT License](./LICENSE)

---

<div align="center">

Made with ❤️ by [Your Name]

</div>
