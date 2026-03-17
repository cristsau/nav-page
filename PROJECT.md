# NAV - 个人导航页

> 轻量化、Notion风格的个人导航页，支持书签管理、个人便签、AI辅助功能

## 技术栈

| 类型 | 选择 |
|------|------|
| 框架 | Vue 3 + Vite |
| 路由 | Vue Router 4 |
| 数据库 | Dexie.js (IndexedDB封装) |
| 编辑器 | Tiptap (Notion-like块编辑器) |
| 样式 | CSS Variables + Notion风格 |
| AI接口 | OpenAI + GLM 兼容格式 |
| 扩展 | Chrome Extension (Manifest V3) |

## 功能模块

### 1. 导航模块 (Navigation)
- [x] 书签分组管理
- [x] 分组 CRUD（创建、读取、更新、删除）
- [x] 书签 CRUD
- [x] 拖拽排序
- [x] 搜索过滤
- [ ] 批量导入（Chrome HTML / JSON / CSV）
- [ ] Favicon 自动获取

### 2. 便签模块 (Notes)
- [ ] Notion风格块编辑器
- [ ] Markdown 支持
- [ ] 日记/笔记分类
- [ ] 标签系统
- [ ] 搜索功能

### 3. AI模块 (AI) - 预留
- [ ] AI自动整理书签
- [ ] AI自动分组建议
- [ ] AI读取网页内容 → 保存到便签
- [ ] 支持OpenAI / GLM接口

### 4. 导入模块 (Import)
- [ ] Chrome书签HTML导入
- [ ] JSON格式导入
- [ ] CSV格式导入
- [ ] 导出备份

### 5. 设置模块 (Settings)
- [ ] 暗色/亮色主题切换
- [ ] AI接口配置
- [ ] 数据备份/恢复
- [ ] 清除数据

### 6. 浏览器扩展 (Extension)
- [ ] 一键添加当前页面到导航
- [ ] 弹窗选择分组
- [ ] 支持新建分组
- [ ] Chrome / Firefox 兼容

## 项目结构

```
nav-page/
├── app/                              # 主应用
│   ├── public/
│   ├── src/
│   │   ├── modules/                  # 功能模块
│   │   │   ├── navigation/
│   │   │   │   ├── components/
│   │   │   │   │   ├── NavGroup.vue
│   │   │   │   │   ├── NavItem.vue
│   │   │   │   │   └── AddToNav.vue
│   │   │   │   └── Navigation.vue
│   │   │   │
│   │   │   ├── notes/
│   │   │   │   ├── components/
│   │   │   │   │   ├── NoteCard.vue
│   │   │   │   │   └── NoteEditor.vue
│   │   │   │   └── Notes.vue
│   │   │   │
│   │   │   ├── ai/
│   │   │   │   ├── components/
│   │   │   │   │   ├── AutoOrganize.vue
│   │   │   │   │   └── WebSummary.vue
│   │   │   │   └── AI.vue
│   │   │   │
│   │   │   ├── import/
│   │   │   │   └── Import.vue
│   │   │   │
│   │   │   └── settings/
│   │   │       └── Settings.vue
│   │   │
│   │   ├── shared/                   # 共享资源
│   │   │   ├── db/
│   │   │   │   └── database.js       # Dexie数据库封装
│   │   │   ├── components/
│   │   │   │   ├── Modal.vue
│   │   │   │   ├── Button.vue
│   │   │   │   ├── Card.vue
│   │   │   │   └── ThemeToggle.vue
│   │   │   └── composables/
│   │   │       ├── useTheme.js
│   │   │       ├── useDB.js
│   │   │       └── useShortcuts.js
│   │   │
│   │   ├── styles/
│   │   │   ├── variables.css         # CSS变量（主题）
│   │   │   ├── reset.css
│   │   │   └── notion.css
│   │   │
│   │   ├── router/
│   │   │   └── index.js
│   │   │
│   │   ├── App.vue
│   │   └── main.js
│   │
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js
│   └── README.md
│
├── extension/                        # 浏览器扩展
│   ├── manifest.json
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.js
│   │   └── popup.css
│   ├── content/
│   │   └── content.js
│   ├── background/
│   │   └── background.js
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
│
├── scripts/
│   └── install.sh                    # 一键安装脚本
│
├── PROJECT.md                        # 项目文档（本文件）
├── README.md
└── package.json                      # 根package.json（工作区）
```

