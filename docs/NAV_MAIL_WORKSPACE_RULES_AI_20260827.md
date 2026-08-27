# DOMO NAV 邮箱工作区、通知规则与 AI 副驾驶

状态：代码已完成，待 CI 与生产发布
基线：`dea1d49bd36e2f19e7a261067e981650d8556bd0`
日期：2026-08-27

## 目标

在不复制参考产品品牌外观、不增加第二套全局导航的前提下，把现有邮箱三栏骨架完善为可长期使用的 DOMO NAV 邮件工作区，并解决两项主要问题：

1. 邮件列表、详情和常用操作的信息层级不足；
2. Tier 1 即时通知和 Tier 2 摘要缺少用户可控规则，导致提醒过多。

本批同时把邮件 AI 从四个并列按钮收敛为一个受控副驾驶。AI 可以理解、检索、生成草稿和提出跨模块动作，但不能自行发送、删除、移动或批量修改邮件。

## 本批范围

### 工作区

- 桌面保留 DOMO NAV 顶部主导航，邮箱内部使用账号/文件夹、邮件列表、邮件详情三栏。
- 手机使用文件夹弹层、邮件列表、邮件详情的逐级导航，不压缩为三栏。
- 列表提供服务端搜索、全部/未读/重要/附件筛选、游标分页、清晰未读/附件/类别/通知状态。
- 详情提供固定操作区、会话上下文、附件按需下载、统一通知菜单和 AI 副驾驶入口。
- 继续以纯文本安全正文为权威显示；不自动加载远程图片、追踪像素、脚本或附件。

### 通知规则

通知动作固定为：

- `immediate`：站内通知并允许 Web Push；
- `digest`：只进入摘要；
- `in_app_only`：只在站内通知中心显示；
- `silent`：不创建提醒，邮件仍保留在邮箱中。

规则作用域固定为：

- `conversation`；
- `sender`；
- `domain`；
- `category`；
- `account`。

优先级固定为：

`conversation > sender > domain > category > account`

没有命中用户规则时，再使用系统邮件分级的默认通知策略。

用户明确规则优先于 AI 分类。账号安全、付款、证书和服务故障等高风险类别在保存完全静音前必须展示额外确认，但确认后仍尊重用户选择。规则只改变 DOMO NAV 提醒，不删除、拒收、隐藏或修改原邮箱邮件。

### AI 副驾驶

- 当前邮件自由问答；
- 会话总结、相较上次的变化、未决问题和等待谁回复；
- 结构化类别、重要度、判断理由、行动项、截止时间和风险提示；
- 回信语气、长度与语言控制；
- 受限跨邮件只读检索，并返回可打开的来源；
- 自然语言只生成通知规则提议，保存前必须预览和确认；
- 从邮件提议创建日记、备忘录或回复草稿，写操作必须使用绑定用户、资源版本、完整参数哈希和有效期的确认令牌。

AI 不得自动发送、删除、移动或批量修改邮件。邮件正文始终按不可信输入处理；附件默认不发送给模型，模型不得联网或调用任意工具。所有 AI 写入均由确定性工具执行并记录审计。

## 后续批次边界

真实 IMAP 写操作不属于本批：标记已读、远端星标、归档、移动、垃圾箱和永久删除需要独立的命令 outbox、幂等键、UIDVALIDITY/MODSEQ 冲突核对、撤销窗口和真实邮箱验收。在该链路完成前，界面不得把本地状态伪装成远端修改成功。

## 数据与隐私

- 邮件正文和信封继续使用现有 AES-256-GCM 加密存储。
- 发件人和域名规则的可匹配值使用带服务端密钥的摘要进行等值匹配；需要向用户展示的标签单独加密保存，API 不回显原始秘密或内部密钥。
- 通知解释只返回命中作用域、规则动作、分类与必要的通用原因。
- AI 缓存和动作提议绑定内容版本；邮件变化后旧确认令牌自动失效。
- Web Push 对敏感邮件继续使用通用标题和入口，不暴露正文、主题、发件人或金额。

## 验收门禁

### CI

- API 全量单元测试与前端生产构建通过；
- PostgreSQL 16 重复迁移、结构验证和回滚演练通过；
- 邮箱 PostgreSQL 集成测试覆盖规则归属、优先级、暂停/删除、过期、预览与通知投递；
- AI 测试覆盖不可信正文、来源绑定、确认令牌篡改/过期/资源变化和禁止自动发送/删除/移动；
- 无障碍测试覆盖键盘、Esc、焦点恢复、44px 触控和手机逐级导航。

### 生产发布

- 仅发布 GitHub CI 全绿后的精确 merge SHA；
- 发布前完成 canonical 备份和 PostgreSQL 16 隔离恢复；
- 迁移仅允许加法，应用回滚保留新表；
- 仅重建 `nav-api`、`nav-mail-worker`、`nav-web`；不重启 PostgreSQL、CLIProxyAPI、NPM、Vaultwarden、Komari；
- 失败回滚到发布前精确 release；
- 双域完成匿名健康、一次性管理员登录态、邮件列表/搜索/规则/AI、退出与容器健康验收；
- 生产验收不发送真实外部邮件，`NAV_EMAIL_SENT_APPEND_ENABLED=false` 保持不变。

### 迁移 039 行数与时长门禁

迁移 `039_email_notification_rules.sql` 会为历史 `email_events` 补齐通知决定，并在同一事务中校验约束。
当前生产只读基线为 924 行、约 2.72 MB，因此本次无需拆分迁移；这个结论不能自动沿用到之后的发布。
每次生产执行 039 前都必须先运行以下只读门禁：

```bash
export NAV_EMAIL_039_DATABASE_CONTAINER='<production-postgres-container>'
export NAV_EMAIL_039_DATABASE_NAME='<production-database-name>'
export NAV_EMAIL_039_DATABASE_USER='<production-database-user>'
scripts/release/check-email-notification-migration.sh --preflight
```

脚本对 `COUNT(*)` 设置 15 秒 statement timeout 和 2 秒 lock timeout。默认硬门禁为：

- `email_events <= 100000` 行；
- `email_events` 总关系大小不超过 256 MiB；
- 任一查询超时、锁等待或结果解析失败均为 `NO-GO`。

随后必须在 canonical 备份恢复出的无网络 PostgreSQL 16 隔离实例中，使用精确 merge SHA 连续运行两次
`npm --prefix api run migrate` 和一次 `npm --prefix api run verify:migrations`。对第一次迁移计时，并把实测秒数交给同一门禁脚本：

```bash
started_at="$(date +%s)"
DATABASE_URL="$ISOLATED_DATABASE_URL" npm --prefix api run migrate
elapsed_seconds="$(( $(date +%s) - started_at ))"
scripts/release/check-email-notification-migration.sh \
  --check-rehearsal-seconds "$elapsed_seconds"
DATABASE_URL="$ISOLATED_DATABASE_URL" npm --prefix api run migrate
DATABASE_URL="$ISOLATED_DATABASE_URL" npm --prefix api run verify:migrations
```

隔离实例必须可丢弃，`ISOLATED_DATABASE_URL` 不得指向生产。默认时长硬门禁为 120 秒；超过行数、大小或时长门禁时停止发布，先拆分回填/约束验证并重新走 CI 与恢复演练。发布证据必须保存脚本的两条 `GO` 输出、精确 merge SHA、隔离数据库标识和迁移日志摘要，不保存数据库口令或连接串。
