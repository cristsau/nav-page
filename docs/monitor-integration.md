# Monitor 接入 NAV

本轮状态以 `CURRENT.md` 指向的唯一当前入口为准。以下新增契约覆盖旧的嵌入界面；下文为首次接入时的历史记录，不代表新版本部署状态。

## 2026-10-29 原生界面契约

NAV `/monitor` 统一提供资源、三网、资产和日常管理，移除原版管理按钮及 React 静态构建。旧 `/monitor-app/` 入口重定向到 `/monitor`。节点管理、通知、TCP 探测、数据库导出和整理经 owner-only `/api/monitor/admin/*` 固定路径访问；Hub 会话不交给浏览器，写操作不重放，并保存不含载荷的操作审计。主题市场、独立登录设置及整库恢复不在日常界面内。

三网新增 1h / 24h / 3d / 7d / 30d，图表按 1 分钟 / 1 分钟 / 5 分钟 / 15 分钟 / 1 小时展示。原始数据保留 3 天、5 分钟汇总保留 7 天、小时汇总保留 30 天。后台先汇总后清理，关闭网页仍持续采集；不回填尚未采集的历史。总览只拉最新快照，每 15 秒更新；详情按需加载，隐藏页面暂停刷新。

## 首次接入记录（历史）

## 使用方式与来源

- 日常进入 NAV 的“监控”页面（`/monitor`），可查看总览、历史指标和原版管理后台，不必另开 `node.cvv.gr`。
- `node.cvv.gr` 是 OVH 上 Hub 的独立 HTTPS/Agent 入口。Hub 与 NAV API 分容器运行，监控数据库独立，不迁移 NAV 数据库。
- Hub 原版：[monitor-probe/monitor v1.5.1](https://github.com/monitor-probe/monitor/tree/v1.5.1)，commit `da5c6667bfdf9494c2e1aa1e763c7d14f6544278`。Rust 服务端不修改。
- 默认主题：[monitor-theme-default v1.4.2](https://github.com/monitor-probe/monitor-theme-default/tree/v1.4.2)，commit `6cd1ed45601167ce44aad52d99df227785302f74`。两者保留 MIT LICENSE。
- 官方 amd64 Hub 制品 SHA-256：`5275d4cc6a01409428031453c6020629c1a7a6f5de5da44c555d1cccc4174d76`，已与 GitHub release asset digest 核对。下载未执行。

## 页面与认证契约

1. 原版 React 页面以 `NAV_MONITOR_EMBED=1` 构建，部署到 NAV 静态目录 `/monitor-app/`；后台在 `/monitor-app/admin/`。没有该构建参数时保留上游独立入口行为。
2. `/monitor-app/api/*` 经 nav-web 转发到 NAV `/api/monitor/proxy/*`。每个请求都检查 NAV 管理员及唯一绑定 owner；Hub 会话仅留在 NAV API 内存，不传给浏览器，也不把 NAV Cookie 转给 Hub。
3. NAV API 使用 `NAV_MANAGED_INTEGRATIONS_DIR/monitor.json` 中的服务端连接设置。字段为 `version:1`、`enabled:true`、`ownerUserId`、`upstream`、`site`、`password`。上游仅允许 `http://nav-monitor:28080` 或隔离测试用 `http://127.0.0.1:28080`，site 固定 `https://node.cvv.gr`。禁止把此私密文件加入仓库、日志、制品或知识包。
4. Linux 私密文件必须为 API 进程所有、权限 0600、单链接且非符号链接；目录不能允许其他用户写入。用运行时实际 UID/GID 创建文件，不改已有集成目录权限。
5. 代理允许固定原版 API 路径；不接受任意目标地址，不转发 Location/Set-Cookie，禁止重定向与写请求自动重放。最多 4 个并发请求，8 MiB 单次请求体，断开时取消上游，身份响应有大小上限。
6. 嵌入页节点列表每 5 秒读取，隐藏或离开页面停止刷新；Agent 上报仍用原版 WebSocket。NAV 登录失效时卸载页面。主题随 NAV 深浅色切换，未加载的监控代码不进入导航页首屏。

## 与原版的明确差别

- NAV 内复用 NAV 身份。原版独立应急凭据仅由服务器端保管；在 NAV 内隐藏原版登录设置，拒绝单独改写应急密码，避免两边凭据不同步。
- NAV 内总览固定为验证过的默认主题；管理后台安装或切换第三方主题，仅影响独立入口。不会把任意第三方主题脚本放进 NAV 同源页面。
- 可导出原版数据库备份；NAV 内不提供整体恢复。恢复会替换凭据，按用户要求留到最后的维护与恢复验收。
- 浏览器实时列表改为 5 秒轮询，不宣称与上游 WebSocket 的 2 秒推送完全相同。历史查询、节点/分组、流量/账期、探测任务、通知配置等保留原版接口。

## 发布候选与验收

- 先在 GitHub 独立候选分支执行 Linux 检查；原工作树和无关 dirty 文件保持原样。以目前生产版本为基线，仅取本轮明确文件，不直接发布整个 dirty 工作树。
- OVH 新增独立 Hub：初始资源预算 256 MiB、0.5 CPU，非 root、独立持久数据目录、无公开映射端口；接入现有代理网络，由 `node.cvv.gr` 提供 HTTPS/WSS。正式制品需固定镜像 digest 或使用已核对的二进制，禁止使用浮动 latest。
- 首次初始化必须私密捕获原版一次性口令，关闭初始化容器日志、无公网入口；将 public_page 设置为 off 后才接入公网。口令只落入受限连接文件，不显示在终端/部署日志。检查原版独立管理员登录与 NAV 登录桥接后才切换网页。
- NAV 发布前备份当前 API 镜像/发布目录、网页与 nginx 配置、离线队列私密状态；监控新目录单独保留。没有 NAV 数据库迁移。更新 API 和 nginx 可能造成几十秒请求失败。
- 预期接入 OVH、USPH、SJC 的只读监控 Agent，先单节点验证再逐个接入；没有离线任务迁移、USPH DNS 切换或 Dropbox 实际文件改动。安装 Agent 与更新 USPH 下载 worker 都需要本批明确发布授权，并在下载任务空闲后执行。
- 接入后验证两个 NAV 域名：匿名拒绝、owner 访问、注销/撤销会话、真实指标与 WSS 断线重连、节点管理、手机布局、资源峰值。验证离线节点状态和准备/取消换机；真正换机另做明确目标迁移，不为了验收随意切换已有任务。
- 任一步失败先恢复原 NAV API/网页/nginx，再停用新 Hub/Agent，保留新数据用于检查；只有本批新建 DNS 可独立撤回，不变更两个 NAV 域名及其他服务。

## 尚需解决的发布门槛

- Dev60 没有可用 Linux/WSL；当前 Vue/React、Node 和 HTTP 检查不等于真实 Linux Hub、Nginx、Agent 验收。
- 2026-10-28 17:24（北京时间）的既有重启已定位：收藏链接检查的同步 DNS lookup 回调引发 TLS 连接 ENETUNREACH 未处理错误，容器 exit 1 后重启；限定窗口的容器和内核日志没有 OOM 证据。候选将该回调改为异步，保留固定地址和错误拒绝，并补充真实 TLS 不可达回归。上线后仍需观察稳定性。
- 恢复演练保持延期，不能把模拟页面或 DNS 解析成功记为项目整体验收。
