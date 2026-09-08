# DOMO NAV 发布记录：安全加固与个人邮箱下线

最后核验：2026-09-07 14:31 +08:00。
状态：`DEPLOYED / CORE_ACCEPTANCE_PASS / PHYSICAL_DEVICE_ACCEPTANCE_PENDING`。
本文件为发布后的本地台账；应用运行代码固定为下列 merge SHA，不把台账本身冒充运行镜像内容。

## 已发布版本

| 项目 | 已验证值 |
| --- | --- |
| PR | [cristsau/nav-page #69](https://github.com/cristsau/nav-page/pull/69)，已合并 |
| 精确 merge SHA | `b2ae02360d7837f0b5c21daaaa855d986b600b2b` |
| CI | [master run 34088401099](https://github.com/cristsau/nav-page/actions/runs/34088401099)，11/11 作业通过 |
| 线上 current | `/opt/nav-stack/releases/20260907-140500-b2ae023` |
| 线上 rollback | `/opt/nav-stack/releases/20260903-160400-94543f6` |
| API 镜像 | `nav-ovh-api:b2ae02360d7837f0b5c21daaaa855d986b600b2b` |
| API image ID | `sha256:e303c5dafef0a0eef1f4ae65be4e57aaca7e57dd62f18ccf3bd8a50f477bd916` |
| 前端 | 同一 merge SHA 的 GitHub CI frontend-dist 产物，哈希核对通过 |
| 发布完成 | 2026-09-07 14:27 +08:00 |

## 实施范围

- 个人邮箱入口、收件、分类、摘要、邮件通知和邮件 AI 操作退役。旧邮件接口返回 HTTP 410 / `MAILBOX_RETIRED`。
- 精确旧容器 `nav_ovh_candidate-nav-mail-worker-1` 已手动停止，restart policy 为 `unless-stopped`；保留原容器及镜像供回滚，不再纳入当前部署和备份运行服务列表。
- 仅重建 `nav-api`、`nav-web`。PostgreSQL、CLIProxy、NPM、Vaultwarden、Komari 的容器 ID、启动时间、重启次数和挂载实测不变。
- 未执行新迁移；启动前后 `schema_migrations` 精确匹配。未删除历史邮件、附件、数据库表、密钥、旧镜像、release 或备份。
- 保留导航、时光、媒体、非邮件 AI、账号安全、备忘录 Web Push 和注册/运维系统 SMTP。

## 备份和恢复

| 阶段 | canonical 备份 | 隔离验证 |
| --- | --- | --- |
| 发布前 | `/var/backups/nav/nav-20260907T055918Z-nogit` | PostgreSQL 16，表集/行数/迁移记录匹配，PASS |
| 发布后 | `/var/backups/nav/nav-20260907T062639Z-nogit` | PostgreSQL 16，表集/行数/迁移记录匹配，PASS |

配置基线和执行证据位于 `/opt/nav-stack/prechange/20260907-140000-b2ae023`，root-only。
仅调整 canonical 配置中的本次 source archive 引用和 NAV runtime/恢复服务名单，未更改 Secret 或其他应用路径。
两次恢复演练均在隔离的临时环境运行，没有恢复覆盖生产数据库或重建 PostgreSQL 容器。

## 生产验证

- 双域 HTTPS `/api/health` 200；API/Web 健康，运行镜像/前端均对应本次发布。
- 独立临时管理员双域登录成功，Cookie 具备 HttpOnly/Secure/SameSite=Lax；注销后会话为空。
- 导航分组、媒体列表、通知、系统集成和模型目录接口正常。
- 合成备忘录创建、读取、删除及删除后 404 复查通过；合成安全书签保存通过，`javascript:` URL 返回 400。
- 通知中心全部已读接口通过，退役邮件 API 在桌面和移动 User-Agent 下均返回 410。
- 两个域名分别调用实际 AI 流式助理创建指定日记，随后从笔记列表查到落库结果，非 mock/非只检查 HTTP 200。
- 验收专用管理员及其合成数据已由受控生命周期脚本清理，`cleanup=PASS`；没有读取或修改真实管理员口令。
- 系统 SMTP TLS/账号连接验证 PASS；未发送额外测试邮件，不能写作真实收件人已收到。
- 停止 worker 后发布窗口内 `email_events` 行数不变。
- Edge 无头浏览器检查双域 `/about`、`/privacy`、`/auth`，1440×1000 和 390×844 两种视口均通过：
  匿名可访问、正确页标题、登录页关于/隐私链接、无横向页面溢出、无 pageerror。移动视口不等于 iPhone 实机。

## 重试与容量约束

- 前两次切换的新 API/Web 均健康，但验收脚本把“今天的日期和时间”强制断言为专用 `clock` 模式；
  现有意图分类将该措辞归入通用问答，因此验收失败。两次均自动回滚到发布前 `94543f6`，临时账号清理通过。
- 已把专用时钟测试改为实际支持的“今天日期”，保留完整 AI 写入验收，并增加失败行号诊断。第三次发布全部门禁通过。
  未修改应用代码绕过门禁，也未把旧版对该措辞的意图分类改进声称为已修复。
- Docker 挂载顺序本身不稳定；保护性比对按 Destination 排序后比较实际内容，仍严格核对容器 ID/启动时间/挂载。
- GitHub API 镜像大产物下载长时间无进度后停止了本次下载。生产采用已核验的旧固定基础镜像层，
  离线剔除退役生产依赖并复制精确 merge SHA 全部源文件，完成 npm 依赖检查、源码 SHA256 清单、ONNX 导入及 API ready/close 检查。
  所有存续生产依赖版本/来源/完整性与旧锁文件相同。构建变体为 `capacity-layer-offline-prune`；
  不声称生产 image digest 与 CI 全新构建 digest 相同。
- 发布后根盘约 1.4G 可用、93% 已用，磁盘仍紧张。没有执行镜像/cache/备份清理，不声称已释放若干 GB。

## 原始证据

- 线上 `current/evidence/RELEASE_ACCEPTANCE.txt`：最终 PASS / SHA / 回滚 / 发布后备份。
- 线上 `current/evidence/ACCEPTANCE_ACCOUNT_LIFECYCLE.attempt3.txt`：账号生命周期及清理 PASS。
- 线上 `current/evidence/SMTP_CONNECTION.txt`：系统 SMTP 连接 PASS。
- `prechange/20260907-140000-b2ae023/pre-restore.log`、`post-restore.log`：隔离恢复通过。
- 前两次失败/回滚记录作为历史保留；最终状态以当前指针及 `RELEASE_ACCEPTANCE.txt` 为准。
- 本地证据和脚本：`D:\DomoCodex\tmp-private\nav-release-20260907-b2ae023`。
  其中仅下载了选定的脱敏 PASS 文件；没有把生产配置、数据库备份或凭据下载进源码树。

## 尚未完成

- 所有者桌面/iPhone 实际使用，以及备忘录 Web Push 通知实收；未操作用户手机，未冒充实机验收。
- Google Client ID/Secret 配置、账号绑定与双域实际 OAuth 同意流程。品牌验证通过不等于登录已启用；
  使用 [Google 登录配置手册](./NAV_GOOGLE_LOGIN_SETUP.md)，Secret 仅由所有者在安全入口输入。
- 官方浏览器扩展精确 Origin ID 白名单验收；没有安装 ID 证据时保持拒绝未知扩展，不恢复通配放行。
- 磁盘清理必须先列出精确旧镜像/备份对象、保留策略与可释放量，再另行取得删除授权。
