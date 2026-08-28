# DOMO NAV — 真实邮箱远端操作队列

状态：`LOCAL_DONE / READY_FOR_CI`。迁移 `041_email_remote_commands.sql` 与本文件只描述仓库候选；未连接真实 IMAP、未部署生产。

## 支持范围

- 已读/未读、星标/取消星标；
- 归档、移动到已发现目录、移入垃圾箱；
- 永久删除仅允许在 Trash/Junk 或服务器已标记 `\\Deleted` 的邮件上执行，并要求字面确认 `DELETE_PERMANENTLY`；
- 每条操作先进入 `email_remote_commands`，默认保留 10 秒撤销窗口。API 返回 `scheduled` 不代表服务器已经修改；只有 worker 完成远端校验、命令和结果核对后才进入 `succeeded`。

## 一致性与失败语义

- 浏览器提交位置 ID、UIDVALIDITY、MODSEQ 与已读/星标/删除快照；服务器重新读取自己的 UID 和归属关系，不接受浏览器覆盖 UID。
- 每个用户的幂等键唯一；同键同请求返回原命令，同键不同请求返回 `REMOTE_IDEMPOTENCY_CONFLICT`。
- worker 打开源目录写锁并重新读取远端 UIDVALIDITY、MODSEQ 与 flags。快照变化进入 `conflict`，不会覆盖另一设备的新状态。
- flags 命令使用 `UNCHANGEDSINCE`（服务器支持 CONDSTORE 时）并在写后重新读取。网络结果不明确时仅可按目标状态安全对账。
- 移动与永久删除一旦开始后结果不明确，进入 `conflict`，不会盲目重试，也不会伪装成功。
- 连接或读取等明确发生在写入前的瞬时失败进入 `retry_wait`，有界退避并受最大尝试次数限制。
- 远端成功后才更新本地加密邮箱缓存；随后发送既有 `nav_email_mailbox_changes` 元数据事件。SSE 不包含主题、正文或地址。

## API 契约

```text
POST /api/email/accounts/:accountId/messages/:locationId/commands
GET  /api/email/commands/:commandId
POST /api/email/commands/:commandId/undo
```

创建命令使用：

```json
{
  "action": "mark_read",
  "idempotencyKey": "mail-command:<client-uuid>",
  "expected": {
    "uidValidity": "123",
    "modseq": "456",
    "seen": false,
    "flagged": false,
    "deleted": false
  }
}
```

`move` 另需 `targetFolderId`；`delete` 另需 `confirm: "DELETE_PERMANENTLY"`。创建成功返回 HTTP 202。命令状态只有：`scheduled`、`running`、`retry_wait`、`succeeded`、`conflict`、`failed`、`cancelled`。

## 隐私、审计与上线门禁

- outbox 不保存主题、正文、地址、目录路径、密码、Token 或确认文字，只保存归属 UUID、远端并发令牌、动作和泛化错误码。
- 排队、撤销、成功、失败与冲突写入安全审计，资源只引用 command UUID。
- worker 只在 `nav-mail-worker` 角色且邮件接收开关开启时运行；维护状态名为 `email_remote_commands`。
- CI 必须运行迁移/回滚与 PostgreSQL 16 隔离恢复、API 单元测试和无真实 IMAP 的撤销验收。
- 生产首次启用必须用专用测试邮件逐项验证 flags、移动、Trash、冲突和 SSE；永久删除另用可丢弃邮件单独验收。任何未知结果都按冲突处理，不得把测试脚本的本地队列 PASS 当成真实 IMAP PASS。
