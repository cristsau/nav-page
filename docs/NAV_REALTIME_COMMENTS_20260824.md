# NAV 实时评论事件流

更新时间：2026-08-24
状态：`LOCAL_DONE / READY_FOR_CI / NOT_DEPLOYED`

## 任务边界

- 目标：把协作评论从前台每 4 秒请求升级为真正的实时事件通知，同时保留离线与断线兜底。
- 工作目录：`D:\DomoCodex\projects\NAV-realtime-comments-20260824`
- 任务类型：本地可逆修改。
- 明确不包含：GitHub 推送/PR、OVH 发布、生产迁移、容器重建、图床或代理配置、异地存储配置。
- 完成标准：评论和成员变更即时通知；事件不携带评论正文；连接逐用户/逐笔记鉴权；断线自动重连；
  迁移可验证且关键漂移会失败；现有离线 outbox 与 Yjs 正文协作保持不变。

## 实现

- 迁移 `028_realtime_collaboration_events.sql` 在评论、成员和笔记删除事件插入后调用 PostgreSQL
  `pg_notify('nav_note_sync_events', ...)`。CRDT 正文和普通元数据写入不触发此通道；通知只含事件
  ID、笔记 ID 和事件类型。
- API 使用一条专用 PostgreSQL `LISTEN` 连接接收提交后的通知，再读取权威事件行；只有事件
  `audience_user_ids` 中、且连接时仍有对应笔记权限的用户可收到 WebSocket 元数据。
- 评论事件通道为 `/api/collaboration/events/:noteId`。它与 Yjs 正文通道分离，最大入站载荷限制为
  16 KiB，并使用 25 秒 ping/pong 清理失活连接。
- 所有者、编辑者、评论者和只读成员均可订阅事件；只有所有者/编辑者仍可进入 Yjs 正文写通道。
- 成员被移除或笔记被删除时，服务端先送达最后一个受众事件，再以策略关闭连接；重新连接仍会
  重新执行会话、Origin、笔记和角色鉴权。
- 前端显示“实时已连接/正在重连/离线模式/权限已变更”等状态。连接可用时不再轮询；只有断线或
  浏览器不支持 WebSocket 时才每 30 秒做一次低频兜底，并保留窗口聚焦、恢复可见和离线队列完成
  后的立即刷新。

## 安全与数据边界

- 实时事件只含游标、笔记 ID、事件类型和实体 ID，不含评论正文、选区内容、笔记标题、操作者、
  Cookie、Token 或任何 Secret。
- PostgreSQL `NOTIFY` 在事务提交后送达；事件正文继续保存在既有 `note_sync_events`，因此多 API
  实例可从同一数据库接收，不依赖单进程内存广播。
- 加密笔记仍拒绝服务器协作和实时评论。
- 浏览器断线期间的评论继续写入 IndexedDB/outbox；联网后服务端触发相同实时事件，不改变幂等
  收据与冲突处理语义。

## 验证门禁

- 本机只执行语法解析、源码契约测试和 `git diff --check`，不安装 npm、不运行 Vite。
- GitHub CI 必须继续通过 API 全量测试、Vite 构建、迁移双跑、PostgreSQL 16 协作集成测试、
  关键迁移漂移拒绝和既有恢复/维护/发布验收作业。
- PostgreSQL 协作集成测试需打开真实事件 WebSocket，创建评论并证明另一端收到
  `comment.upsert`，且消息中不存在 `body`。
- 发布需执行迁移 028，仅重建 `nav-api` 与 `nav-web`，保留 PostgreSQL、CLIProxyAPI、NPM 及
  其他服务；双域使用一次性账号完成 owner/editor/commenter/viewer 权限、即时评论、断线重连、
  离线补发和合成数据清理验收。

## 回滚边界

- 应用失败时回滚到发布前精确 release；迁移 028 为加法触发器，可保留。
- 若通知触发器异常，可在维护窗口精确禁用/删除 `trg_note_sync_events_notify`，前端会自动降级到
  30 秒兜底刷新；不得因此删除 `note_sync_events` 或现有离线同步数据。
