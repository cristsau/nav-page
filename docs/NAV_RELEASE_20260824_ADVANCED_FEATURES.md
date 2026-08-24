# NAV 2026-08-24 高级功能生产发布记录

状态：`VERIFIED_LIVE`，真实设备通知为 `USER_ACTION_REQUIRED`

## 源码与 CI

- 功能 PR：[#37](https://github.com/cristsau/nav-page/pull/37)
- 功能 merge：`a9eff0d7888fd29f8888a503a336af86371c3b80`
- 加固 PR：[#38](https://github.com/cristsau/nav-page/pull/38)
- 当前 master：`788be84c766470d0dce845b282aa246286f77d67`
- 功能 merge CI：`32685311488`
- 最终 master CI：`32689782306`
- 两轮 master CI 的 `test-and-build`、`restore-postgres-integration`、
  `maintenance-postgres-integration`、`advanced-features-postgres-integration` 与
  `release-acceptance-postgres-integration` 均成功。
- 本机未运行 npm 测试或构建；完整依赖安装、审计、API 测试与 Vite 构建由 GitHub CI 和 OVH
  完成。

## 生产 release

- OVH release：`/opt/nav-stack/releases/20260824-031310-a9eff0d`
- API 镜像：`nav-ovh-api:a9eff0d7888fd29f8888a503a336af86371c3b80`
- 源码归档 SHA-256：
  `f97ea74b0d48d478c5d3983d4337ed23afe613628b1ae6a033af6a33d023e90d`
- 只重建 `nav-api` 与 `nav-web`。PostgreSQL、CLIProxyAPI、NPM、Vaultwarden、Komari 与其他
  非目标容器保持原容器，未因本次发布重建。
- PR #38 的 Service Worker no-cache 修复已同步到当前 release；恢复就绪修复已合并到 master。

## 数据与恢复

- 已执行迁移 `019_webauthn_passkeys.sql` 至 `025_block_editor.sql`。
- 发布前 canonical 备份完成 manifest 校验，并在隔离 PostgreSQL 16 恢复通过。
- 发布后 canonical 备份完成 manifest 校验，在隔离 PostgreSQL 16 恢复为 25 张表，并精确核对
  migration ledger 到 `025_block_editor.sql`。
- 本次发现 canonical 恢复脚本可能把临时初始化 postmaster 误认为最终 PostgreSQL；PR #38
  改为同时等待 `pg_isready` 与容器 PID 1 为 `postgres`。当前 release 已使用稳定门禁完成恢复
  证明；主机全局工具更新需要独立维护授权。
- 当前 release 的 `rollback-release.sh` 权限为 `0700 root:root`，固定目标为
  `/opt/nav-stack/releases/20260823-233024-25c9c13`，只重建 API/Web。迁移 `019` 至 `025`
  为加法迁移，应用回滚时保留；不得用旧整库覆盖发布后的用户写入。

## 功能验收

- 混合搜索：中文 BM25 与固定 revision 多语言向量均启用，生产返回 `searchMode=hybrid`、
  `semanticStatus=ready`，并找到一次性验收笔记。
- Web Push：VAPID 私钥仅为 release-local 只读 Secret，公钥可由认证页面读取；订阅、状态和
  测试接口通过。通知不包含加密笔记标题、正文、密码或密文。
- 块编辑器：一次性管理员完成富文本块笔记创建、版本历史和搜索验收，随后精确删除测试数据。
- PWA：`sw.js`、manifest、logo 与图标均可读；`index.html`/`sw.js`/manifest 为 no-cache，
  哈希资源为一年 immutable；Service Worker 包含 `push` 与 `notificationclick` 处理。
- 双域：首页、健康、CORS、登录 Session、退出与未认证 401 边界通过。
- 一次性管理员：`status=PASS / cleanup=PASS`；测试账号、marker、Session 与临时凭据均清零。

## 用户仍需完成

1. Chrome/Edge：设置 → 浏览器与手机 → 启用通知并允许权限，再发送测试通知。
2. iPhone/iPad：先把 NAV 添加到主屏幕，从主屏幕图标打开，再启用通知并发送测试通知。
3. Passkey 已有源码与迁移，但默认关闭；启用前需独立备份、开关和真实设备注册/登录验收。
4. 异地存储等待用户选定免费供应商后填写 Secret；本次没有配置或猜测凭据。
5. Chrome Web Store / Edge Add-ons 的账号、签名、提交和审核继续暂缓。

## 已知边界

- 当前块编辑器是完整的单用户 Notion 式编辑体验；多人协作、评论、Yjs/CRDT、数据库视图与
  Notion API 不在本批范围。
- 依赖审计仍有两个由 `onnxruntime-node`/`sharp` 上游链带来的、当前无上游修复的受控公告；
  CI 只允许这两个精确公告，任何新增公告都会失败。模型与 revision 固定，用户文件不会传入
  transformers 解析链。
- 真实设备通知到达尚未观察，不能把服务器链通过写成真机端到端已通过。