## 数据结构

### 书签分组 (groups)
```javascript
{
  id: 'uuid',
  name: '开发工具',
  icon: '🔧',
  color: '#3b82f6',
  order: 0,
  collapsed: false,
  createdAt: 1710691200000,
  updatedAt: 1710691200000
}
```

### 书签/导航链接 (bookmarks)
```javascript
{
  id: 'uuid',
  groupId: 'group-uuid',
  title: 'Vue.js',
  url: 'https://vuejs.org',
  favicon: 'https://vuejs.org/logo.svg',
  description: 'The Progressive JavaScript Framework',
  tags: ['vue', 'frontend', 'doc'],
  aiSummary: '',           // AI总结内容（预留）
  order: 0,
  createdAt: 1710691200000,
  updatedAt: 1710691200000
}
```

### 个人便签 (notes)
```javascript
{
  id: 'uuid',
  title: '2024-03-17 学习笔记',
  content: '<p>HTML内容...</p>',
  contentPlain: '纯文本内容...',
  type: 'daily',           // 'daily' | 'note'
  tags: ['学习', '前端'],
  sourceUrl: '',           // 来源网页（AI抓取时）
  order: 0,
  createdAt: 1710691200000,
  updatedAt: 1710691200000
}
```

### 设置 (settings)
```javascript
{
  id: 'theme',
  value: 'light'           // 'light' | 'dark' | 'system'
},
{
  id: 'aiConfig',
  value: {
    provider: 'openai',    // 'openai' | 'glm' | 'custom'
    apiKey: '',
    baseUrl: '',
    model: 'gpt-4'
  }
}
```

## 开发阶段

### Phase 1: 基础框架 (核心)
- [x] 项目初始化
- [ ] Vue Router 配置
- [ ] Dexie 数据库封装
- [ ] 基础 Notion 风格样式
- [ ] 导航模块基础功能
- [ ] 分组 CRUD
- [ ] 书签 CRUD

### Phase 2: 导航增强
- [ ] 拖拽排序
- [ ] 搜索过滤
- [ ] 批量导入
- [ ] 浏览器扩展

### Phase 3: 便签模块
- [ ] Tiptap 编辑器集成
- [ ] 便签 CRUD
- [ ] 标签系统
- [ ] 搜索功能

### Phase 4: 样式完善
- [ ] 暗色模式
- [ ] 移动端适配
- [ ] 动画优化

### Phase 5: AI 集成
- [ ] AI 接口封装
- [ ] 自动整理书签
- [ ] 网页内容抓取
- [ ] AI 分组建议

## 主题配色

### 亮色模式
```css
--bg-primary: #ffffff;
--bg-secondary: #f7f6f3;
--bg-hover: #efefef;
--text-primary: #37352f;
--text-secondary: #787774;
--border-color: #e3e2e0;
--accent-color: #2383e2;
```

### 暗色模式
```css
--bg-primary: #191919;
--bg-secondary: #202020;
--bg-hover: #2f2f2f;
--text-primary: #e6e6e6;
--text-secondary: #9b9a97;
--border-color: #373737;
--accent-color: #529cca;
```

## 浏览器扩展通信

### 扩展 → 主应用
```javascript
// 方式1: 打开主应用 + URL参数
chrome.tabs.create({
  url: `https://your-nav.com/add?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`
});

// 方式2: BroadcastChannel（如果主应用已打开）
const channel = new BroadcastChannel('nav-page');
channel.postMessage({
  type: 'ADD_BOOKMARK',
  data: { url, title, favicon }
});
```

### 主应用监听
```javascript
// 监听 URL 参数
const route = useRoute();
if (route.query.url) {
  // 打开添加弹窗
  showAddModal(route.query.url, route.query.title);
}

// 监听 BroadcastChannel
const channel = new BroadcastChannel('nav-page');
channel.onmessage = (event) => {
  if (event.data.type === 'ADD_BOOKMARK') {
    showAddModal(event.data.data);
  }
};
```

## 一键安装

```bash
# 安装项目
bash <(curl -L -s https://your-domain.com/install.sh)

# 或使用 npx
npx create-nav-page
```

## 开发命令

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm dev

# 构建生产版本
pnpm build

# 构建浏览器扩展
pnpm build:extension

# 预览生产版本
pnpm preview
```

## 许可证

MIT License
