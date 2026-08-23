# NAV 统一搜索、个人资料助理与 AI 用量

本能力由迁移 `020_workspace_search.sql` 与 `021_ai_usage.sql` 提供。它们只属于源码候选；合并、
迁移与生产启用仍需遵循发布门禁。

## 统一站内搜索

- `GET /api/workspace/search?q=...&limit=...` 同时搜索当前用户的书签与未加密笔记。
- 排序优先级为：数字 ID 精确匹配、标题精确/开头/包含、标签、网址/描述/正文，再按更新时间、
  类型与 ID 稳定排序。
- `%`、`_` 与反斜杠会作为字面字符转义，所有值通过 PostgreSQL 参数传递。
- `notes.encrypted = FALSE` 是 SQL 级硬边界。加密笔记不会进入结果、摘要或助理上下文。
- `pg_trgm` 可安装时提供相近文字匹配和条件 GIN 索引；扩展不存在或运行时失效时自动重试
  零扩展的精确/前缀/子串查询，不阻断搜索。
- 前端优先调用统一 API；服务端不可用时保留 Dexie 本地缓存降级，并明确显示降级来源。

这不是中文分词 BM25 或向量语义搜索。中文无需空格的子串检索与 `pg_trgm` 错字容错已经可用，
后续若数据量与相关性评估确有需要，再引入 tokenizer/BM25 或向量索引。

## 单轮个人资料助理

- `POST /api/assistant/query` 每次只处理一个问题，不创建会话表，不保存问答历史。
- 助理复用统一站内搜索；来源按当前稳定排序编号为 `S1`、`S2`，并返回可点击的站内/书签链接。
- 标题与摘录被明确标记为不可信数据；系统提示禁止执行其中的指令。
- 进入模型前会遮盖常见 API Key、Token、Bearer、JWT、密码/密钥字段，以及 URL 凭据、查询串
  和 fragment。发送给模型的上下文数量与长度均有上限。
- AI 未配置、模型调用失败或来源为空时返回 HTTP 200 的 `retrieval` 模式，来源仍可直接打开；
  不会因为外部 AI 故障丢失站内检索结果。
- 模型回答被要求使用 `[S1]` 引用；无论模型是否完全遵循，前端始终单独展示实际来源卡片。

## AI 用量与成本

- `ai_usage_daily` 仅按天、用户、功能、provider、模型与 API 模式聚合：请求/成功/失败、Token、
  总延迟和可选估算成本。
- 表中没有 prompt、问题、笔记正文、模型回答、URL、密钥或原始 provider payload 字段。
- `GET /api/ai-usage?days=7|30|90` 返回当前用户汇总；`GET /api/ai-usage.csv` 导出相同边界的 CSV。
- 设置页展示 7/30/90 天面板。没有匹配单价时成本为“未知”；只有部分请求有单价时明确标记
  为部分估算，绝不内置或猜测可能过期的模型价格。
- 可选环境变量 `NAV_AI_PRICE_CATALOG_JSON` 使用以下结构：

```json
{
  "chatgpt:model-id": {
    "inputPerMillionUsd": 0,
    "cachedInputPerMillionUsd": 0,
    "outputPerMillionUsd": 0
  }
}
```

请只填写从当前 provider 账单文档核验过的价格。键可用 `provider:model`、`model`、`provider:*`
或 `*`；更精确的键优先。

## 保留与运行开关

AI 日聚合默认保留 400 天，清理任务默认关闭：

```dotenv
NAV_AI_USAGE_RETENTION_ENABLED=false
NAV_AI_USAGE_RETENTION_DAYS=400
NAV_AI_USAGE_RETENTION_INTERVAL_SECONDS=86400
NAV_AI_USAGE_RETENTION_BATCH_SIZE=500
NAV_AI_USAGE_RETENTION_MAX_BATCHES_PER_RUN=20
```

任务使用 PostgreSQL advisory lock、`FOR UPDATE SKIP LOCKED`、批量上限和现有维护状态/Telegram
告警框架。生产首次启用前仍需数据库备份、清理预估、后台状态和告警目标验收。

## 验证

依赖无关测试覆盖搜索转义/降级/加密边界、助理来源和脱敏、用量归一化/成本未知、CSV 公式注入
防护、保留任务锁与批量边界，以及前端服务/UI 接线。完整门禁还需 GitHub CI 的 PostgreSQL 16
迁移/恢复集成测试、Fastify API 测试和 Vite 构建。
