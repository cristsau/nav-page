# NAV 邮件工作区生产验收脚本

状态：仓库级发布工具；必须由一次性管理员生命周期包装器调用。

推荐入口：`scripts/release/prepare-mail-fixture-and-accept.sh`

底层验收：`scripts/release/accept-mail-workspace.sh`

## 验收边界

脚本只验证 NAV 自己的登录态、邮件只读工作区、通知规则、邮件 AI 与本地加密草稿。
它不会发送真实邮件，也不会在 IMAP 服务端执行已读、星标、移动、删除或其他远端邮箱修改。
成功证据固定包含：

```text
real_mail_send=NOT_INVOKED
remote_mailbox_mutation=NOT_INVOKED
```

脚本使用 `curl`、独立 Cookie jar 和 `jq` 完成两个 HTTPS 域名的登录、Session 与 API
契约检查。响应正文、Cookie、用户名和密码都只存在于 `/run/nav-mail-acceptance.*` 的
`0700` 临时目录，不进入 stdout、证据或 release。登录 JSON 由 `jq --rawfile` 直接读取
包装器提供的凭据文件路径；密码不会出现在 argv 或环境值中。

## 合成邮件是硬前置：受限编排

一次性管理员是在 `nav-with-ephemeral-admin.sh` 取得锁后才创建的。邮件账号、文件夹和邮件
又都按用户强隔离，因此合成邮件必须由同一生命周期内的受控夹具为该一次性用户建立。
`prepare-mail-fixture-and-accept.sh` 会通过候选 API 容器内的
`src/ops/mailAcceptanceFixtureCli.js` 完成这个前置条件，再调用底层验收。

CLI 只从 stdin 接收当前 run id、一次性用户名和非秘密标记，并在事务中重新验证
`release_acceptance_account:<run-id>` 标记、用户 ID、管理员状态与有效期。它复用候选 API
已有的邮件 AES-256-GCM 密钥和 mailbox AAD 上下文，只向本地 PostgreSQL 插入唯一的临时
account、folder、canonical message 和 location。它不连接 IMAP/SMTP，不调用 worker，
不创建 email event 或 outbox，也不发送 `pg_notify`。发件人与收件人使用保留的
`invalid.example` 域名，不可能成为真实投递目标。

调用本脚本前，夹具准备器必须提供：

- 一个属于当前一次性用户的启用邮箱账号；
- 一个已完成初次同步、属于该账号的可选文件夹；
- 一封属于该文件夹的合成邮件；
- 唯一验收标记必须原样出现在该邮件主题或正文中；
- 合成邮件必须有发件地址和稳定的 64 位会话键，以便验证 AI 回复草稿及会话通知规则；
- 该会话不得预先存在通知规则；
- 候选 API 必须已经有可用的服务端 AI 配置。

编排器通过 `jq --rawfile` 读取一次性用户名文件；它不读取密码内容。CLI 返回的非秘密
UUID/标记只保存在 `/run/nav-mail-fixture.*` 的 `0700` 临时目录，并作为环境参数传给底层
验收，不进入 stdout。无论验收成功或失败，编排器都会用 run id、用户名、四个 UUID、
source key、folder path 与 canonical hash 做精确所有权核对，再删除该临时 account 及其
级联数据。异常、身份不一致、残留或重复 prepare/cleanup 均失败关闭；包装器最终删除整个
一次性用户仍是 SIGKILL/主机故障后的兜底。

如果夹具尚未准备，必须显式设置：

```bash
NAV_MAIL_ACCEPTANCE_FIXTURE_MODE=skip
```

脚本会输出 `status=SKIP` 并返回 `77`。包装器因此不会写出 PASS。这只是可审计的缺少前置
条件，不是成功验收。

## 编排器必填环境变量

| 变量 | 含义 |
| --- | --- |
| `NAV_MAIL_ACCEPTANCE_PRIMARY_BASE_URL` | 主 HTTPS origin，例如 `https://nav.example.test`，不得带路径 |
| `NAV_MAIL_ACCEPTANCE_SECONDARY_BASE_URL` | 第二 HTTPS origin，必须与主域不同 |

包装器自动提供并由编排器、底层验收共同校验：

- `NAV_ACCEPTANCE_EPHEMERAL=true`
- `NAV_ACCEPTANCE_USERNAME_FILE`
- `NAV_ACCEPTANCE_PASSWORD_FILE`
- `NAV_ACCEPTANCE_RUN_ID`
- `NAV_ACCEPTANCE_API_CONTAINER`
- `NAV_ACCEPTANCE_DATABASE_CONTAINER`
- `NAV_ACCEPTANCE_DATABASE_NAME`
- `NAV_ACCEPTANCE_DATABASE_USER`

编排器固定派生 `navmail.<run-id>` 标记，并把临时 account/folder/message UUID 与数据库目标
映射到底层 `NAV_MAIL_ACCEPTANCE_*` 环境变量。调用方不能用另一 run 的标记覆盖它。

可选的 `NAV_MAIL_ACCEPTANCE_HTTP_TIMEOUT_SECONDS` 范围为 5–120 秒，默认 30 秒。

