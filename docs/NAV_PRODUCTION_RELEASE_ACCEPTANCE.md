# NAV 生产发布登录态验收

## 当前状态

- 一次性管理员生命周期工具已通过 PR #33/#34 进入生产 SHA
  `25c9c133ad6c34b857cf13c293aa5a89c8ef04d7`。首次生产执行为
  `status=PASS / cleanup=PASS`；验收后临时账号、marker 与
  `/run/nav-release-acceptance.*` 私有目录均为 0，真实管理员未被读取或修改。
- 工具只用于锁定 merge SHA 的候选 API 与 release；它不是认证旁路，也不会新增公开 API。
- 一次性管理员 marker 为 v3，固定 30 分钟过期；验收命令最长 20 分钟。登录和已有 Session
  都按 marker key、用户名与 UUID 精确校验，过期、缺失或损坏时一律拒绝认证。
- 验收地址允许 PostgreSQL `inet` 返回 host-only CIDR 表示；IPv4 只能是 `/32`，IPv6 只能是
  `/128`，解析后再做精确地址比较。更宽网段、畸形 CIDR 或地址不一致仍失败关闭。
- 生产发布仍须单独取得授权，并继续执行发布前备份、隔离恢复、受控切换、双域验收、
  发布后备份与隔离恢复。

入口：

- `scripts/release/nav-with-ephemeral-admin.sh`
- `api/src/ops/releaseAcceptanceAccount.js`
- `api/src/ops/releaseAcceptanceAccountCli.js`

## 为什么不再使用固定验收密码

真实管理员可能在两次发布之间修改密码。把旧密码复制到 release 会导致登录验收误判失败，
也会在服务器上留下不必要的长期明文。一次性账号把发布验收与真实账号解耦：随机账号只在
验收窗口存在，验收成功、失败或收到常规终止信号时都进入同一清理路径。

工具不会读取、覆盖或恢复 `nav-admin-username`、`nav-admin-password` 等真实管理员文件。
明文随机密码只保存在内存文件系统 `/run/nav-release-acceptance.*` 的 `0700` 临时目录中，
用户名和密码文件为 `0600`；release 内只持久化不含密码的 run ID、随机用户名和 UUID 状态。
这样项目目录或 restic 备份不会收录明文验收密码。验收命令只收到文件路径，不收到明文
环境变量。

## 使用方式

候选 API 镜像必须包含本仓库的 CLI，并以精确 merge SHA 构建：

```bash
docker build \
  --build-arg NAV_RELEASE_SHA=<40-hex-merge-sha> \
  -t nav-api:<40-hex-merge-sha> api
```

镜像内置健康检查及 `org.opencontainers.image.revision` 标签。release 目录名必须以同一
SHA 的前 7 位结尾；`evidence` 目录必须预先存在且不可组/全局写，证据文件不得已存在：

```bash
scripts/release/nav-with-ephemeral-admin.sh \
  --release-dir /opt/nav-stack/releases/<release> \
  --api-container <candidate-api-container> \
  --database-container nav-postgres \
  --database-name nav \
  --database-user nav \
  --expected-release-sha <40-hex-merge-sha> \
  --timeout-seconds 900 \
  --client-ip <验收请求在 NAV 审计中看到的真实出口 IP> \
  --evidence-file /opt/nav-stack/releases/<release>/evidence/ACCEPTANCE_ACCOUNT_LIFECYCLE.txt \
  -- \
  /opt/nav-stack/releases/<release>/accept-release.sh all
```

被包装的验收脚本从文件读取凭据：

```bash
test "${NAV_ACCEPTANCE_EPHEMERAL:-}" = true
username="$(<"$NAV_ACCEPTANCE_USERNAME_FILE")"
password="$(<"$NAV_ACCEPTANCE_PASSWORD_FILE")"
```

不要把密码放入 argv、子进程环境值、日志、证据或命令追踪；不要使用 `eval`。构造登录 JSON
时直接从上述文件读取，并把临时 JSON 保存在同一私有运行目录或权限为 `0700` 的 `mktemp`
目录中。

## 生命周期与清理

1. 按固定顺序非阻塞取得主机全局 `/run/lock/nav-release.lock`，再取得不可改名的 canonical
   `/run/lock/nav-backup.lock`；两把锁都持有到账号清理和证据落盘完成。备份流程不得反向取得
   release 锁，也不得嵌套在验收命令内；两个脚本都会拒绝其他备份锁路径。
2. 校验候选 API 为 `healthy`、镜像 revision 与 merge SHA 精确相同，并用数据库名、OID、
   PostgreSQL 16 版本及容器网络地址证明它连接到指定生产 PostgreSQL 容器。
3. 检查数据库中不存在旧的一次性账号或 marker。
4. 生成 48 位十六进制 run ID、随机用户名和至少 384 bit 的随机密码。
5. 在数据库事务中取得 advisory lock，创建 `approved/admin` 账号，并在 `system_settings` 写入
   与 run ID、精确用户名、精确 UUID、验收 IP 和数据库时间计算的 30 分钟 `expiresAt` 绑定
   的 v3 临时 marker；旧 v2 marker 只能被精确清理，不能继续登录。
6. 在 30–1200 秒的显式上限内执行传入的双域登录态验收命令；超时先向独立验收进程组发送
   `TERM`，5 秒后仍未退出则发送 `KILL`。
