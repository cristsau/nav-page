# DOMO NAV Status Report

最后更新：2026-08-01

## 生产基线

- GitHub：`cristsau/nav-page`（Private）
- 已合并 PR：[#8 codex/nav-responses-reasoning](https://github.com/cristsau/nav-page/pull/8)
- 生产提交：`cc1da6f72675108d9df243cab6affa116b32b4ff`
- API 镜像：`nav-api:cc1da6f72675108d9df243cab6affa116b32b4ff`
- 生产域名：
  - `https://nav.skrskr.net`
  - `https://nav.cristsau.cn`
- 发布证据：
  - `/opt/nav-releases/20260801-103458-cc1da6f72675108d9df243cab6affa116b32b4ff`
- 回滚基线：`5de3d75d91f840d3bb809be3fc8cd17d5dd219fb`

## 当前生产已完成

- 公开分享独立文章模板、统一暖色设计 token、设计化兜底图标、两行标题、
  首页层级、常用入口、手机操作菜单和单一创建入口。
- 图片附件、个人图床、iPhone/PWA 图标、双域 CORS、浏览器扩展和快速添加。
- 笔记/备忘录 AI、导航 AI 分析和标签、完整内容快速复制、结构化字段悬停复制。
- CLI Proxy 服务端托管配置；从 `/v1/models` 动态发现最多 6 个模型，自动选择
  最新稳定通用模型。2026-08-01 生产实测默认 `gpt-5.6-sol`，目录来源为 live。
- CLI Proxy 已显式使用 Responses API；推理强度与内置联网搜索参数均由 NAV
  服务端受控发送，设置页不再因 Chat Completions 兼容模式而禁用推理选项。
- 会话列表和单个/其他/全部撤销、一次性恢复码、密码恢复、恢复后撤销全部会话。
- 登录、注册、恢复和已认证写操作限流；可信代理仅允许现场核对的精确地址。
- 不含 API Key、Telegram Token、密码验证器和未知设置的云端 JSON 数据导出。
- 全站 `Cmd/Ctrl+K` 命令面板、触屏入口、焦点循环和 reduced-motion 支持。
- Vite `6.4.3`、Node 24 CI、API Docker `npm ci`、Docker 构建上下文秘密排除。
- `011_account_recovery.sql` 已受控执行并核对列、表、约束和索引定义。

## 发布与验收证据

- PR 最终分支提交：`a9ee0e031a6d26dc7feff20e59377fe1cb07fe00`。
- Push 与 PR 两次 GitHub Actions 均通过。
- OracleJP 干净 release 目录复验：
  - 前端依赖审计：0 vulnerabilities；
  - API 依赖审计：0 vulnerabilities；
  - API 测试：165 / 165；
  - Vite 6.4.3 生产构建：通过；
  - 固定 SHA API 镜像构建：通过。
- 两个域名的首页、设置、API 健康和当前 JS 资源均返回 200。
- 两个方向的 CORS Origin、Credentials 和 `Vary: Origin` 均通过。
- 会话、模型目录和导出接口在未登录状态均返回 401。
- 无效分享返回 404，并带 `private, no-store` 和 `noindex`。
- API 真实数据库 `SELECT 1`、迁移记录和恢复表存在性通过。
- API 切换后重启计数 0、5xx 计数 0、致命错误计数 0；Nginx 配置未改、未 reload。
- 所有 npm 操作均在 GitHub Actions 或 OracleJP 独立 release 目录执行，未在个人电脑运行。

## 备份与恢复

- 发布前备份：`/var/backups/nav/nav-20260801T023353Z-05e4dca822a0`。
- 发布前恢复报告：
  `/var/backups/nav-rehearsal-reports/nav-20260801T023353Z-05e4dca822a0-20260801T023402Z.tsv`。
- 发布后备份：`/var/backups/nav/nav-20260801T024559Z-05e4dca822a0`。
- 发布后恢复报告：
  `/var/backups/nav-rehearsal-reports/nav-20260801T024559Z-05e4dca822a0-20260801T024609Z.tsv`。
- 两次均通过精确树、校验和、`pg_restore` 目录、无网络隔离恢复、完整表集合、
  全表行数和迁移记录比对；临时容器已清理，生产容器和 volume 未被恢复演练触碰。
- 稳定入口已安装：
  - `/usr/local/sbin/nav-backup`
  - `/usr/local/sbin/nav-restore-rehearsal`
  - `/etc/nav/nav-backup.env`
- 当前没有启用计划任务、云上传、远端删除或失败报警。

## 仍需用户登录验收

这些操作需要用户密码、恢复码或两个真实外网客户端，自动化发布没有代替用户执行：

1. 电脑和手机分别经两个域名登录，确认“账户安全”中的会话 IP 不相同。
2. 生成恢复码并离线保存；用可丢弃账号验证一枚恢复码只能使用一次。
3. 打开 AI 模型下拉框，确认“自动最新”为 `gpt-5.6-sol`，再执行一次低成本 AI 操作。
4. 下载一次完整 JSON 导出，确认页面提示包含分享链接/密文但不包含图片二进制。
5. 验收 `Cmd/Ctrl+K`、触屏命令入口、会话撤销和手机菜单。

## 仍未完成

- 真正的 R2/restic 异地上传：缺 bucket-scoped R2 凭据和独立 restic 密码文件。
- Telegram 失败报警和外部 dead-man：缺专用 Bot 凭据与监控端点。
- CLI Proxy 独立 NAV client key：生产当前使用已有有效 client key。
- Passkey/WebAuthn：需确定唯一 RP ID，推荐 `nav.skrskr.net`。
- 到期提醒、失效链接检查、书签拖拽和批量操作。
- NAV 图片库、图片引用检查和无引用后的图床物理删除；当前长期 Token 仍为
  upload-only，从笔记移除图片仍只解除引用。
- PostgreSQL 中文检索、BM25/模糊检索、向量语义搜索和带来源统一 AI 助理。
- 图床 R2 对象和外层 Nginx Proxy Manager 配置的独立备份与恢复演练。
- Notion 式编辑器大重构继续保持最后评估。

## 发布经验

- `/opt/nav` 是含生产专属文件的长期工作树，禁止用 `git reset`、`git pull` 或清空目录发布。
- 旧一键部署脚本不覆盖完整备份、API 固定镜像、迁移和回滚，不作为当前生产发布入口。
- Windows `core.autocrlf=true` 会使本地归档出现 CRLF；发布包必须固定 LF，并在服务器按字节复核。
- 正常应用回滚切回旧固定镜像、旧环境和旧前端，但保留加法迁移 011；不得恢复整库覆盖发布后的新写入。
