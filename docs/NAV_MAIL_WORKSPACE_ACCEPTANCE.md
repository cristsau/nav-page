# NAV 邮件工作区生产验收脚本

状态：仓库级发布工具；必须由一次性管理员生命周期包装器调用。

入口：`scripts/release/accept-mail-workspace.sh`

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

## 合成邮件是硬前置，不由本脚本伪造

一次性管理员是在 `nav-with-ephemeral-admin.sh` 取得锁后才创建的。邮件账号、文件夹和邮件
又都按用户强隔离，因此合成邮件必须由同一生命周期内的受控夹具准备器为该一次性用户建立。
本脚本不携带生产数据库专用密钥，不负责生成或复制邮件密文，也不会借用真实管理员邮件。

调用本脚本前，夹具准备器必须提供：

- 一个属于当前一次性用户的启用邮箱账号；
- 一个已完成初次同步、属于该账号的可选文件夹；
- 一封属于该文件夹的合成邮件；
- 唯一验收标记必须原样出现在该邮件主题或正文中；
- 合成邮件必须有发件地址和稳定的 64 位会话键，以便验证 AI 回复草稿及会话通知规则；
- 该会话不得预先存在通知规则；
- 候选 API 必须已经有可用的服务端 AI 配置。

夹具准备器可作为包装器传入的验收编排命令：先读取一次性凭据文件完成用户定位和受控
夹具准备，再导出下面的非秘密 UUID/标记，最后 `exec` 本脚本。夹具准备器本身应有独立
测试、精确清理和生产授权；它不属于本脚本。

如果夹具尚未准备，必须显式设置：

```bash
NAV_MAIL_ACCEPTANCE_FIXTURE_MODE=skip
```

脚本会输出 `status=SKIP` 并返回 `77`。包装器因此不会写出 PASS。这只是可审计的缺少前置
条件，不是成功验收。

## 必填环境变量

| 变量 | 含义 |
| --- | --- |
| `NAV_MAIL_ACCEPTANCE_FIXTURE_MODE` | 正常验收固定为 `required`；无夹具时仅可显式设为 `skip` |
| `NAV_MAIL_ACCEPTANCE_PRIMARY_BASE_URL` | 主 HTTPS origin，例如 `https://nav.example.test`，不得带路径 |
| `NAV_MAIL_ACCEPTANCE_SECONDARY_BASE_URL` | 第二 HTTPS origin，必须与主域不同 |
| `NAV_MAIL_ACCEPTANCE_MARKER` | 8–120 字符的唯一合成邮件标记；仅允许 ASCII 字母、数字、`.`、`_`、`:`、`-` |
| `NAV_MAIL_ACCEPTANCE_ACCOUNT_ID` | 当前一次性用户的邮箱账号 UUID |
| `NAV_MAIL_ACCEPTANCE_FOLDER_ID` | 当前一次性用户的邮件文件夹 UUID |
| `NAV_MAIL_ACCEPTANCE_MESSAGE_ID` | 合成邮件的 canonical message UUID，不是 folder location UUID |
| `NAV_MAIL_ACCEPTANCE_DATABASE_CONTAINER` | PostgreSQL 容器名；仅用于只读计数、密文证明和精确临时草稿清理 |
| `NAV_MAIL_ACCEPTANCE_DATABASE_NAME` | PostgreSQL 数据库名 |
| `NAV_MAIL_ACCEPTANCE_DATABASE_USER` | PostgreSQL 用户名 |

包装器自动提供并由脚本校验：

- `NAV_ACCEPTANCE_EPHEMERAL=true`
- `NAV_ACCEPTANCE_USERNAME_FILE`
- `NAV_ACCEPTANCE_PASSWORD_FILE`
- `NAV_ACCEPTANCE_RUN_ID`

可选的 `NAV_MAIL_ACCEPTANCE_HTTP_TIMEOUT_SECONDS` 范围为 5–120 秒，默认 30 秒。

## 包装器调用示例

下面只有占位符和非秘密路由数据；不要把密码、Cookie、Token 或真实 `.env` 写入命令：

```bash
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

编排器最终运行的命令形态：

```bash
env \
  NAV_MAIL_ACCEPTANCE_FIXTURE_MODE=required \
  NAV_MAIL_ACCEPTANCE_PRIMARY_BASE_URL=<primary-origin> \
  NAV_MAIL_ACCEPTANCE_SECONDARY_BASE_URL=<secondary-origin> \
  NAV_MAIL_ACCEPTANCE_MARKER=<synthetic-marker> \
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
2. 分别登录两个域名并验证 `/api/auth/session` 返回同一个一次性用户。
3. 记录该一次性用户的 `mail_outbox` 数量。
4. 读取邮件列表和详情；用唯一标记验证服务端 `q` 搜索；通过第二域验证 `unread` 过滤。
5. 对合成会话执行通知规则 preview、create、跨域 list、patch 和 delete；若已有同身份规则则
   失败，绝不覆盖后再删除未知数据。
6. 执行邮件 AI summarize，并要求来源中包含合成邮件。
7. 调用 `/api/email/ai/search` 的 `answer=false` 来源模式，要求返回合成邮件来源；该步骤不制造
   第二次模型回答。
8. 生成 `create_draft` AI 提议，使用原样 token/参数显式 confirm；读取 PostgreSQL 只验证
   `payload_encrypted`、`content_hash`、`status=draft` 与 `outbox_id IS NULL`。
9. 以 `draft id + ephemeral user id + status=draft + outbox_id IS NULL` 精确删除该临时草稿。
   任一条件不匹配都失败关闭。包装器最终删除一次性用户时仍会通过外键清理其操作记录。
10. 再次记录该用户的 `mail_outbox` 数量，要求与开始时完全一致，然后双域退出。

任何 HTTP、JSON、所有权、密文、清理、outbox 不变式或退出检查失败都返回非零。`EXIT`
清理会尽力删除本轮精确创建的规则和草稿并退出两个域；清理失败会把最终状态提升为失败。

## CI 门禁

- GitHub Linux CI 对脚本执行 `bash -n` 和 `shellcheck --severity=warning`。
- `api/test/mailWorkspaceAcceptanceTooling.test.js` 静态验证包装器门禁、凭据文件读取、双域
  Cookie jar、所需 API、outbox 前后不变、精确临时草稿清理、SKIP 非零，以及禁止真实发送
  和远端邮箱修改入口。
- 静态检查不等于生产验收；没有一次性用户所属的合成邮件时必须保持 SKIP/FAIL。
