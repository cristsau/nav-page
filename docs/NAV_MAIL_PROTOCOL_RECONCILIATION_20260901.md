# DOMO NAV — 邮件协议对账与多目录周期同步

状态：`LOCAL_DONE / POSTGRESQL16_VERIFIED / NOT_DEPLOYED`

基线：`a7c00709545644587bda6113c8039d7e1acbba67`

分支：`codex/nav-mail-protocol-p1-20260901`

日期：2026-09-01

## 1. 交付范围

本候选通过加法迁移 `044_email_protocol_reconciliation.sql` 完成邮件协议 P1：

- 保留原有 `INBOX` IMAP IDLE 和即时增量收件路径；独立的只读 IMAP 连接负责协议对账，
  不会为了扫描其他目录反复切换实时连接当前选中的目录。
- 只有服务器实际成功 ENABLE `CONDSTORE` 后才使用 `CHANGEDSINCE`；同时成功 ENABLE
  `QRESYNC` 时通过 `VANISHED` 得到精确远端删除 UID。只宣告但未启用的能力按不可用处理。
- 无持久 MODSEQ 游标、不支持增量能力或目录返回 `NOMODSEQ` 时，执行有上限的 UID 与 flags
  权威扫描。超过上限或响应不完整时失败关闭，不猜测远端状态。
- 周期同步所有已订阅且可选择的目录。首次或积压阶段按有界批次追赶；历史目录邮件继续分类和
  检索，但固定 `notificationEligible=false`，不会把历史邮件当成刚收到的新邮件通知。
- 记录连接尝试、重试、失败、重连以及滚动连接/同步延迟 p50、p95。指标只包含数量、耗时和
  泛化错误码，不包含地址、主题、正文、附件名、目录名、凭据或 Token。

本候选不执行远端写操作，不改变远端 flags，不移动或删除远端邮件，也不包含生产发布。

## 2. 游标和状态模型

`email_folders.highest_modseq` 表示最近一次从服务器观察到的值，不能直接证明所有变化已经写入
本地。迁移 `044` 因此增加独立的 `reconciled_modseq`，只有一次完整对账在事务内成功应用后才
推进。同时记录：

- `last_reconciled_at`：最近成功对账时间；
- `last_reconcile_mode`：`qresync`、`condstore`、`uid_flags_scan` 或 UIDVALIDITY 重置过渡标记；
- `last_reconcile_error_at` 和 `last_reconcile_error_code`：不含敏感内容的失败状态。

UIDVALIDITY 变化时，原目录的旧 UID 位置立即标记为 expunged，清空已提交 MODSEQ 游标并增加
同步代次；规范邮件密文不会删除。随后必须用新 UIDVALIDITY 完成全量有界扫描。对账开始与提交
之间 UIDVALIDITY 再次变化、远端 HIGHESTMODSEQ 回退或增量响应缺少必要游标时，事务回滚并记录
失败；不会盲目推进游标。

## 3. flags、VANISHED 与 expunge

- flags 更新以 `folder_id + user_id + uid_validity + uid` 定位，只允许 MODSEQ 不小于本地值的
  更新覆盖现有状态。
- QRESYNC 的 `VANISHED` 必须携带 UID；收到只有序号或无法识别的删除事件时失败关闭。
- 仅有 CONDSTORE 时，增量读取变化 flags 后再扫描权威 UID 集，从本地位置差集确定 expunge。
- 无增量能力时，批量读取全部权威 UID 和 flags，再以同样的差集规则处理。
- expunge 只设置 `email_folder_messages.expunged_at`；同一规范邮件在其他目录的位置、规范邮件
  密文和远端邮箱均不受影响。
- 所有写入都带当前 `user_id`，PostgreSQL 复合归属约束继续阻止跨用户目录或邮件位置串写。

## 4. 调度、重试与有界资源

主收件循环追平 `INBOX` 后才选择到期目录。每轮优先对账主目录，再处理有限个其他目录；未追平
的次级目录通过现有连续排空时间片继续推进，不阻塞 `INBOX` IDLE。默认策略：

- `NAV_IMAP_FOLDER_SYNC_INTERVAL_SECONDS=900`
- `NAV_IMAP_FOLDERS_PER_RUN=2`
- `NAV_IMAP_RECONCILE_MAX_MESSAGES=20000`
- `NAV_IMAP_RECONCILE_BATCH_SIZE=500`
- `NAV_IMAP_TELEMETRY_SAMPLE_SIZE=64`

目录或协议失败后至少等待一个目录同步周期再重试。单封次级目录邮件沿用既有有限重试和加密
死信占位规则；unknown、UIDVALIDITY 冲突、MODSEQ 回退、缺失 VANISHED UID 或超出扫描上限
不会立即循环重试。所有原文缓冲在处理后覆零。

## 5. 验证契约

本地验证必须包括：

1. API 全量 Node 测试零失败。
2. PostgreSQL 16 中连续执行两次迁移、运行结构验证器，并执行
   `test:email-mailbox:integration`。
3. 集成测试证明 MODSEQ 单调 flags、精确 VANISHED、CONDSTORE 权威 UID 差集、UIDVALIDITY
   与 MODSEQ 冲突失败关闭、跨用户隔离、规范邮件保留和 expunge 幂等。
4. 多目录测试证明已订阅次级目录按周期入库、历史邮件不通知、即时重复轮询被抑制且失败目录
   进入冷却。
5. 观测单测证明滚动样本有界、p50/p95 算法确定、两个 IMAP 连接的重试身份分离。

未来合并前仍以 GitHub Linux + PostgreSQL 16 全量 CI 为硬门槛。生产启用前还必须使用一个实际
支持 QRESYNC/CONDSTORE 的测试邮箱，分别验证能力成功启用、能力被拒绝后的 fallback、远端已读/
星标、移动、删除、UIDVALIDITY 变化和断线重连。

## 6. 发布、回滚和已知边界

- `044` 是加法迁移。应用回滚可保留新增列、约束和索引；不得为回滚清表、删除规范邮件或倒退
  邮箱游标。
- 若真实邮箱验收出现 UIDVALIDITY/MODSEQ/VANISHED 异常，先关闭邮件抓取 worker 并保留错误
  状态，再回到发布前应用 release；不要重置远端邮箱。
- fallback 权威扫描默认最多 20,000 封。更大目录会明确失败关闭；调整上限前必须评估 IMAP、
  内存和执行时间，不应无限放大。
- 只有 subscribed 且 selectable 的目录参与周期同步；未订阅目录、共享命名空间和虚拟搜索目录
  不在本期保证范围。
- 次级目录是周期同步，不承诺与 `INBOX` 相同的秒级实时性。进程内滚动延迟样本会在 worker
  重启后重新开始，不是长期时序数据库。
- 本地测试使用协议替身和真实 PostgreSQL 16；真实 MXroute 或其他 Provider 的协议兼容性仍需
  在未来授权的预生产/生产验收中证明，当前状态不能标为 `VERIFIED_LIVE`。
