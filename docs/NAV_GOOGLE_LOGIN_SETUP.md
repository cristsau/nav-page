# DOMO NAV Google 登录配置手册

适用范围：DOMO NAV 的“使用 Google 账号登录”和账号绑定。它只使用
`openid`、`email`、`profile`，不读取 Gmail、Google Drive、联系人或日历。
2026-09-07 起个人邮箱退出产品主线；本地候选已移除邮箱 OAuth 配置入口，不要为登录添加 Gmail scope。

2026-09-07 本次匿名只读核实：两个生产域名的 `/api/auth/oauth/config` 均返回 Google `enabled=false`。
品牌验证已通过，但线上登录入口尚未启用；这不判断控制台中是否已创建 Client，仍需所有者核对并填写。

## 1. Google Auth Platform

### 品牌

保持以下公开页面：

- 应用名称：`DOMO NAV`
- 应用首页：`https://nav.cristsau.cn/about`
- 隐私政策：`https://nav.cristsau.cn/privacy`
- 已获授权的域名：`cristsau.cn`、`skrskr.net`
- 开发者联系邮箱：项目所有者当前使用的受控邮箱

品牌通过验证只说明名称、域名和公开页面通过了 Google 的检查；它不会自动创建 OAuth
客户端，也不会把 Client ID / Client Secret 写入 DOMO NAV。

### 目标对象

选择“外部”。正式供自己的常用 Google 账号登录时，将发布状态设为“生产中”。如果暂时
保持“测试”，必须把实际登录账号加入测试用户列表；测试与生产状态不要和 DOMO NAV
内部的注册审批混为一谈。

### 数据访问

只保留基础身份范围：

- `openid`
- `.../auth/userinfo.email`
- `.../auth/userinfo.profile`

不要添加 Gmail、Drive、Contacts、Calendar 或其他 Google API scope。

## 2. 创建 Web OAuth 客户端

进入“Google Auth Platform → 客户端 → 创建客户端”：

1. 应用类型选择“Web 应用”。
2. 名称建议填写 `DOMO NAV Web`。
3. “已获授权的重定向 URI”逐条填写，字符必须完全一致且结尾不能多 `/`：
   - `https://nav.skrskr.net/api/auth/oauth/google/callback`
   - `https://nav.cristsau.cn/api/auth/oauth/google/callback`
4. 当前 DOMO NAV 使用服务端 Authorization Code Flow，不需要“已获授权的 JavaScript
   来源”；保持为空即可。
5. 创建后立即安全保存 Client ID 和 Client Secret。Secret 不发到聊天、邮件，不写入
   Git、前端、镜像、截图或运行日志。

Google 控制台配置变更可能需要几分钟到数小时生效。出现 `redirect_uri_mismatch` 时，先逐字
核对协议、域名、路径、大小写和尾部斜杠，不要通过放宽回调地址来绕过。

## 3. 写入 DOMO NAV

以 DOMO NAV 管理员登录后进入：

`设置 → 登录与系统集成 → 外部账号登录`

本地候选发布前，生产旧版对应入口仍叫“邮件与云备份 → 身份登录与邮箱 OAuth”；只填写其中的身份登录区。

在上半区“Google OIDC / 微信开放平台”操作：

1. 勾选“启用 Google 登录”。
2. 填入 Client ID。
3. 填入 Client Secret。
4. 保持“允许 Google 已验证邮箱自动匹配……”关闭。
5. 点击“保存身份登录配置”。
6. 点击“检查结构 / 发现端点”。该检查只验证配置与可信端点，不代表真实登录已经成功。

保存后 Secret 不会回显；输入框显示“已安全保存，留空保持不变”是正常状态。

## 4. 先绑定，再登录

为避免 Google 邮箱被静默绑定到错误账号，推荐流程是：

1. 先用现有 DOMO NAV 用户名和密码登录。
2. 在账号安全设置中主动绑定 Google，并完成 Google 同意页。
3. 退出 DOMO NAV。
4. 在无痕窗口用“使用 Google 账号登录”回到同一个现有账号。

只有确实需要按邮箱自动匹配，并确认本地账号已审批、DOMO NAV 邮箱也已验证且唯一时，
才评估开启自动匹配。它不是首次配置的捷径。

## 5. 双域验收

分别在桌面无痕窗口和 iPhone Safari 验收：

- `https://nav.skrskr.net/auth`
- `https://nav.cristsau.cn/auth`

每个域名都应完成：登录按钮可见 → Google 同意 → 回到原发起域 → 显示同一 DOMO NAV
账号 → 退出成功。再验证取消授权、错误回调和未绑定账号不会绕过审批；现有密码、恢复码和
Passkey 登录仍应可用。

## 6. 常见错误

| 现象 | 优先检查 |
|---|---|
| 登录页没有 Google 按钮 | Google 登录是否启用，Client ID 与 Secret 是否已保存 |
| `redirect_uri_mismatch` | 两条回调是否逐字一致，是否误加尾部 `/` |
| 仅一个域名成功 | 失败域名对应的第二条回调是否遗漏，流程是否从该域名发起 |
| 提示账号未绑定 | 先密码登录后主动绑定；不要直接打开自动匹配 |
| `provider_failed` | Client ID/Secret 是否同属该 Web 客户端、Secret 是否已轮换、服务器时钟与外网是否正常 |
| 修改后仍是旧结果 | 等待 Google 配置传播后用无痕窗口重试 |

回退只需在 DOMO NAV 关闭 Google 登录开关；不要删除本地密码登录方式。若轮换 Secret，先
写入并验收新 Secret，再停用旧 Secret。

## 官方参考

- [Google：管理 OAuth 客户端](https://support.google.com/cloud/answer/15549257)
- [Google：OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [Google：Web 服务器 OAuth 流程](https://developers.google.com/identity/protocols/oauth2/web-server)
