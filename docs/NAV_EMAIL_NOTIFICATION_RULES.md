# DOMO NAV 邮件通知规则接口

状态：后端契约（迁移 `039_email_notification_rules.sql`）

## 规则语义

规则只影响 DOMO NAV 自己产生的站内通知、Web Push 和每日邮件摘要，不会修改、移动或删除原邮箱中的邮件。

- `scope`：`conversation`、`sender`、`domain`、`category`、`account`
- `action`：`immediate`、`digest`、`in_app_only`、`silent`
- 优先顺序：会话 > 发件人 > 域名 > 分类 > 邮箱账号；同一身份采用最近更新的规则
- `enabled=false` 表示暂停；`expiresAt` 到期后自动失效；删除为硬删除
- 命中后更新 `hitCount` 和 `lastHitAt`，`explanation` 可用于 UI 解释为什么提醒或静默
- 安全、支付或 Tier 1 邮件属于重要邮件。抑制这类通知必须显式传入
  `criticalOverrideConfirmed=true`；否则运行时保留默认立即提醒并返回安全保护原因

发件人、域名、分类和会话键不会以明文存储：匹配使用带域分隔的 HMAC-SHA-256，原值使用邮件专用 AES-GCM 密钥加密。接口只允许当前登录用户访问自己邮箱账号下的规则。

## REST API

所有接口要求登录态，并返回 `Cache-Control: private, no-store`。

### 查询规则

`GET /email/notification-rules?accountId=<uuid>`

省略 `accountId` 时返回当前用户全部邮箱账号的规则。响应中的 `matchValue` 仅在服务端完成所有权检查后解密。

### 预览规则

`POST /email/notification-rules/preview`

请求：

```json
{
  "accountId": "uuid",
  "scope": "sender",
  "matchValue": "sender@example.com",
  "action": "silent",
  "expiresAt": null,
  "enabled": true,
  "criticalOverrideConfirmed": false
}
```

账号范围规则可省略 `matchValue`。响应包含最近最多 20 个匹配、匹配总数、重要邮件匹配数，以及是否必须二次确认。预览不保存规则。

### 创建或覆盖规则

`POST /email/notification-rules`

请求体与预览相同。同一个用户、邮箱账号、范围和匹配值只保留一条规则；首次创建返回 `201`，覆盖返回 `200`。需要重要邮件确认但未确认时返回 `409` 和错误代码
`EMAIL_CRITICAL_NOTIFICATION_CONFIRMATION_REQUIRED`。

### 修改规则

`PATCH /email/notification-rules/:id`

允许修改 `action`、`enabled`、`expiresAt`、`criticalOverrideConfirmed`。规则身份（账号、范围、匹配值）不可修改；需要更换身份时先删除再创建。

### 删除规则

`DELETE /email/notification-rules/:id`

仅可删除当前用户自己的规则。历史事件保留其通知决定，但外键会把已删除的 `notificationRuleId` 置空。

## 邮件列表字段

邮箱列表和详情为 UI 提供：

- `category`
- `importanceScore`
- `notificationAction`
- `notificationReason`
- `notificationRuleId`
- `threadKey`
- `threadMessageCount`

这些字段来自新邮件进入时的一次确定性规则决策。Tier 1 默认立即提醒，Tier 2 默认进入摘要，Tier 3 默认静默；用户规则优先于默认策略，但重要邮件保护优先于未确认的抑制规则。

## 审计事件

创建、覆盖、修改、删除和预览分别记录：

- `email.notification_rule.create`
- `email.notification_rule.update`
- `email.notification_rule.delete`
- `email.notification_rule.preview`

审计元数据仅保存范围、动作、启用状态和数量，不保存发件人、域名或其他匹配明文。