## 包装器调用示例

下面只有占位符和非秘密路由数据；不要把密码、Cookie、Token 或真实 `.env` 写入命令：

```bash
env \
  NAV_MAIL_ACCEPTANCE_PRIMARY_BASE_URL=<primary-origin> \
  NAV_MAIL_ACCEPTANCE_SECONDARY_BASE_URL=<secondary-origin> \
  scripts/release/nav-with-ephemeral-admin.sh \
  --release-dir /opt/nav-stack/releases/<release> \
  --api-container <candidate-api-container> \
  --database-container <postgres-container> \
  --database-name <database-name> \
  --database-user <database-user> \
  --expected-release-sha <40-hex-merge-sha> \
  --timeout-seconds 900 \
  --client-ip <acceptance-egress-ip> \
  --evidence-file /opt/nav-stack/releases/<release>/evidence/MAIL_WORKSPACE_ACCEPTANCE_ACCOUNT.txt \
  -- \
  /opt/nav-stack/releases/<release>/prepare-mail-fixture-and-accept.sh
```

生产发布应调用编排器取得真实 PASS/FAIL；底层脚本的 `skip` 模式只用于记录缺少夹具的
明确前置阻塞，不构成验收成功。

编排器最终运行底层验收的命令形态：

```bash
env \
  NAV_MAIL_ACCEPTANCE_FIXTURE_MODE=required \
  NAV_MAIL_ACCEPTANCE_PRIMARY_BASE_URL=<primary-origin> \
  NAV_MAIL_ACCEPTANCE_SECONDARY_BASE_URL=<secondary-origin> \
  NAV_MAIL_ACCEPTANCE_MARKER=navmail.<run-id> \
  NAV_MAIL_ACCEPTANCE_ACCOUNT_ID=<account-uuid> \
  NAV_MAIL_ACCEPTANCE_FOLDER_ID=<folder-uuid> \
  NAV_MAIL_ACCEPTANCE_MESSAGE_ID=<canonical-message-uuid> \
  NAV_MAIL_ACCEPTANCE_DATABASE_CONTAINER=<postgres-container> \
  NAV_MAIL_ACCEPTANCE_DATABASE_NAME=<database-name> \
  NAV_MAIL_ACCEPTANCE_DATABASE_USER=<database-user> \
  scripts/release/accept-mail-workspace.sh
```

## 检查顺序

1. 确认包装器标记、凭据文件、依赖、HTTPS origins、UUID 和数据库目标参数安全。
2. 受限 CLI 验证一次性用户标记并事务创建本地 AES-GCM 合成邮件夹具，证明 outbox 为零。
3. 分别登录两个域名并验证 `/api/auth/session` 返回同一个一次性用户。
4. 记录该一次性用户的 `mail_outbox` 数量。
5. 读取邮件列表和详情；用唯一标记验证服务端 `q` 搜索；通过第二域验证 `unread` 过滤。
6. 对合成会话执行通知规则 preview、create、跨域 list、patch 和 delete；若已有同身份规则则
   失败，绝不覆盖后再删除未知数据。
7. 执行邮件 AI summarize，并要求来源中包含合成邮件。
8. 调用 `/api/email/ai/search` 的 `answer=false` 来源模式，要求返回合成邮件来源；该步骤不制造
   第二次模型回答。
9. 生成 `create_draft` AI 提议，使用原样 token/参数显式 confirm；读取 PostgreSQL 只验证
   `payload_encrypted`、`content_hash`、`status=draft` 与 `outbox_id IS NULL`。
10. 以 `draft id + ephemeral user id + status=draft + outbox_id IS NULL` 精确删除该临时草稿。
   任一条件不匹配都失败关闭。包装器最终删除一次性用户时仍会通过外键清理其操作记录。
11. 再次记录该用户的 `mail_outbox` 数量，要求与开始时完全一致，然后双域退出。
12. 编排器核对精确 fixture 身份、outbox 仍为零并删除临时 account；包装器再清理一次性用户。

任何 HTTP、JSON、所有权、密文、清理、outbox 不变式或退出检查失败都返回非零。`EXIT`
清理会尽力删除本轮精确创建的规则和草稿并退出两个域；清理失败会把最终状态提升为失败。

## CI 门禁

- GitHub Linux CI 对底层验收与夹具编排脚本执行 `bash -n` 和
  `shellcheck --severity=warning`。
- `api/test/mailAcceptanceFixture.test.js` 单元验证 run/user/marker 绑定、现有 mailbox AES-GCM
  上下文、四表插入、outbox/event/notify 禁止项、精确 account 删除和 secret-safe stdin 编排。
- `api/test/mailWorkspaceAcceptanceTooling.test.js` 静态验证包装器门禁、凭据文件读取、双域
  Cookie jar、所需 API、outbox 前后不变、精确临时草稿清理、SKIP 非零，以及禁止真实发送
  和远端邮箱修改入口。
- 静态检查不等于生产验收；发布必须由一次性用户编排器创建真实夹具并取得底层 PASS。
