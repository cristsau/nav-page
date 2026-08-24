# NAV 混合搜索、Web Push 与块编辑器

更新时间：2026-08-24
源码状态：`VERIFIED_LIVE`（真实设备通知授权为 `USER_ACTION_REQUIRED`）

本批由迁移 `023_hybrid_workspace_search.sql`、`024_web_push.sql` 和
`025_block_editor.sql` 提供。PR #37 已合并为 `a9eff0d7888fd29f8888a503a336af86371c3b80`，
PR #38 已把恢复就绪竞态与 Service Worker 缓存加固合并为
`788be84c766470d0dce845b282aa246286f77d67`。GitHub Linux CI、PostgreSQL 16 隔离迁移/恢复、
OVH 发布前后备份和生产验收均已通过。

## 生产验收快照

- OVH release：`/opt/nav-stack/releases/20260824-031310-a9eff0d`。
- API 镜像：`nav-ovh-api:a9eff0d7888fd29f8888a503a336af86371c3b80`。
- 最终 master CI：`32689782306`，五个作业全部成功。
- 数据库迁移 ledger 已精确核对到 `025_block_editor.sql`；发布后备份在隔离 PostgreSQL 16
  中恢复为 25 张表。
- 双域健康/CORS、一次性管理员登录与清理、混合检索 `searchMode=hybrid`、块笔记创建和版本、
  Web Push 配置/公钥、PWA 静态资源与缓存头均通过。
- `nav-api` 与 `nav-web` 之外的容器未重建；PostgreSQL、CLIProxyAPI、NPM 及其他服务保持原状。
- 本机没有执行 npm 测试或构建；完整依赖、测试和 Vite 构建由 GitHub CI 与 OVH 完成。
- Web Push 服务器链已验证，但浏览器权限不能代授权。Chrome/Edge 需在当前设备启用；iPhone/iPad
  需先添加到主屏幕，再从主屏幕打开并授权通知。只有收到真实设备测试通知后，才能把该项
  从 `USER_ACTION_REQUIRED` 改为端到端真机通过。

## 混合站内搜索

- 书签和未加密笔记进入用户隔离的派生索引；加密笔记在 SQL 源查询处排除。
- 中文使用 NFKC 后的单字、二元和三元 token，英文/数字保留词元；标题、标签、URL 和正文
  分别按 5、3、2、1 加权。
- 关键词层使用 BM25（`k1=1.2`、`b=0.75`）；语义层使用固定 revision 的本地多语言
  MiniLM q8 embedding，并与 BM25 按 32% / 68% 合并。
- 模型及向量缓存只位于 OVH Docker volume；查询、笔记和书签不会发给 embedding 服务商。
- 原始标题和 URL 保留大小写，派生 token 才小写，避免破坏大小写敏感网址。
- 书签/笔记写入只标记索引为 dirty；搜索或后台任务持有用户状态行锁后批量同步，避免每次
  写入做全量重建。模型 revision 变化时旧向量不会与新查询向量混用。
- 模型不可用时请求自动降级为 BM25；BM25 不可用时仍保留既有统一搜索降级路径。

生产环境变量：

```dotenv
NAV_HYBRID_SEARCH_ENABLED=true
NAV_SEMANTIC_SEARCH_ENABLED=true
NAV_EMBEDDING_MODEL=Xenova/paraphrase-multilingual-MiniLM-L12-v2
NAV_EMBEDDING_MODEL_REVISION=2c4055b12046f11709e9df2c122e59ffbdc2f900
NAV_EMBEDDING_CACHE_DIR=/var/cache/nav-models
NAV_EMBEDDING_SCHEDULER_ENABLED=true
NAV_EMBEDDING_SCHEDULER_INTERVAL_SECONDS=300
NAV_EMBEDDING_SCHEDULER_BATCH_SIZE=24
```

启用语义搜索前必须在精确发布镜像中执行 `npm run prewarm:embeddings --prefix api`，确认固定
revision 可下载、可加载并生成有效向量；失败时不得启用语义开关。

### 依赖审计边界

本地向量模型运行时当前通过 `@huggingface/transformers@4.2.0` 引入
`onnxruntime-node@1.24.3`、`sharp@0.34.5` 与 `adm-zip@0.5.18`。截至本候选版，
npm 对 `sharp` 和 `adm-zip` 各报告一项上游暂无修复的高等级公告。NAV 不把用户上传的
图片或压缩包交给该运行时，模型仓库与 revision 固定，模型缓存只由发布预热任务写入。

CI 不会全局忽略告警：`.github/scripts/verify-api-audit-policy.mjs` 仅允许这两个公告、上述
四个精确包版本及其唯一传递链。新增公告、包版本漂移、无法追溯的传递依赖或其他中高危
问题都会继续阻断发布。上游提供修复版本后，应移除例外并升级锁文件。

