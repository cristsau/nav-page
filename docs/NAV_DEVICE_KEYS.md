# 快捷登录：双域独立通行密钥

2026-09-08 用户授权 `nav.cristsau.cn` 与 `nav.skrskr.net` 同时开放新协议并与手机 UI 修复一起发布。实际发布状态以 [CURRENT](../CURRENT.md) 为准，不以本文代替上线证据。

## 使用

先在常用域名用现有账号登录，进入「设置 → 安全 → 快捷登录 → 添加通行密钥」，验证账号密码，再由系统确认 Face ID、Touch ID 或设备密码。DOMO NAV 不读取或保存人脸数据。登录页的快捷登录按钮由服务能力和浏览器平台验证能力共同决定。

两域是不同的 RP ID，各自登记、各自登录。账号数据不因此拆分或按昵称合并，但通行密钥与浏览器登录状态不跨域共享。每个页面只列出并允许移除当前域名的通行密钥；账号最多共10枚，达到上限时请在对应域名移除不用的密钥。

## 安全契约

- 只接受精确配对 `nav.skrskr.net / https://nav.skrskr.net` 与 `nav.cristsau.cn / https://nav.cristsau.cn`。不允许通配符、任意子域、HTTP、第三方域或一边Host配另一边Origin。
- 单个请求只选择一组 expectedOrigin/expectedRPID，而非把两个数组组合成任意可互换来源。登记、登录、列表与删除查询按该组隔离；证明Cookie保持host-only、HttpOnly、Secure、Strict和5分钟生命周期。
- 原密码复验、账号/会话绑定、一次性挑战、签名计数器、UV required、重放防护、账号状态及密码变更失效不变。无新增Google权限或外部身份合并。
- 使用现有 `NAV_DEVICE_KEYS_ENABLED`；旧 `/auth/passkeys` 仍退役，不启用旧开关。配置读取失败明确报错和重试，不隐藏整个设置卡片。
- 迁移050只将两张新协议表的检查约束扩为精确双域，保留原数据及主域默认值。迁移事务含5秒锁等待上限，不重写密码或现有会话。

依据：[SimpleWebAuthn服务端文档](https://simplewebauthn.dev/docs/packages/server)、[WebAuthn RP ID规范](https://www.w3.org/TR/webauthn-3/#rp-id)。

## 验证与发布门禁

- `api/test/deviceKeys.test.js`：双域真实签名、跨域证明/密钥/列表/删除隔离、恶意来源拒绝。
- `api/integration/authEmailPostgres.integration.js`：PG16真实约束、事务、双域登记/登录/级联撤销，不以SQL桩代替。
- `scripts/verify-settings-mobile-ui.mjs`：管理员全7分类、手机/桌面、深浅色、放大文字、明确能力状态。
- `scripts/verify-pwa-device-key-ui.mjs`：以 `NAV_DEVICE_UI_ORIGIN` 选择任一精确域名的虚拟验证器及PWA模拟。没有调用真实Provider或用户密码管理器。
- 发布需精确master CI产物、生产备份及隔离恢复、当前快照升级与上一版运行兼容验证。回退保留050数据，不降级或删除已登记的备用域密钥；旧版本的迁移清单检查不能当作新schema校验工具，应使用保留的新版本验证器只读核对。
- 线上技术检查和真人验收分开：两个域名的公开能力/RP、密码登录及会话、PWA Google配置、缺少人机证明拒绝、可视UI；真人iPhone再完成Face ID登记、取消、退出后快捷登录、移除、关闭重开。