7. `EXIT`、只发送给 wrapper 的 `HUP`、`INT`、`TERM` 都会转发到独立验收进程组，等待其
   有界结束后再进入清理：按 marker 精确锁定账号，删除它的合成审计、
   可精确归属的用户专属限流桶和用户；会话及用户数据由外键级联删除；随后删除 marker 和
   凭据目录。
8. 只有验收命令退出为 0 且清理成功，证据才写入 `status=PASS`。数据库清理失败只保留
   release 内不含密码的 marker 状态用于精确恢复；`/run` 凭据目录无论成功失败都删除，
   并令整个流程失败。

工具只删除一次性用户专属的 `authenticated_write`、`ai_requests`、仍可由现存会话精确
定位的 `data_restore` 及“随机用户名 + 明确验收客户端 IP”的身份登录桶。每个真正发起登录
的出口地址都必须通过重复的 `--client-ip` 传入；纯客户端 IP 登录桶可能与真实用户共享，
必须按既有窗口自然过期，不能为了“清理干净”而误删并发真实流量。

API 启动时会先同步扫描最多 8 个 marker，之后每 60 秒执行一次不重叠的有界恢复。只有
marker key、run ID、用户名和 UUID 全部一致且已经过期时才删除；事务使用 5 秒 lock timeout
和 15 秒 statement timeout。损坏或归属不明的 marker 只拒绝认证并记录运维错误，不做前缀
批量删除。一次性账号也不能通过账号设置修改用户名来逃逸精确清理。

canonical `scripts/nav-backup.sh` 还有独立数据库门禁：它在 exported snapshot 事务中取得同名
advisory lock，再检查 marker 和用户名两类 residue 均为 0，之后才允许 `pg_dump`。因此即使
wrapper 遭 `SIGKILL`、主机掉电后 flock 自动释放，遗留账号仍不能进入可恢复备份。发布前和
发布后备份必须统一走这个入口；不得继续生成绕过门禁的直接 `pg_dump` 脚本。

## 异常边界

Shell trap 无法处理 `SIGKILL`、内核崩溃或主机掉电。因此数据库 marker、服务端过期认证
门禁、API 恢复器与 release 私有状态文件共同构成兜底。账号最迟在数据库 `expiresAt` 到达时
失去登录和 Session 权限，正常 API 会在下一次 60 秒扫描内精确清理；下次 wrapper 运行取得
主机锁后，也会先用同一 run ID 请求精确清理。marker 缺失但仍存在
`nav_release_accept_` 前缀账号时会失败关闭，要求人工核对，不会执行前缀批量删除。

如果清理失败：

- 不得继续切换、写入 PASS 或生成发布后最终备份；canonical 备份门禁也会主动拒绝 residue；
- 保留 release、数据库备份和不含密码的 marker 状态；确认 `/run` 凭据目录已删除；
- 只读核对 marker、精确 UUID、账号、会话和审计数量；
- 修复原因后重新运行同一 release 的精确清理，不得手工使用宽条件删除。

## CI 门禁

GitHub Actions 的 `release-acceptance-postgres-integration` 使用独立 PostgreSQL 16 数据库，
只有同时满足 `NODE_ENV=test`、显式开关、localhost 和精确数据库名时才会清理测试数据。
它验证：

- 一次性管理员与 marker 在同一事务建立；
- 已有 residue 时拒绝创建或谎报 clean；
- marker 的用户名/UUID 不匹配时拒绝删除；
- 用户、会话、actor/subject 审计和用户专属限流桶被精确清理；
- 真实账号、真实会话、真实审计和共享 IP 桶保持不变；
- 注入清理失败时整个事务回滚；
- 并发创建只允许一个成功；
- 有效账号可登录但不能改名，过期后新登录与已有 Session 均失效，恢复器只删除精确账号并
  保留真实用户。

同一 CI job 还真实执行 canonical `scripts/nav-backup.sh`，覆盖 clean exported snapshot、
marker residue、前缀用户 residue，以及 provision 事务持有 advisory lock 时备份等待且不得
提前进入 `pg_dump`；这些不是源码字符串断言。

Shell 行为测试在隔离 CI 中以 root + stub Docker 实际覆盖：验收成功、验收失败、清理失败、
只向 wrapper PID 发送 `TERM` 后的子进程转发与清理、密码不进入输出/证据、非 canonical
锁路径拒绝和两把锁互斥。它有 `CI=true` 和显式测试开关双门禁，不能在生产主机作为普通
脚本运行。

普通 API 测试另外检查 Shell 的 `umask`、锁、trap、文件路径传递、禁止覆盖真实管理员
Secret、禁止 `eval` 和证据脱敏。所有 Shell 脚本在发布包生成与 CI 中还应执行 `bash -n`。

## 最终发布门禁

最终验收和发布后备份前必须同时确认：

- 一次性账号数量为 0；
- 一次性账号 marker 数量为 0；
- `/run/nav-release-acceptance.*` 私有凭据目录不存在；
- canonical backup lock 已由 wrapper 释放，随后运行的备份通过 snapshot residue 门禁；
- 生命周期证据为 `status=PASS` 且 `cleanup=PASS`；
- 真实管理员账号、会话与数据未被修改；
- 双域 Cookie、Session、管理员只读接口、AI、图库、CORS 和退出仍通过；
- API/Web/数据库及受保护服务健康，容器重启计数符合发布门禁。

证据不得包含用户名、密码、密码哈希、Cookie、Token、登录 JSON、真实 `.env` 或响应正文。
