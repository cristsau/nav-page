# NAV Status Report

最后更新：2026-03-20

## 1. 项目目标

NAV 当前分成两个阶段目标：

1. 测试版目标
- 让 [https://nav.skrskr.net](https://nav.skrskr.net) 成为可稳定访问、可演示、可日常使用的个人导航站
- 支持书签、便签、主题、搜索、注册审批、浏览器扩展快速添加

2. 商业版目标
- 形成“前端 + 后端 API + PostgreSQL”的正式架构
- 支持多用户、审批、Telegram、AI 搜索代理
- 后续可以作为团体买断版交付给客户自行部署

## 2. 当前线上环境

- 线上地址：`https://nav.skrskr.net`
- 服务器：`oracle-JP`
- 前端：`Vue 3 + Vite`
- 后端：`Fastify`
- 数据库：`PostgreSQL`
- 反向代理：`nginx`

当前线上环境定位：
- 持续演进中的测试版
- 已可用于日常测试和小范围演示
- 还不是最终商业交付版

## 3. 已完成内容

### 3.1 用户与认证

- 登录、注册、审批已后端化
- 会话由后端 cookie 管理
- 管理员可查看待审批申请、已批准用户、审批历史
- 管理员 Telegram 配置已后端化
- 默认管理员密码不再在代码里硬编码兜底

### 3.2 导航主功能

- 分组 CRUD
- 书签 CRUD
- 书签搜索
- 分组与书签排序
- 快速添加书签

### 3.3 时光 / 便签

- 备忘录 / 日记 CRUD
- 点击卡片预览
- 分享链接生成
- 公开分享页

### 3.4 设置

- 亮色 / 暗色 / 跟随系统
- 配色方案
- 自定义主题入口
- 网站名称 / 图标 / favicon
- 搜索引擎显示管理
- 数据导入导出
- 本地 IndexedDB -> PostgreSQL 迁移入口
- 浏览器集成设置页

关于“迁移本地数据到云端”：

- 这个功能现在仍然有价值
- 它不是给“全新用户”用的，而是给旧浏览器、本地开发阶段、老版本 NAV 用户用的
- 只要某台设备里还留着历史 IndexedDB 数据，这个入口就可以把旧数据一次性导入 PostgreSQL
- 当确认所有历史设备都已经迁移完、本地 Dexie 不再承担迁移来源角色后，再考虑移除

### 3.5 搜索与 AI

- 普通网页搜索引擎切换
- 首页快速切换引擎显示管理
- AI 搜索代理已接入：
  - ChatGPT / OpenAI-compatible
  - Brave Search API
  - OpenClaw
- 首页搜索框已支持 AI 结果面板
- 设置页已支持 AI provider 配置
- 已新增 AI provider “测试连接”按钮

### 3.6 Telegram

- Telegram Bot Token / Chat ID 不再写死
- 每个管理员都可以填写自己的 Telegram 配置
- 支持 Telegram 审批同步
- 已新增后端兼容路由，避免旧前端资源继续请求旧的 `/api/telegram/get-me` 时直接 404

### 3.7 浏览器集成

- 已新增 `/quick-add` 快速添加页
- 已完成浏览器扩展骨架
- 扩展支持：
  - 添加当前页到 NAV
  - 选择分组
  - 快速创建分组
  - 无分组时自动落默认分组
  - 右键菜单添加
- 已提供扩展下载包：
  - `/downloads/nav-extension.zip`
- 已提供安装说明：
  - `/downloads/nav-extension/README.html`
- 已新增 iPhone 快速添加方案入口

## 4. 本轮关键进展

### 4.1 Telegram 失败原因已定位

用户之前看到的报错：

```json
{"message":"Route POST:/api/telegram/get-me not found","error":"Not Found","statusCode":404}
```

根因不是 Bot Token 或 Chat ID 无效，而是：

- 之前服务器上的前端生产构建一度按本地模式构建
- 设置页因此仍会走旧的 Telegram dev-proxy 路由
- 旧前端会请求 `/api/telegram/get-me`
- 后端正式版原先没有这个旧兼容路由，所以返回 404

现在已完成：

- 新增 `app/.env.production`
  - `VITE_AUTH_MODE=backend`
  - `VITE_API_BASE_URL=/api`
- 修正服务器部署脚本默认值
  - `scripts/deploy.sh` 现在默认按 `backend` 模式构建
- 后端已补兼容路由：
  - `POST /api/telegram/get-me`
  - `POST /api/telegram/get-updates`
  - `POST /api/telegram/send-message`

当前线上验证结果：

- `/api/admin/telegram-config/test` 已存在
- `/api/telegram/get-me` 已存在
- 未登录访问时返回 `401 Authentication required`
- 已经不再是 `404 Route not found`

这意味着：
- 接口缺失问题已经修掉
- 后续如果再失败，应优先检查管理员登录状态、Token/Chat ID 本身是否正确

2026-03-20 当日晚些时候补充定位：

- 数据库里保存的 `Bot Token` 和 `Chat ID` 是完整正确的
- 服务器直接用同一 token 调 Telegram `getMe` 成功
- 真正导致“测试连接”失败的后续原因，是 `nav-api` 容器里 `Node fetch` 对 Telegram `getMe` 的“空 JSON POST”调用异常
- 已修复为：
  - 无 payload 的 Telegram 方法走 `GET`
  - 有 payload 的方法继续走 `POST`

这次修复后，在同一服务器环境里再次验证：

- `getMe` 成功
- `getUpdates` 成功

### 4.2 AI provider 测试按钮已补齐

设置页现在已支持：

- ChatGPT / OpenAI-compatible 测试连接
- Brave Search API 测试连接
- OpenClaw 测试连接

后端接口：

- `POST /api/ai-search/providers/test`

当前线上验证结果：

- 路由已上线
- 未登录时返回 `401 Authentication required`
- 说明前后端链路已接通
- 下一步需要填入真实配置后做实际 provider 联调

## 5. 当前未完成项

### 5.1 高优先级

1. 真实联调 Telegram
- 使用管理员登录态
- 在设置页点击“测试连接”
- 确认真实 Bot Token + Chat ID 成功通过
- 确认保存、同步审批、测试连接三条链路都稳定

2. 真实联调 AI provider
- ChatGPT / OpenAI-compatible
- Brave Search
- OpenClaw

目标：
- 配置真实 endpoint / key / model
- 点击“测试连接”得到明确成功结果
- 在首页搜索框验证真实搜索结果面板

3. 清理中文乱码
- 目前部分旧组件和旧文档仍有乱码
- 重点优先：
  - 用户管理
  - 数据管理
  - 部分时光模块文案
  - 文档说明

### 5.2 中优先级

1. 浏览器扩展体验继续优化
- 更明确的登录态提示
- 添加成功后的反馈
- 失败原因提示更清楚

2. iPhone 快捷指令模板
- 补正式模板说明
- 把“快速添加当前页”方案写成可直接照着做的步骤

3. 搜索与 AI 体验优化
- 增加 provider 配置校验
- 明确区分“未启用 / 未保存 / Key 无效 / Endpoint 无效”

### 5.3 商业化后续

- 数据迁移策略
- 备份
- 审计日志
- 限流
- 多环境部署
- 客户买断版标准化部署文档

## 6.5 换电脑后如何继续协作

如果以后不用当前办公电脑，而是换到家里电脑继续让 Codex 接着做，推荐流程是：

1. 家里电脑先拉取最新仓库
2. 让新的 Codex 先阅读以下文件：
   - `D:/DomoCodex/projects/NAV/PROJECT.md`
   - `D:/DomoCodex/projects/NAV/STATUS_REPORT.md`
   - `D:/DomoCodex/projects/NAV/DEPLOYMENT.md`
   - `D:/DomoCodex/projects/NAV/BACKEND_PLAN.md`
3. 再让它查看当前工作区状态和线上环境
4. 然后直接按 `STATUS_REPORT.md` 里“下一步推荐执行顺序”继续

关键点：

- Codex 不会自动继承这次对话记忆
- 但只要仓库代码和上面这几份文档是最新的，新的 Codex 就能很快恢复上下文
- 所以后续每次阶段性收口，都要优先更新 `STATUS_REPORT.md`

## 7. 下一步推荐执行顺序

### 第一组：先收口当前链路

1. 真实测试 Telegram 配置
2. 真实测试 ChatGPT / Brave / OpenClaw
3. 修完失败提示与输入校验

实现效果：
- 设置页里的所有“测试连接”都能真实可用
- 后台接入状态更清晰
- 下一步接 AI 搜索时不会反复被配置问题卡住

### 第二组：清理用户可见体验

1. 清理中文乱码
2. 优化扩展提示
3. 优化 iPhone 快速添加说明

实现效果：
- 页面更适合演示和对外使用
- 用户不容易被乱码和模糊提示困住

### 第三组：继续商业化准备

1. 备份与审计
2. 部署与环境拆分
3. 客户自部署交付方案

## 8. 如果下次继续开发，建议直接从这里开始

下次进入项目后，按这个顺序继续：

1. 打开 [https://nav.skrskr.net/settings](https://nav.skrskr.net/settings)
2. 使用管理员账号登录
3. 在“Telegram 接入”里做一次真实测试连接
4. 在“搜索设置”里分别配置并测试：
   - ChatGPT / OpenAI-compatible
   - Brave Search
   - OpenClaw
5. 配置成功后，到首页做真实 AI 搜索验证
6. 然后开始清理乱码和扩展体验

## 9. 关键文件

### 后端

- `D:/DomoCodex/projects/NAV/api/src/routes/auth.js`
- `D:/DomoCodex/projects/NAV/api/src/routes/adminTelegram.js`
- `D:/DomoCodex/projects/NAV/api/src/routes/aiSearch.js`
- `D:/DomoCodex/projects/NAV/api/src/routes/navigation.js`
- `D:/DomoCodex/projects/NAV/api/src/routes/notes.js`
- `D:/DomoCodex/projects/NAV/api/src/routes/settings.js`
- `D:/DomoCodex/projects/NAV/api/src/bootstrap.js`
- `D:/DomoCodex/projects/NAV/api/src/config.js`
- `D:/DomoCodex/projects/NAV/api/src/lib/telegram.js`

### 前端

- `D:/DomoCodex/projects/NAV/app/.env.production`
- `D:/DomoCodex/projects/NAV/app/src/shared/composables/useConfig.js`
- `D:/DomoCodex/projects/NAV/app/src/shared/components/SearchBox.vue`
- `D:/DomoCodex/projects/NAV/app/src/modules/settings/components/SearchSettings.vue`
- `D:/DomoCodex/projects/NAV/app/src/modules/settings/components/UserManagementSettings.vue`
- `D:/DomoCodex/projects/NAV/app/src/modules/settings/components/BrowserIntegrationSettings.vue`
- `D:/DomoCodex/projects/NAV/app/src/modules/navigation/QuickAddView.vue`
- `D:/DomoCodex/projects/NAV/app/src/router/index.js`

### 浏览器扩展

- `D:/DomoCodex/projects/NAV/extension/manifest.json`
- `D:/DomoCodex/projects/NAV/extension/background.js`
- `D:/DomoCodex/projects/NAV/extension/popup.js`
- `D:/DomoCodex/projects/NAV/extension/options.js`
