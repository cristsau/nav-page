# DOMO NAV 剩余功能统一开发收口（2026-09-01）

## 1. 状态与边界

本文件记录 `codex/nav-complete-remaining-20260901` 本地集成候选。功能代码基线 `77e193f` 已完成
源码和本地自动化验证；尚未推送、创建 PR、合并、发布、迁移生产数据库、重建容器或启用
生产开关。邮件 P0 与迁移 `042`/`043` 已在此前进入 `origin/master`，但本次未读取生产，
其线上状态仍为 `NEEDS_LIVE_VERIFY`；本分支新增范围从邮件 P1、迁移 `044` 开始。

生产发布必须另行取得明确授权，并在精确 merge SHA 上依次通过 GitHub 全量 CI、canonical
备份、PostgreSQL 16 隔离恢复、迁移重复执行、最小容器重建、双域登录态与真实设备验收。

## 2. 本批完成的源码能力

### 邮件协议、翻译与运行保护

- 迁移 `044_email_protocol_reconciliation.sql`：保存远端 flags、modseq、UIDVALIDITY 和目录游标，
  支持 CONDSTORE/QRESYNC、VANISHED/expunge 对账及次级目录同步。
- `NAV_IMAP_PROTOCOL_RECONCILIATION_ENABLED=false` 与
  `NAV_IMAP_SECONDARY_FOLDER_SYNC_ENABLED=false` 默认关闭；关闭时不建立额外 IMAP 连接，也不做
  对账数据库查询。生产必须先验证 Provider 能力，再逐项启用。
- PDF、DOCX、PPTX、XLSX 只走有大小、页数、条目数和解压预算的无宏、无网络文本提取，提取
  结果仅用于用户主动触发的翻译，不持久保存附件原文或译文。
- 邮件 Worker 默认连接池和硬下限、等待计数观测、持续饥饿告警，以及发布前 retained backlog
  的精确身份快照门禁已补齐。
- 目录枚举只覆盖 subscribed 且 selectable 的目录；共享命名空间和虚拟搜索目录不作保证。
  次级目录为周期同步，不承诺与 INBOX 同级实时；fallback 权威扫描默认上限 20,000。
  Provider 不支持 QRESYNC/CONDSTORE 时必须验收 fallback，不能把原生扩展成功作为唯一结果。

### Notion 风格的关系数据库子集

- 迁移 `045_workspace_databases.sql`：数据库、属性、视图、记录与关系边结构。
- 支持表格/看板、属性编辑、筛选排序、归档恢复、关系及反向关系；所有关系边同时绑定
  `user_id`、源数据库、源属性、源记录、目标数据库和目标记录，避免跨用户或跨库串联。
- 当前接口明确返回 `limit/hasMore/truncated`，一次最多加载 5,000 条；界面会显示硬上限，
  不会把客户端筛选伪装成完整服务端搜索。

### AI 助理可确认写操作

- 迁移 `046_assistant_confirmed_operations.sql`：持久确认载荷、确认状态指纹、撤销前快照和执行后
  指纹。
- 对笔记、书签、分组、笔记分享、邮件草稿及数据库记录提供“生成预览 → 用户单独确认 →
  幂等执行 → 仅对可安全恢复操作提供限时撤销”。模糊或同时命中多个写目标的指令保持只读。
- 预览与确认绑定同一份资源状态；确认前在数据库行锁内重新计算指纹。资源、属性结构或草稿
  在预览后发生变化时拒绝执行，要求重新生成预览。
- 撤销在同一事务、同一锁顺序中比较执行后指纹；后续人工修改存在时拒绝覆盖。
- 邮件操作的参数、预览、用户提问和助理回显均使用邮件专用 AES-GCM 密文保存；普通列只留
  通用占位和布尔/枚举状态。密钥不可用时 fail closed，不降级写入正文、主题或收件人。
- 数据库写操作与普通 UI 使用相同的父库行锁顺序、position 规则、关系校验和父库更新时间。

原有明确创建日记、备忘录、书签和分组的低风险工具继续保持立即执行和 operation ID 幂等，
不会被静默改成确认流程。

## 3. 本地自动化验证结果

2026-09-01 在功能代码基线 `77e193f` 上已取得以下结果：

1. `cd api && npm test`：777 项通过、13 项跳过、0 失败。
2. `cd app && npm run build`：Vite 生产构建成功。
3. PostgreSQL 16 联合 runner：全部迁移从空库连续执行两次并通过 `verifyMigrations.js`；邮件
   17/17、关系数据库 4/4、AI confirmed-action 9/9。
4. AI 集成已证明：跨用户目标拒绝、重复确认只执行一次、取消/过期持久化、预览后资源变化
   拒绝、撤销 CAS 不覆盖后续人工修改、邮件队列同事务只入一条、敏感内容不出现在明文列，
   以及关系边/反向关系一致。
5. `git diff --check` 通过；最终文档提交后还需再次执行。

这些本地结果不得替代 GitHub CI 或生产验收。GitHub 仍须对最终提交重新执行全量 Node、
前端构建、Linux shell、迁移与 PostgreSQL 16 集成门禁。

## 4. 仍需外部配置或人工验收

以下不是缺少本批源码，无法在本地开发机上伪造完成：

- 真实 MXroute 账号的 QRESYNC/CONDSTORE 能力、次级目录、Sent APPEND、桌面/iPhone 收取与
  通知去重验收。
- `nav.skrskr.net` 与 `nav.cristsau.cn` 的 Passkey 分域登记及 Edge/iPhone 真机闭环。
- Google/微信身份登录及 Google/Microsoft 邮箱 OAuth 的开发者应用、回调登记、同意屏幕、
  Client Secret/Refresh Token 和真实登录。
- 用户选定对象存储后填写 S3/Restic Secret，完成首次远端快照、exact-ID 恢复和外部 dead-man。
- 浏览器扩展商店开发者账号、签名、提交与审核。
- PR、master CI、OVH 发布、迁移与生产开关启用；这些均需新的明确授权。

## 5. 有意保留的产品边界

- AI 写操作是 13 个固定白名单工具，不是可任意操作系统的自治智能体：笔记写入只支持普通
  未加密文本笔记，分组删除仅允许空分组；发送邮件确认后进入本地 outbox，不等于 SMTP 已
  投递；删除笔记和发送邮件不可撤销；模糊或多目标指令保持只读。
- 当前邮件撰写是安全纯文本和 DOMO NAV 服务端加密草稿；富文本 HTML 编辑与远端 Drafts/会话草稿同步是
  独立 Webmail 扩展，不在本批安全边界内。
- 数据库工作区当前支持 10 类属性及 table/board 两类视图，不含公式、rollup、日历或图库；
  也尚未提供第 5,001 条之后的服务端分页/筛选，当前以明确硬上限防止静默漏查。
- 附件提取不执行宏、脚本、OCR 或富媒体，不允许解析器联网。
- `npm audit --omit=dev` 仍报告 4 个无可用上游修复的高危依赖链告警，来源为
  `@huggingface/transformers` 间接使用的 `onnxruntime-node`/`adm-zip` 与 `sharp`；发布前须继续
  跟踪上游版本，并保持附件预算、进程隔离和不执行宏/脚本的运行时边界。

这些边界必须在界面和交接中如实说明，不能用“已有 UI”或“接口可调用”冒充完整外部闭环。
