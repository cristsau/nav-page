# DOMO NAV Status Report

最后更新：2026-08-24

本页区分 `VERIFIED_LIVE`、`PARTIAL` 和 `UNFINISHED`。仓库中存在脚本或代码，不等于生产
已经安装、启用或形成灾难恢复闭环；每次发布前仍须重新读取 GitHub、OVH 与双域状态。

## 当前源码与生产基线

- GitHub：`cristsau/nav-page`（Private），默认分支 `master`。
- 2026-08-23 最后完成生产验收的 merge SHA：
  `25c9c133ad6c34b857cf13c293aa5a89c8ef04d7`（PR #34）。当前 `origin/master` 必须现场核验。
- 当前生产源码包含的连续 PR：
  - [#28 发布文档校准](https://github.com/cristsau/nav-page/pull/28)
  - [#29 异地备份调度候选](https://github.com/cristsau/nav-page/pull/29)（源码已包含，运行环境仍为
    `NOT_CONFIGURED / NOT_ENABLED`）
  - [#30 图片删除重试告警正确性](https://github.com/cristsau/nav-page/pull/30)
  - [#31 云端恢复防误操作门禁](https://github.com/cristsau/nav-page/pull/31)
- 已在此前发布的应用 PR：
  - [#26 有界后台维护](https://github.com/cristsau/nav-page/pull/26)
  - [#27 后台任务可观测性](https://github.com/cristsau/nav-page/pull/27)
- 最新合并并发布的应用 PR：
  - [#32 维护通知投递与 PostgreSQL 集成门禁](https://github.com/cristsau/nav-page/pull/32)
  - [#33 一次性管理员与发布验收门禁](https://github.com/cristsau/nav-page/pull/33)
  - [#34 主机 CIDR 精确验收修复](https://github.com/cristsau/nav-page/pull/34)
- 当前 OVH release：`/opt/nav-stack/releases/20260823-233024-25c9c13`。
- 当前 API 镜像：`nav-ovh-api:25c9c133ad6c34b857cf13c293aa5a89c8ef04d7`。
- 应用回滚目标：上一 release `/opt/nav-stack/releases/20260823-191619-9b05013`，提交
  `9b0501389de797c99ec646103780b4b83aa4be56`；迁移 018 为加法迁移，应用回滚时保留。
- 生产域名：
  - `https://nav.skrskr.net`
  - `https://nav.cristsau.cn`
- 2026-08-23 只读复核：双域首页与 `/api/health` 均为 200，API/Web/PostgreSQL 健康；
  CLIProxyAPI、Nginx Proxy Manager、Vaultwarden 和 Komari 保持运行。

PR #30 的图片删除重试告警正确性、PR #31 的云端安全恢复、PR #32 的 Telegram 精确目标
投递与独立 PostgreSQL 16 维护演练，以及 PR #33/#34 的一次性管理员发布验收生命周期与
主机 CIDR 精确校验，均已进入上述生产 SHA 并完成验收。当前状态为 `VERIFIED_LIVE`。当前
仓库分支可能在本文提交后继续前进，不能用本快照替代 Git 现场核验。

一次性管理员工具已在首次生产发布中完成 `status=PASS / cleanup=PASS`。临时账号、marker 与
`/run/nav-release-acceptance.*` 私有目录均清零；真实管理员长期密码没有进入 release，也未被
该生命周期读取或修改。

## 当前生产已完成

### UI、分享与移动端

- 七套内置配色（含 Linear）与自定义主题、亮/暗/跟随系统、刷新持久化。
- 统一设计 token、辅助文字对比度门禁、统一桌面/手机主导航与设置六分类。
- 路由进度、启动骨架、Session single-flight/内存复用、页面可见时后台复验和统一 401 失效。
- 弹窗焦点、Esc、ARIA、标签、44px 触控尺寸、长表单固定头尾与手机操作菜单。
- 公开分享独立文章模板；`nav.skrskr.net` 为 canonical，双域继续支持应用登录。

### 导航、搜索、笔记与提醒

- 分组与书签增删改、拖拽排序、多选、批量移动/删除、常用入口、两行标题和兜底图标。
- 手动失效链接检查并保存最近状态。
- 首页统一搜索书签、未加密笔记和 Web；搜索引擎后台支持增删改。
- 备忘录、日记、数字 ID、快速复制、结构化字段悬停复制、截止时间和到期提醒中心。
- 命令面板支持页面跳转、新建书签/备忘录/日记、提醒与站内搜索。
- 导航 AI 分析/标签和笔记 AI 摘要、润色、续写与编辑辅助。

### 图片库与图床生命周期

- 图片经 NAV 服务端上传到个人图床；浏览器不接触 Token，NAV 不持久化图片二进制。
- 上传与库管理双 Token 按同一目录最小权限分离，并由 release-local Secret 只读挂载。
- `/media` 支持瀑布流、搜索、游标分页、引用、保留策略、分享、删除、对账和失败重试。
- 移除最后引用后只清理 `retention=auto` 图片；删除前重新校验引用，结果按物理删除、
  仅解除引用、legacy 和缓存状态持久化并给出保守提示。
- 加密笔记禁止向公开图床上传图片。

### AI、账号与安全

- CLI Proxy Responses API、动态 `/v1/models` 目录、最多六个候选、“自动最新”、推理强度和
  内置联网搜索；密钥仅由服务端 owner-only Secret 提供。
- 注册审批、Telegram 通知/同步、用户名与密码修改、会话查看/撤销、一次性恢复码和密码恢复。
- 登录、注册、恢复、已认证写操作和 AI 使用 PostgreSQL 原子共享限流。
- 安全审计保存最小化结构化字段和带密钥摘要，支持筛选、分页、CSV/JSON 导出和受控删除。
- 分层审计保留：常规成功 90 天、拒绝/失败 180 天、恢复/账号/管理员敏感操作 365 天。
- API 日志凭据脱敏；API/PostgreSQL 容器日志有大小、数量和压缩上限。

### 后台维护与告警

- 迁移 017 的有界安全审计清理与图片删除失败退避重试已启用；跨副本使用 advisory lock。
- 迁移 018 的 `maintenance_job_status` 固定保存两行任务状态，不随运行次数增长。
- 两个任务已完成成功运行，连续失败为 0；设置页默认折叠并按需读取状态。
- Telegram 目标已通过明确标注的测试消息；运行内告警已启用，连续失败阈值为 3，冷却为
  21600 秒，恢复后通知一次。
- 运行内告警无法报告 OVH 主机、容器、网络或调度器整体离线，仍需主机外 dead-man。

## 最新生产发布与恢复证据

- PR #33 与 #34 已合并；最终 `master` CI `32648707198` 的 `test-and-build`、
  `release-acceptance-postgres-integration`、`restore-postgres-integration` 与
  `maintenance-postgres-integration` 四项均成功。
- 源码归档 SHA-256 在 OVH 解包前核验；API 与 Vite 在隔离构建容器中构建。
- 发布前 PostgreSQL 备份在无网络临时 PostgreSQL 16 中恢复为 17 张表、17 条迁移；本次
  没有新迁移，新 API 镜像的只读迁移校验通过。
- 加法迁移 `018_maintenance_observability.sql` 保持已应用并固定写入两条任务状态。
- 本次只重建 `nav-api`；`nav-web`、PostgreSQL、CLIProxyAPI、NPM、Vaultwarden 和 Komari
  容器 ID 均保持不变，API 健康且重启计数为 0。
- 双域通过健康、精确前端、CORS、登录会话、后台状态、缓存和退出验收。
- 发布后备份同样在无网络临时 PostgreSQL 16 中恢复为 17 张表、17 条迁移。
- 一次性管理员创建、登录、会话和精确清理通过；发布后临时账号、marker 与运行时私有目录
  均为 0。
- 脱敏验收证据保存在当前 OVH release 的受限 `evidence` 目录；文件包括
  `FINAL_ACCEPTANCE.txt`、`BACKUP_RESTORE_ACCEPTANCE.txt` 和
  `POST_BACKUP_RESTORE_ACCEPTANCE.txt`，以及不含凭据的
  `ACCEPTANCE_ACCOUNT_LIFECYCLE.txt`。

## 备份与恢复现状（PARTIAL）

- 仓库已有 `scripts/nav-backup.sh`、`scripts/nav-restore-rehearsal.sh`、环境示例和
  `docs/NAV_BACKUP_RUNBOOK.md`；受控发布会做发布前后备份与隔离恢复演练。
- 仓库已补充三组默认不启用的 systemd 调度模板、独立 `OnFailure` 通知、只在成功后发送的
  双 dead-man 心跳、最新备份选择器和只安装不启用的部署脚本；生产配置和现场验收完成前
  状态仍是 `SOURCE_READY / NOT_DEPLOYED`。
- 2026-08-23 OVH 只读核验确认：未安装 `restic`，没有 NAV/restic systemd unit 或 timer，
  也没有 `/etc/nav/nav-backup.env`、`/etc/nav/restic-r2.env` 和 `/usr/local/sbin` 稳定入口。
- 因此当前没有自动计划、异地加密上传、远端保留清理、备份失败外部报警或定期恢复演练。
- 图床对象和外层代理配置尚未纳入独立、可在干净环境验证的完整生态恢复。

## 其他部分完成

- 到期提醒只在打开 NAV 时同步；没有提前、离线、系统推送或 Web Push。
- 链接检查由用户手动触发；没有后台定时扫描、集中失效清单和自动复查。
- 命令面板覆盖主要页面、创建和搜索；尚不能直接切换主题或 AI 模型。
- 安全 JSON 导入导出可用；尚无 Chrome/Edge 书签 HTML、Markdown 批量导入导出与一键
  完整生态恢复。
- PWA 元数据和主屏幕图标可用；尚无完整 Service Worker、离线缓存和推送。
- 云端 JSON 恢复的密码二次确认、只读差异预览和替换边界已随 PR #32 发布；图床对象、
  外层代理和超过 5,000 条记录的分片/流式恢复仍不在该能力内。

## 仍未完成

1. 为 OVH 配置并验收自动异地加密备份、远端保留策略、定期隔离恢复、失败报警与外部 dead-man。
2. 唯一 RP ID 决策后的 Passkey/WebAuthn。
3. 提前/离线提醒与定时失效链接检查。
4. PostgreSQL 中文 BM25、错别字模糊匹配、向量语义检索和带来源的个人数据助理。
5. AI 用量/成本面板。
6. 最后再评估块编辑器、自动保存和版本历史的大重构。

## 仍建议用户手工验收

1. 电脑和手机分别经两个域名登录，确认会话设备与来源符合预期。
2. 生成恢复码并离线保存；用可丢弃账号确认一枚恢复码只能使用一次。
3. 下载一次完整 JSON 导出，人工确认恢复范围和页面提示。
4. 在真实 iPhone/触屏设备验收书签菜单、命令入口、提醒中心和图片库操作。
5. 首次使用账号修改或审计删除时，以单条、可回退方式人工确认。

## 发布边界

- 生产只发布通过 CI 的精确 merge SHA，并使用独立 release 目录。
- 每次生产发布先备份、隔离恢复，再迁移、切换、双域验收，最后做发布后恢复演练。
- Secret 不进入 Git、文档、镜像、前端或日志。
- 后续生产登录态验收必须使用随机一次性管理员；真实管理员长期密码不得进入 release。
  候选 SHA 必须先包含并通过一次性账号工具的 CI，账号生命周期、自动清理和硬中断恢复门禁见
  [`docs/NAV_PRODUCTION_RELEASE_ACCEPTANCE.md`](./docs/NAV_PRODUCTION_RELEASE_ACCEPTANCE.md)。
- 生产数据库写入、定时器启用、凭据安装、DNS/代理修改、容器重建、服务重启和删除均需
  单独列出影响、备份、回滚与验收，并取得明确授权。
