# DOMO NAV Backend Plan

## 当前状态

DOMO NAV 已经完成第一阶段后端化，当前已在后端的能力包括：

- 用户登录
- 注册审批
- 会话管理
- 设置保存
- 书签与分组
- 便签 / 日记 / 分享
- 自定义搜索引擎
- Telegram 管理配置
- AI 搜索代理入口

数据主存已经切到 PostgreSQL，Dexie / IndexedDB 现在主要承担：

- 本地缓存
- 历史数据迁移来源

## 当前后端结构

### 服务

- Fastify API
- PostgreSQL

### 关键能力

- `auth`
- `settings`
- `navigation`
- `notes`
- `custom search engines`
- `telegram admin config`
- `ai search`

## 当前后端目标

接下来后端的工作重点不是“继续把基础 CRUD 搬过去”，而是补齐商业化所需能力：

1. 稳定 Telegram 链路
2. 稳定 AI provider 真连接
3. 备份
4. 审计日志
5. 限流
6. 多环境部署
7. 客户自部署交付能力

## 当前建议实施顺序

### 第一阶段

- 真实联调 Telegram
- 真实联调 ChatGPT / Brave / OpenClaw
- 补清晰的失败提示

### 第二阶段

- 增加备份策略
- 增加审计日志
- 增加限流

### 第三阶段

- 多环境拆分
- 客户买断版部署模板
- 商业版运维文档

## 关键后端文件

- `D:/DomoCodex/projects/NAV/api/src/routes/auth.js`
- `D:/DomoCodex/projects/NAV/api/src/routes/adminTelegram.js`
- `D:/DomoCodex/projects/NAV/api/src/routes/aiSearch.js`
- `D:/DomoCodex/projects/NAV/api/src/routes/navigation.js`
- `D:/DomoCodex/projects/NAV/api/src/routes/notes.js`
- `D:/DomoCodex/projects/NAV/api/src/routes/settings.js`
- `D:/DomoCodex/projects/NAV/api/src/bootstrap.js`
- `D:/DomoCodex/projects/NAV/api/src/config.js`
- `D:/DomoCodex/projects/NAV/api/src/lib/telegram.js`
