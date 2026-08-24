# DOMO NAV 协作、离线、整套灾难恢复与流式恢复

最后更新：2026-08-24

本页记录迁移 `026`、`027` 及其前后端、运维脚本的能力边界。当前分支状态在合并前为
`SOURCE_READY / CI_PENDING / NOT_DEPLOYED`；只有 GitHub 全量 CI、发布前完整备份与隔离恢复、
精确 merge SHA 发布和双域验收均通过后，才能把对应项标记为 `VERIFIED_LIVE`。

## 1. 多人实时协作与评论

### 用户能力

- 笔记所有者可按用户名添加 `editor`、`commenter` 或 `viewer`。
- `editor` 可以与所有者同时编辑同一篇未加密块笔记；协作光标显示用户名和稳定颜色。
- 评论支持正文选区、块标识、回复、修改、解决/重新打开和删除。
- PR #42 生产基线的评论面板每 4 秒静默刷新；当前 `codex/nav-realtime-comments-20260824`
  候选已改用 PostgreSQL `LISTEN/NOTIFY` + 鉴权 WebSocket 即时刷新。断线时才每 30 秒低频刷新，
  并保留窗口聚焦、页面恢复可见及离线队列完成后的立即刷新；正文继续使用 WebSocket + Yjs
  CRDT 实时同步。候选通过 CI 和生产验收前，不能把实时评论标记为 `VERIFIED_LIVE`。
- 所有角色都能读取自己被授权的笔记；只有所有者可管理协作者和协作笔记的图片引用。

### 数据与安全

- `note_collaborators` 保存最小角色关系；所有者不能重复成为协作者。
- `note_comments` 保存评论、选区、解决状态和作者；级联删除不会留下悬空正文。
- `note_crdt_documents` 保存压缩后的 Yjs 文档状态，`note_crdt_updates` 保存去重更新。
- `note_sync_events` 为跨设备增量同步保留有界游标和最后已知受众；成员被移除或笔记删除时，
  删除事件仍能送达原受众。
- WebSocket 握手必须同时通过会话 Cookie、精确允许的 Origin、笔记 UUID 和 `owner/editor`
  权限；加密笔记拒绝服务器协作。
- Yjs 状态加载完成后才升级 WebSocket，避免空文档先同步覆盖数据库；断开和服务关闭前等待
  活跃持久化写入。
- 加密笔记继续只在浏览器解密，不进入服务器 CRDT、评论或离线同步。

## 2. 完整离线编辑与跨设备同步

### 离线工作区

- Service Worker 依据 Vite 构建清单预缓存应用外壳和哈希静态资源，明确不缓存 `/api`、Cookie
  响应或私有 API 数据。
- 已登录用户的安全摘要、已访问笔记、评论、协作者和增量游标写入按用户分区的 IndexedDB；
  断网后可重新打开已经缓存的工作区。
- 未加密笔记的创建、修改、元数据、删除，以及评论的创建、修改、解决和删除，都会先写入本地
  乐观状态与 outbox；网络恢复后按顺序提交。
- 每个离线操作带 UUID `operationId` 和稳定内容摘要。服务端收据保证同一操作只执行一次；相同
  ID 的不同内容返回 `offline_operation_conflict`，revision 不一致返回服务器副本供人工处理。
- 支持 Background Sync 的浏览器会登记后台任务；不支持时由 `online`、页面可见、窗口聚焦和
  20 秒前台轮询兜底。跨设备通过服务器增量游标和 Yjs 文档状态收敛。
- Yjs 文档另由 `y-indexeddb` 持久化，所以已经打开过的协作正文可以在断网时继续编辑；重新
  联网后由 `y-websocket` 合并，而不是最后写入覆盖。

### 明确边界

- “完整离线”指已登录且至少成功加载过一次的未加密服务器笔记/评论工作区；全新浏览器在从未
  获取应用或数据时不能凭空离线启动。
- 加密笔记仍沿用本地加密边界，不上传服务器协作状态。
- 图片二进制上传和图床删除必须联网；离线时只能继续编辑已经缓存引用的正文。
- 浏览器可能限制 Background Sync，因此可观察的前台回退路径是必要组成部分，不能只依赖该 API。

## 3. 超过 5,000 条记录的流式恢复

