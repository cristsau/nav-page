# DOMO NAV Status Report

最后更新：2026-07-31

> 退役说明（2026-07-31）：OpenClaw 服务已经删除，DOMO NAV 中对应的搜索入口、设置和后端执行链路不再保留。

> 发布状态（2026-07-31）：下述图片附件、iPhone 图标和 OpenClaw 清理目前是本地候选，尚未推送或发布到生产。

## 1. 当前目标

DOMO NAV 当前分成两个阶段目标：

### 测试版目标

- 让 [https://nav.skrskr.net](https://nav.skrskr.net) 成为可稳定访问、可演示、可日常使用的导航工作台
- 支持书签、便签、主题、搜索、注册审批、浏览器扩展快速添加

### 商业版目标

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
- 搜索
- 快速添加

### 3.3 时光 / 便签

- 备忘录 / 日记 CRUD
- 点击卡片预览
- 分享链接生成
- 公开分享页
- 图片附件上传、预览和分享页显示
- 图片由 NAV 后端代理上传到个人 CloudFlare-ImgBed，不落 NAV 本地磁盘
- 加密笔记禁止添加公开图床图片

### 3.4 设置

- 亮色 / 暗色 / 跟随系统
- 配色方案
- 自定义主题入口
- 网站名称 / 图标 / favicon
- 搜索引擎显示管理
- 数据导入导出
- 浏览器集成设置页
- “迁移本地数据到云端”仅在检测到旧 IndexedDB 数据时显示

关于“迁移本地数据到云端”：

- 这个功能仍然有价值
- 它不是给全新用户用的，而是给旧浏览器、旧设备、旧版本 DOMO NAV 用户用的
- 只要某台设备里还留着历史 IndexedDB 数据，就可以用它一次性导入 PostgreSQL
- 当确认所有历史设备都已迁移完毕后，再考虑移除

### 3.5 搜索与 AI

- 普通网页搜索引擎切换
- 首页快速切换引擎显示管理
- AI 搜索代理已接入：
  - ChatGPT / OpenAI-compatible
  - Brave Search API
- 首页搜索框已支持 AI 结果面板
- 设置页已支持 AI provider 配置
- 已新增 AI provider “测试连接”按钮

### 3.6 Telegram

- Telegram Bot Token / Chat ID 不再写死
- 每个管理员都可以填写自己的 Telegram 配置
- 支持 Telegram 审批同步
- 已修复旧前端资源请求旧 `/api/telegram/get-me` 导致 404 的兼容问题
- 已修复 `getMe` 调用方式，改成无 payload 时走 GET

### 3.7 浏览器集成

- 已新增 `/quick-add` 快速添加页
- 已完成浏览器扩展骨架
- 扩展支持：
  - 添加当前页到 DOMO NAV
  - 选择分组
  - 快速创建分组
  - 无分组时自动落默认分组
  - 右键菜单添加
- 已提供扩展下载包：
  - `/downloads/nav-extension.zip`
- 已提供安装说明：
  - `/downloads/nav-extension/README.html`
- 已新增 iPhone 快速添加方案入口

### 3.8 品牌与防剽窃标识

- 项目默认名称已从 `NAV` 升级为 `DOMO NAV`
- 设置页底部已加 `Design by CrisTsau`
- 首页底部已加品牌与署名
- 登录页已加署名
- 公开分享页已加署名
- 浏览器扩展已加默认品牌视觉与署名

## 4. 这次新增进展

### 4.1 扩展默认视觉已重做

- 扩展不再是空白表单
- 已内置默认品牌头像和品牌图块
- 弹窗、设置页、右键菜单文案已统一为 `DOMO NAV`
- 扩展可继续复用当前站点登录态

### 4.2 反代方案已确认方向

当前情况：

- 源站在 `150.230.212.137`
- 可访问域名是 `nav.skrskr.net`
- 你在 `45.143.234.47` 上装了 Nginx Proxy Manager，想给 `nav.cristsau.cn` 做反代

已确认现象：

- 直接访问 `https://nav.skrskr.net` 返回 `200`
- 直接访问 `https://nav.cristsau.cn` 当前返回 `502`
- 直接访问 `https://150.230.212.137` 会出现 TLS 安全通道错误

结论：

- 不能直接把上游写成裸 IP 的 HTTPS，因为证书不匹配
- 更稳的做法是让 NPM 反代到一个“仍然指向源站、且证书匹配的域名”

推荐做法：

1. `nav.cristsau.cn` 保持指向 `45.143.234.47`
2. NPM 里把上游写成：
   - Scheme: `https`
   - Forward Hostname: `nav.skrskr.net`
   - Forward Port: `443`
3. 打开 NPM 的：
   - `Websockets Support`
   - `Block Common Exploits`
4. 如果仍然 502，优先检查 NPM 是否开启了“校验证书 / SSL 重新协商”导致上游握手失败
5. 更理想的是再单独做一个只给源站用的域名，比如 `origin-nav.skrskr.net`，专供反代上游使用

扩展影响：

- 如果你继续对外使用 `nav.skrskr.net`，扩展不受影响
- 如果以后要主域名切到 `nav.cristsau.cn`，扩展里把 `NAV Base URL` 改成新域名即可
- 只要新域名完整转发 `/`、`/api`、`/downloads`、`/quick-add`，扩展、快速添加页和下载包都不会受影响

## 5. 当前未完成项

### 5.1 高优先级

1. 真实联调 Telegram
- 使用管理员登录
- 在设置页点击“测试连接”
- 确认真实 Bot Token + Chat ID 可稳定通过

2. 真实联调 AI provider
- ChatGPT / OpenAI-compatible
- Brave Search

目标：

- 配置真实 endpoint / key / model
- “测试连接”得到明确成功结果
- 首页搜索框能返回真实结果

3. 清理剩余中文乱码

重点优先：

- 用户管理
- 数据管理
- 部分时光模块文案
- 旧说明文档

### 5.2 中优先级

1. 浏览器扩展继续优化
- 更明确的登录态提示
- 添加成功后的反馈
- 失败原因提示更清楚

2. iPhone 快捷指令模板
- 补正式模板说明
- 把“快速添加当前页”写成可直接照做的步骤

3. 搜索与 AI 体验优化
- provider 配置校验
- 明确区分“未启用 / 未保存 / Key 无效 / Endpoint 无效”

### 5.3 商业化后续

- 备份
- 审计日志
- 限流
- 多环境部署
- 客户买断版标准化部署文档

## 6. 换电脑后如何继续协作

推荐流程：

1. 先拉取最新仓库
2. 让新的 Codex 先阅读：
   - `D:/DomoCodex/projects/NAV/PROJECT.md`
   - `D:/DomoCodex/projects/NAV/STATUS_REPORT.md`
   - `D:/DomoCodex/projects/NAV/DEPLOYMENT.md`
   - `D:/DomoCodex/projects/NAV/BACKEND_PLAN.md`
3. 再让它查看当前代码和线上环境

给新的 Codex 直接复制这句就够了：

```text
先 git pull origin master，然后阅读 PROJECT.md、STATUS_REPORT.md、DEPLOYMENT.md、BACKEND_PLAN.md，再查看当前代码和线上环境，按 STATUS_REPORT.md 里的下一步继续实施。
```

## 7. 下一步推荐执行顺序

### 第一组：先收口当前可用链路

1. 真实测试 Telegram 配置
2. 真实测试 ChatGPT / Brave
3. 修完失败提示与输入校验

实现效果：

- 设置页里的“测试连接”都真可用
- 后台接入状态更清楚
- AI 搜索链路能稳定演示

### 第二组：清理用户可见体验

1. 清理剩余中文乱码
2. 优化扩展提示
3. 优化 iPhone 快速添加说明

实现效果：

- 页面更适合演示和对外试用
- 用户不会被乱码和模糊提示困住

### 第三组：继续商业化准备

1. 备份与审计
2. 部署与环境拆分
3. 客户自部署交付方案

## 8. 关键文件

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