## 页面关闭后的 Web Push

- 浏览器在用户主动授权后生成 Push subscription；VAPID 私钥只从 release-local、只读 Secret
  文件读取，公钥才返回前端。
- Chrome/Edge、Firefox、Safari/Apple 与 Windows Push endpoint 只允许明确的服务商域名，
  拒绝私网、自定义主机和带 URL 凭据的 endpoint。
- 服务端为提醒和设备建立唯一投递记录，最多重试 6 次并指数退避；404/410 自动停用失效设备。
- 只为最近 24 小时触发的提醒建立投递，避免新设备首次订阅后收到大量历史提醒。
- 加密笔记通知只显示通用文案，不包含标题、正文、密码或密文。
- VAPID 公钥更换时，浏览器会撤销旧 subscription 并重新订阅。
- iPhone/iPad 必须先将网站添加到主屏幕，再从主屏幕打开并授权通知。

私钥绝不能写进 `.env`、Git、镜像、日志或文档：

```dotenv
NAV_WEB_PUSH_ENABLED=true
NAV_WEB_PUSH_VAPID_SUBJECT=https://nav.skrskr.net
NAV_WEB_PUSH_VAPID_PUBLIC_KEY=<public-key-only>
NAV_WEB_PUSH_VAPID_PRIVATE_KEY_FILE=/run/secrets/nav/web-push-vapid-private-key
NAV_WEB_PUSH_SCHEDULER_ENABLED=true
NAV_WEB_PUSH_SCHEDULER_INTERVAL_SECONDS=60
NAV_WEB_PUSH_SCHEDULER_BATCH_SIZE=100
NAV_WEB_PUSH_MAX_ATTEMPTS=6
```

`NAV_NOTE_REMINDER_SCHEDULER_ENABLED=true` 也是离线推送生效的前置条件。

## Notion 式单用户块编辑器

- 基于 Tiptap 3，支持正文、三级标题、粗体、斜体、下划线、高亮、链接、任务/项目/编号列表、
  引用、行内代码、代码块、分隔线、对齐、表格、图片、撤销/重做、拖动块和 `/` 斜杠菜单。
- 表格支持插入以及行、列、整表增删；斜杠菜单支持方向键、Enter 和 Esc。
- 桌面和触屏共用可访问工具栏；只读详情、版本预览和公开分享使用同一块渲染器。
- 未加密笔记保持 1.2 秒自动保存、revision 冲突保护和最近 50 个版本；块 JSON、纯文本检索副本
  和版本状态由数据库约束共同保护。
- 图片只能引用当前用户已登记的图床附件。删除正文图片块或附件时两处同步；保存后沿用
  “无其他当前笔记引用且非长期保留才删除原图”的安全生命周期。
- 加密笔记的纯文本与块 JSON 分别在浏览器 AES-GCM 加密；服务端仅保存密文。解密后的块 JSON
  在渲染前再次过滤节点、URL 和 marks，防止恶意链接或图片属性进入页面。
- 旧纯文本笔记在编辑时无损转换为段落块；导出、替换恢复、版本恢复和公开分享兼容新旧格式。

这里的“完整”指当前产品范围内的单用户 Notion 式编辑体验。多人实时协作、评论、Yjs/CRDT、
数据库视图和 Notion API 不在本批范围，也不会为了宣称“完整”而引入新的协作基础设施。

## 发布与回滚

1. GitHub CI 完成依赖审计、API 测试、Vite 构建、迁移幂等/漂移拒绝，以及独立 PostgreSQL 16
   的混合搜索、Web Push、块状态、恢复和发布验收。
2. OVH 只读基线后，备份 PostgreSQL，校验 SHA-256，并在无网络 PostgreSQL 16 中隔离恢复。
3. 创建独立 release，安装 VAPID Secret，预热固定模型，再执行 023–025 加法迁移。
4. 只重建 `nav-api` 与 `nav-web`；PostgreSQL、CLIProxyAPI、NPM 和其他服务不重建。
5. 验收双域健康、CORS、登录态、BM25/语义降级、块保存/版本/分享/加密、Push 服务端状态。
6. 应用失败回滚到发布前 release。023–025 为加法迁移，应用回滚时保留；数据恢复使用发布前备份。

浏览器通知权限不能由服务器代替用户授予。发布时可以验证 VAPID、订阅 API 和服务端投递链；
最终“页面已关闭仍收到通知”必须由用户在真实电脑/手机上启用当前设备并发送一次测试通知。

## 明确暂缓

- Chrome Web Store / Edge Add-ons 的开发者账号、签名、提交与审核。
- 异地存储 Secret 与首次远端快照；源码入口保留，等待用户选定免费存储后填写。
- 多人协作、评论、Yjs/CRDT 与 Notion 数据库视图。
