# DOMO NAV Status Report

最后更新：2026-07-31

## 生产基线

- GitHub：`cristsau/nav-page`
- 已合并 PR：`#5 codex/nav-share-ui-convergence`
- 生产提交：`ff561376642b91030fe7318a6ff7a537f3664d9c`
- 生产域名：
  - `https://nav.skrskr.net`
  - `https://nav.cristsau.cn`
- API 镜像：`nav-api:ff561376642b91030fe7318a6ff7a537f3664d9c`
- CLI Proxy API：`eceasy/cli-proxy-api:v7.2.111`
- 发布证据目录：
  - `/opt/nav-releases/20260731-172559-ff561376642b91030fe7318a6ff7a537f3664d9c`

本次生产发布前已备份前端、Compose、API 环境文件、Nginx 配置和 PostgreSQL。
校验和、`pg_restore -l`、独立 PostgreSQL 恢复演练均通过，回滚脚本已保留。
两个域名的首页、设置页、API 健康检查、CORS 和公开分享错误页均已验收。

## 当前生产已完成

- 公开分享页采用独立文章模板，不显示内部“备忘录”类型和浏览计数。
- 首页与笔记页统一暖色设计 token。
- 兜底图标、两行标题、首页层级、常用入口已重做。
- 手机端书签操作菜单和单一创建入口已完成。
- 图片附件、个人图床、iPhone/PWA 图标、双域 CORS、OpenClaw 退役已完成。
- 导航、笔记、日记、分享、AI 操作、快速复制、结构化字段复制和浏览器扩展继续可用。

## 下一阶段候选

分支：`codex/nav-ai-vite-security`

状态：仅本地候选，尚未提交、推送、创建 PR 或发布生产。

候选包含：

- Vite 固定到 `6.4.3`，esbuild 升到修复版本，开发服务器仅监听
  `127.0.0.1`，Telegram 开发代理默认关闭。
- GitHub Actions 使用 Node 24，并对前后端执行 `npm audit --audit-level=moderate`。
- CLI Proxy 模型目录动态发现，默认“自动最新”，最多显示 6 个模型。
  自动选择会排除 mini/nano、preview/beta、日期快照、Codex、音频、图像等非通用模型。
- CLI Proxy API Key 只从只读 owner-only 文件读取，拒绝符号链接和打开过程换文件。
- 会话列表和单个/其他/全部会话撤销。
- 一次性恢复码、密码恢复、恢复后撤销全部会话。
- 登录与密码恢复通过用户行锁串行，避免旧密码并发登录留下新会话。
- 登录、注册、恢复和已认证写操作限流；用户名和限流键有固定长度边界。
- 云端数据 JSON 导出，不导出 API Key、Telegram Token、密码验证器和未知设置；
  图床二进制对象不包含在 NAV 导出中。
- `Cmd/Ctrl+K` 命令面板、触屏入口和可访问焦点循环。
- 一致性 PostgreSQL 快照备份、严格树/校验和验证、隔离恢复演练、
  restic 加密异地上传双闸门和失败报警运行手册。

## 候选验收证据

所有 npm 操作均在 OracleJP 的隔离 `/tmp` 目录执行，未在个人电脑运行 npm。

- 前端依赖审计：0 vulnerabilities
- API 依赖审计：0 vulnerabilities
- API 测试：163 / 163
- 前端生产构建：Vite 6.4.3，通过
- 备份脚本 Linux 实测：通过
- 隔离 PostgreSQL 恢复：
  - public 表集合：11 / 11
  - 全部表行数：一致
  - `schema_migrations`：完全一致
- 临时源码、依赖、数据库副本和恢复容器：已删除

## 下一次生产发布门槛

发布候选前必须重新取得明确授权，并完成：

1. 提交、推送候选分支，创建 PR，由 GitHub Actions 再跑一次相同检查。
2. 生产发布前重新备份，并保留现有回滚版本。
3. 配置服务端 CLI Proxy Base URL 和 API Key 文件挂载。
4. 现场复核 Docker 网关和外层代理 IP。当前观测值是 Docker 网关
   `172.19.0.1`、外层 NPM `45.143.234.47`；发布时必须重新确认后再精确写入
   `TRUSTED_PROXY_ADDRESSES`。
5. 执行迁移 `011_account_recovery.sql`，发布 API 和前端。
6. 用两个真实外网客户端分别经两个域名验收会话 IP、限流、登录、恢复码、
   AI 模型发现和数据导出。

## 仍未完成

- R2/restic 真正异地上传：缺少 bucket-scoped R2 凭据和独立 restic 密码文件。
- Telegram 失败报警和外部 dead-man：缺少专用 Bot 凭据与监控端点。
- CLI Proxy 独立 NAV client key：当前准备好的文件使用现有有效 client key；
  创建独立 key 需要 Management Center 写权限或一次另行授权的短重启。
- Passkey/WebAuthn：需先确定 `nav.skrskr.net` 为唯一 RP ID，或统一双域登录入口。
- 到期提醒、失效链接检查、书签拖拽和批量操作。
- PostgreSQL 中文检索、BM25/模糊检索、向量语义搜索和带来源统一 AI 助理。
- Notion 式编辑器大重构，继续保持最后评估。
- 图床 R2 对象本身、外层 Nginx Proxy Manager 配置的独立备份与恢复演练。
