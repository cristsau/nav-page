# NAV Dropbox：本机授权与备份适配候选

本页说明操作者本机授权。Linux 备份候选及其未完成门禁见 [BACKUP.md](./BACKUP.md)。
这不是 NAV 网页的“连接 Dropbox”功能；本地授权成功不等于备份上线。
无第三方依赖，Windows PowerShell 5.1 + Node.js 22 或更新。只在操作者当前电脑运行，
不要在生产机、WinRM 会话或公共电脑交互授权。不要把源码目录当作凭据存储。

## 控制台与执行

1. 创建 Scoped access / **App Folder** 应用。权限只保留 `account_info.read`、
   `files.metadata.read`、`files.content.read`、`files.content.write`，Submit 保存。
2. Settings → Redirect URIs 添加以下**完整地址**（路径、端口、末尾均须一致）：

   `http://127.0.0.1:53682/dropbox/callback`

3. Allow public clients 保持 Allow，供此 PKCE 本机客户端使用；代码固定 code + S256，
   不使用 Implicit Grant。不要生成控制台 Token，不需要 App secret。
4. 双击 `Connect-NavDropbox.cmd`，只输入 **App key（公开客户端编号）**，
   核对 App Folder 和回调地址后输入 YES。浏览器由本机打开，自己登录并同意授权。
5. 返回终端确认 Dropbox 返回的是自己的备份账号，再输入 YES。
   只报告状态 `LOCAL_AUTHORIZATION_SAVED`；不要发地址栏、授权码、凭据文件或 Token。

不会打开防火墙、创建系统服务或使用服务器回调。只监听 `127.0.0.1:53682`，
10 分钟无回调则退出；端口占用则拒绝，不杀其他进程、不自动换端口。
初次授权后调用一次 token refresh 和账号读取，验证离线续期路径与账号一致性；
没有 files API 调用，也没有 SSH、备份上传、远端删除或调度。

## 本机保管与后续

凭据只经进程 stdin 送给 Windows DPAPI CurrentUser 加密，存入
`%LOCALAPPDATA%\DomoCodex\NavDropboxOAuth\<AppKey>\connection.dpapi`。
该目录禁用 ACL 继承，仅当前用户与 SYSTEM；路径中的 junction/symlink 拒绝。
拒绝覆盖既有连接，拒绝 App Folder 以外权限集合（Folder 类型由控制台截图/操作者核对，
scope 本身不能证明 App Folder）；不保存 access token、用户邮箱或 App secret。
不要复制凭据到 Git、聊天、知识包或云端。DPAPI 绑定当前 Windows 用户，不是可移植恢复材料。

这个阶段**没有把凭据传到 OVH、没有启动备份，也没有改变 NAV 的登录集成**。
备份候选已有资源/5 GB/3 点限制；仍需受保护的服务器配置交接和 Linux 集成验收；
真实云下载、解密、隔离恢复通过后才允许启用定时备份。
App key 是应用编号，不等于 App secret；不要为了本助手申请全盘权限。

授权取消或本地保存失败时，不把结果当成功。如果已经在 Dropbox 点击过允许，
需要彻底断开时在 Dropbox 设置 → 已关联应用中撤销该应用；助手不自动撤销可能被其他客户端使用的授权。
已有连接不自动替换；先核实为何重连，再由受控操作处理。

## 验证范围

- `node --test oauth.test.mjs`：RFC 7636 向量、精确权限、随机 state、回调校验/重放/
  拒绝/超时、回环实测、模拟 token 交换/refresh/账号绑定、错误脱敏和 64 KiB 响应上限。
- `Test-LocalStore.ps1`：使用随机隔离目录和假凭据，验证重复预检、DPAPI 加解密、
  私有 ACL、拒绝覆盖；只清除此轮测试文件与空目录，不读取已有连接。必须在实际操作者的本机账户下运行。
- PowerShell AST 校验只是语法，不替代当前操作者账户下的 DPAPI 实测。
- Dev60 使用已有专用 WinRM 和 Node 24；不安装依赖、不启动真实 OAuth。
- 专用 WinRM 的临时虚拟账户不代表操作者本机身份；不要用它保管真实 OAuth 凭据。
- 用户授权与真实 API 验收单独记录，不能把合成测试当作已连通或备份已完成。

官方依据：
[OAuth 与最小权限](https://docs.dropboxapi.com/dropbox-api/docs/oauth)、
[Dropbox PKCE 示例](https://dropbox.tech/developers/pkce--what-and-why-)。
