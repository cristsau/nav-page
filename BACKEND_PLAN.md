# NAV 后端实施文档

## 1. 本阶段目标

这一阶段不是把所有数据都一次性搬到后端，而是先完成：

- 正式后端服务骨架
- PostgreSQL 基础部署
- 用户认证后端化
- 注册审批后端化
- 前端支持切换到后端认证模式

这样做的结果是：

- 登录、注册、审批不再完全依赖前端 IndexedDB
- 默认管理员可以迁移到服务端
- 后续再迁移书签、便签、设置时不会推倒重来

## 2. 当前已实现的后端内容

### 2.1 新增 API 服务

位置：

- [api/package.json](D:/DomoCodex/projects/NAV/api/package.json)
- [server.js](D:/DomoCodex/projects/NAV/api/src/server.js)
- [app.js](D:/DomoCodex/projects/NAV/api/src/app.js)

技术选型：

- `Fastify`
- `pg`
- `@fastify/cookie`
- `@fastify/cors`

### 2.2 新增 PostgreSQL 数据模型

初始化迁移：

- [001_init.sql](D:/DomoCodex/projects/NAV/api/src/db/migrations/001_init.sql)

当前已建模表：

- `users`
- `registration_requests`
- `sessions`
- `system_settings`
- `schema_migrations`

### 2.3 新增认证能力

已实现：

- 登录
- 注册申请
- 登录态 session cookie
- 获取当前 session 用户
- 退出登录

### 2.4 新增管理员审批能力

已实现：

- 获取用户列表
- 获取注册申请列表
- 批准注册申请
- 拒绝注册申请

### 2.5 新增前端切换能力

前端已支持：

- `local` 模式：继续走当前 Dexie 本地认证
- `backend` 模式：改走后端 API

关键文件：

- [authApi.js](D:/DomoCodex/projects/NAV/app/src/shared/services/authApi.js)
- [useAuth.js](D:/DomoCodex/projects/NAV/app/src/shared/composables/useAuth.js)
- [router/index.js](D:/DomoCodex/projects/NAV/app/src/router/index.js)

环境变量：

- `VITE_AUTH_MODE=local|backend`
- `VITE_API_BASE_URL=/api`

## 3. 当前没有迁移的内容

这一阶段还没有迁移：

- 书签
- 分组
- 便签 / 日记
- 用户设置
- 自定义搜索引擎
- 分享记录

这些仍然保存在浏览器本地 `Dexie / IndexedDB` 中。

也就是说：

- 现在认证已经可以后端化
- 业务数据下一阶段再迁移

## 4. 为什么这样拆阶段

因为如果一次性把：

- 认证
- 审批
- 书签
- 便签
- 设置
- 同步

全部一起改，风险会很大。

当前这种拆法的好处是：

- 先把最敏感的认证搬到后端
- 保持现有功能尽量还能继续用
- 后面逐步迁移书签和便签

## 5. PostgreSQL 部署方案

当前仓库已经补了：

- [docker-compose.backend.yml](D:/DomoCodex/projects/NAV/docker-compose.backend.yml)
- [deploy-backend.sh](D:/DomoCodex/projects/NAV/scripts/deploy-backend.sh)
- [deploy-backend-oracle-jp.ps1](D:/DomoCodex/projects/NAV/scripts/deploy-backend-oracle-jp.ps1)

默认会启动：

- `nav-postgres`
- `nav-api`

默认端口：

- PostgreSQL：`127.0.0.1:5432`
- API：`127.0.0.1:3001`

说明：

- 这两个端口默认只绑定到服务器本机
- 对外仍然建议通过 `nginx` 反向代理访问

## 6. 当前建议的服务器接入方式

在 `oracle-JP` 上建议这样接：

### 前端

- 域名：`nav.skrskr.net`
- 静态文件：`/home/web/html/nav`

### 后端

- Fastify：监听 `127.0.0.1:3001`
- PostgreSQL：监听 `127.0.0.1:5432`
- nginx 为 `nav.skrskr.net` 增加：

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## 7. 启用后端认证模式的方式

服务器构建前端时，需要给前端加入：

```env
VITE_AUTH_MODE=backend
VITE_API_BASE_URL=/api
```

这样前端登录、注册、审批会走后端接口。

## 8. 下一步要继续做什么

后端第一阶段完成后，下一阶段建议做：

1. Telegram 后端化
2. 用户设置迁移到 PostgreSQL
3. 书签与分组迁移到 PostgreSQL
4. 便签与日记迁移到 PostgreSQL
5. Dexie 改成缓存层 / 离线层

## 9. 当前阶段的意义

这一步完成后，NAV 的性质会从：

- 纯前端本地测试版

变成：

- 有正式后端雏形的产品

虽然还不是最终商业版，但方向已经完全变了。
