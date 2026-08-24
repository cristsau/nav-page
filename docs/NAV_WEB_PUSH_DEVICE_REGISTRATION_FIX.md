# NAV Web Push 当前设备登记修复

更新时间：2026-08-24
状态：`LOCAL_DONE / READY_FOR_CI / NOT_DEPLOYED`

## 用户可见问题

在设置页点击“启用当前设备”后，浏览器显示 `Notification.permission=granted`，但“发送测试通知”
仍为灰色。

## 已确认原因边界

- `granted` 只表示浏览器系统通知权限已允许，不表示 Push subscription 已创建或已写入 NAV。
- 2026-08-24 只读检查生产 `web_push_subscriptions` 为 `0` 行，因此当前设备没有完成服务器登记。
- 旧界面仅按“是否存在任意活跃订阅”控制测试按钮，没有分别显示系统权限、浏览器订阅和服务器
  登记状态；错误提示位于卡片底部，容易形成“已经启用”的误解。
- Edge 官方流程同样要求权限、`PushManager.subscribe()`、服务端登记和 Service Worker 展示四个
  独立步骤。当前证据不足以断定订阅失败来自 InPrivate、浏览器 Push 服务网络还是服务器校验；
  修复版会在不暴露 endpoint token 的前提下显示失败步骤和 Push 服务主机名。

## 本地修复

- 当前设备状态拆为“系统权限、浏览器订阅、服务器登记”三步。
- 权限已经为 `granted`、后两步未完成时，按钮改为“继续完成启用”。
- 订阅登记成功后立即向该精确 subscription ID 发送首次测试通知，不再等待用户猜测按钮状态。
- 测试按钮只绑定当前设备的活跃订阅，不会在本地 ID 丢失时回退到其他设备。
- 显示 Service Worker、浏览器订阅、服务器登记或测试投递的分步错误；地址/token 会被隐藏。
- 设备列表标记“当前设备”，测试成功后刷新最近成功时间。

## 验证

- `node --check`：`webPushApi.js`、`webPushState.js` 通过。
- Vue `<script setup>` 使用 Node VM 模块语法解析通过。
- `api/test/webPushDeviceState.test.js`：4 项通过、0 失败。
- `git diff --check`：通过。
- 未运行本地 npm、Vite 或生产构建；完整依赖与构建应由 GitHub Linux CI 完成。

## 上线门禁

1. 推送独立分支并让 GitHub 全量 CI（含 PostgreSQL 16）通过。
2. 发布前 canonical 备份和隔离恢复通过。
3. 只重建 `nav-web`；若 API 无变化，不重建 `nav-api`、PostgreSQL、CLIProxyAPI、NPM 或其他服务。
4. 双域登录态中完成普通 Edge/Chrome 窗口的三步状态、自动测试通知、刷新持久化和页面关闭后
   到达验收。

## 明确未完成

- 本分支尚未推送、创建 PR、合并或发布生产。
- 真实设备 Push 到达仍需用户浏览器完成；自动化不能代替系统权限与真机通知中心验收。