- 设置页可导出 NDJSON 流文件；每行仅包含一个头记录、集合记录或结尾记录。
- 上传 Content-Type 为 `application/x-domo-nav-backup-ndjson`，服务端直接读取请求流，不把整个
  备份解析进内存。
- 默认上限为 128 MiB、单行 2 MiB；记录按 250 条批量写入用户和会话绑定的暂存表。
- 上传过程计算 SHA-256，并要求 trailer 中的记录数、各集合计数和摘要全部一致；未完成上传、
  跨用户/跨会话 ID、过期上传和损坏摘要均不能进入预览或应用阶段。
- 预览、当前密码复验、确认文字、状态摘要、备份收据和替换边界继续复用原安全恢复门禁。
- PostgreSQL 16 隔离集成测试生成并恢复 6,500 条记录，证明路径越过旧的 5,000 条单体 JSON
  使用场景；生产验收不导入大批测试数据。

## 4. 包含图床对象和外层代理的一键灾难恢复

### 完整备份新增内容

除既有 PostgreSQL、源码、前端、Compose、Nginx、环境文件和运行时清单外，完整模式还包括：

- 通过专用 rclone remote 复制的图床对象树及对象清单；
- Nginx Proxy Manager 数据目录、证书/代理配置路径和在线 SQLite 一致性副本；
- 额外外层代理路径、恢复目标映射、文件类型/权限/符号链接清单与统一 SHA-256 manifest；
- 应用和代理 Compose 项目路径、预期服务名、健康检查和回滚所需的运行时参数。

这些值只允许写入 OVH 的 root-only `/etc/nav/nav-backup.env`。仓库示例为空，不含 Token、密码、
R2/S3 密钥、Cookie、证书私钥或真实 `.env` 内容。

### 恢复脚本的安全模式

`scripts/nav-disaster-restore.sh` 默认只生成验证计划，不修改主机：

```bash
sudo bash scripts/nav-disaster-restore.sh \
  --config /etc/nav/nav-backup.env \
  --backup /var/backups/nav/<exact-backup>
```

真正应用必须同时具备配置开关和命令行确认：

```bash
sudo bash scripts/nav-disaster-restore.sh \
  --config /etc/nav/nav-backup.env \
  --backup /var/backups/nav/<exact-backup> \
  --apply --confirm RESTORE-NAV
```

应用前再次核对 manifest、目录边界、所有者、权限和目标映射，并创建当前 PostgreSQL、图床对象和
代理配置的回滚副本。恢复顺序为固定代理/应用路径、NPM SQLite、PostgreSQL、图床对象、代理
Compose、应用 Compose和健康检查；任何一步失败都会尝试恢复应用前副本并留下失败证据。

### 不能夸大的边界

- 仓库已提供完整编排代码，不等于 OVH 已配置 rclone remote、对象读取权限、NPM 数据路径或
  干净主机恢复参数。
- “一键”是一次显式、双门禁、可回滚的运维命令，不是网页按钮，也不允许无确认覆盖生产。
- 首次生产启用前必须在隔离目录/临时 PostgreSQL 16 和可丢弃对象前缀做完整演练；图床对象数、
  NPM SQLite `quick_check`、双域代理和应用健康缺一项都不能称为整套恢复闭环。

## 5. CI 与发布门禁

本批次至少需要：

1. API 单元测试、Vite 生产构建和迁移 `026`/`027` 的完整约束与逆向漂移验证；
2. 独立 PostgreSQL 16 中的角色权限、评论、离线幂等和删除受众测试；
3. 6,500 条 NDJSON 上传、预览、应用、会话隔离、摘要损坏和清理测试；
4. Linux root Shell 对完整备份和默认只读灾难恢复计划的执行测试；
5. canonical PostgreSQL 16 备份与隔离恢复、一次性管理员生命周期及现有全部回归；
6. 发布前完整备份和隔离恢复通过后，仅重建本批需要的 `nav-api`、`nav-web`，保留 PostgreSQL、
   CLIProxyAPI、NPM 与其他服务；
7. 双域登录、协作角色、两浏览器并发正文、评论、离线重开/恢复同步、WebSocket、流式上传接口、
   缓存、退出和一次性账号清理验收。

真实 Edge/Chrome 的“页面关闭后收到 Web Push”仍需要操作系统浏览器参与，服务器/API 自动化
不能替代最终到达证据。
