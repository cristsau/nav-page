# NAV Dropbox 备份候选：上线前必读

归属：个人。包含管理员工具和只读网页状态候选；不是完整云备份服务。
唯一验收状态仍看仓库 `CURRENT.md`。不得在生产上直接试跑测试文件。

## 范围与原理

### 只读状态与备份记录

- `status <config.json>`：仅本地检查，输出不含密钥、OAuth、账号邮箱、绝对路径、远端 ID/revision 的白名单报告。不会刷新 OAuth、访问 Dropbox、上传、清理或开启任务。
- `publish-status <config.json> <integration-directory>`：在持有 canonical 备份锁期间，以 0600 原子替换目录中的 `dropbox-status.json`。目录及全部父级必须为 root 所有、无软链接且不可被其他用户写入，目标目录为 0700；目标文件如已存在也须满足私有文件校验。失败保留前一份报告，不能据旧报告声称当前成功。
- API 仅在既有管理员 `GET /api/admin/integrations` 中返回 `dropboxBackup` 白名单；非管理员不能读取。它从 `NAV_MANAGED_INTEGRATIONS_DIR` 中读报告，不读 root 台账或 Dropbox 凭据、不执行主机命令。报告超过 30 分钟标注过期，缺失、损坏、异常尺寸、硬链接/软链接均不能作为正常状态。
- “服务器清单已检查”“已上传”“下载已校验”“恢复已验证”分别展示。台账字节数不等于实时网盘用量；附件原件仍以 canonical 清单为准。`allowUpload` 不证明任务运行，服务器状态报告也不能证明独立离线钥匙已保存。
- 本批没有网页立即备份/下载/恢复按钮，没有定时服务安装器，也不开放完整 Dropbox 网盘浏览。部署者应通过受控主机任务刷新报告；本候选不自动改现有备份任务，刷新网页也不会触发备份。

- 保留现有 `scripts/nav-backup.sh` 的 PostgreSQL custom-format dump 和 canonical 快照。
  新工具只接受其直接子目录 `nav-<UTC>-<commit>`，先核对 manifest 中所有文件，再核对 canonical `metadata/tree.tsv` 的完整路径集合、类型、权限和链接目标。
  备份根及快照必须 root 私有。允许原文件属主以及清单内、最终仍指向快照内部的合法符号链接；归档不跟随链接。拒绝额外文件、外逃/变更链接、硬链接、跨设备和非普通对象，不能跳过检查。
- 复用 `/run/lock/nav-backup.lock`，串行进行本地快照读取、上传及台账更新，避免与现有备份/恢复/清理同时运行。
  必须只有一个备份写入主机；不支持多台机器并发写同一 App Folder，不能把本机锁宣称为跨机器锁。
- 标准 `tar → age(X25519 public recipient) → Dropbox upload session` 流式处理。
  生产源站不额外落地完整 tar 或密文；每块至多 4 MiB，只有 tar 与 age 全部退出成功后才允许提交。
  使用维护中的 age 标准格式，不自创加密容器。源站只需要公钥，解密私钥不交给上传主机。
- Dropbox 使用已授权的同一个 App Folder / 账号 / 四项 scope；固定官方 HTTPS 主机、关闭重定向，refresh 后再次核对账号。
  严格新增文件，不覆盖/改名碰撞。上传后对照 content_hash，再下载精确 revision 计算整个 SHA256 与 content_hash。
- `uploaded`、`download_verified`、`restore_verified` 必须分开。
  本候选不会自动写入 `restore_verified`，下载哈希通过不是解密或 PostgreSQL 恢复验收。

## 容量与保留

- 专用 App Folder 总预算 **5,000,000,000 bytes（5 GB，十进制）**，所有可见文件均计入，包括未知文件。
- 最多 **3 个已提交备份**；首版单次流式上传预留上限 **1,000,000,000 bytes**。
  预留包含 tar/age 开销，生成量超过预留则停止并留待对账，不越界提交。
- 网络写入前必须先持久化 pending 全额预留；失败或结果不明后不按时间自动“释放”。有 pending 即阻止新上传，必须根据远端实际状态处理。
- 超预算、已有三份、远端 revision/hash 变化或陌生备份出现时暂停，不先删除数据腾位置。
- 云端 `retention-plan` 只生成建议，至少保护最近两份和最新一份独立恢复验收通过的备份。**没有云端删除命令**；云端滚动保留仍待单独安全实现和验收。

### 服务器本地：只保留最新 3 份

此策略与上述 Dropbox 5 GB/3 份云端预算完全独立。配置 `allowLocalPrune: true` 后，成功上传并下载校验的 `backup` 会自动执行本地清理；也可以在现有 canonical 备份成功后单独调用 `prune-local`，后者不需要 Dropbox 凭据、不受云端容量限制。

- 按 canonical 快照名称中的 UTC 时间排序，保留最新三份；支持真实服务器使用的 `nogit` 后缀，不依赖可变化的目录修改时间。
- 删除之前先校验全部拟保留与删除的快照完整性；缺文件、损坏、未登记/越界/变更的链接、硬链接、跨设备/嵌套挂载、未完成快照、时间冲突或并发备份均阻止清理。不是以文件夹数量代替备份有效性，也不等于数据库恢复验收。
- 只删除已验证备份根目录下的精确直接子目录；未知文件不删除。每次删除前再次检查最新三份及目标身份/清单。
- 不再附加“超过 30 天”条件。新备份完成前最多短暂存在第四份；失败时宁可暂时超过三份，也不先删旧份腾空间。
- 删除旧本地目录不可撤销；云端文件不变，但不承诺每个旧本地版本已在云端留存。生产首次开启前需列出当时精确清理清单并确认；配置样例仍默认关闭，复制代码不自动改生产设置。
- 上传失败不会触发其后置清理；独立本地备份流程可在自身成功后调用 `prune-local`。成功上传但清理受阻会单独返回 `LOCAL_RETENTION_BLOCKED`，不要求重传已提交备份。

## 数据覆盖与灾备边界

上传内容以选中的 canonical 快照及其 `metadata/disaster-components.tsv` 为准。
数据库中的附件/图片链接不是文件本体；默认未开启原件备份时，绝不能把本次称为“所有附件/图片可恢复”。
该格式保留现有快照结构，未来隔离解密/解包后仍须运行现有 canonical 校验与 PostgreSQL 恢复演练。
解密必须先写入隔离私有临时区并等 age 验证成功，不能在 age 尚未校验结束时直接管道解包到可信目录。
正式恢复还需 tar 路径/链接安全检查、完整 NAV 数据验证、恢复回执与操作者验收，本候选没有自动生产恢复入口。

`ledger.json` 保存备份 ID、revision、密文哈希和状态，不保存 OAuth 秘密或原始数据。
正式上线还要安排台账恢复与专用解密私钥的离线备份；DPAPI OAuth 文件不是加密备份的恢复密钥。
台账丢失时停止自动任务，不把一个空台账覆盖已有云端状态。仍可手工从专用 Dropbox 文件夹下载 age 文件，在隔离环境配合独立私钥验证恢复；不能在尚未演练时宣称这条路径通过。

## 受控安装后才可使用的入口

前提：Linux root、Node 22+、`/usr/bin/age`、`/usr/bin/tar`、`/usr/bin/flock`；不是 Windows 启动器。可通过 root 私有配置的 `ageExecutable` 指定独立安装的 age；它及上级目录必须 root 所有、无符号链接且不可由组/其他用户写入。
安装与生产密钥交接本轮没有执行；不要将 Windows DPAPI 文件直接复制成 Linux JSON。
`backup-config.example.json` 默认 `allowUpload: false`。真实配置/连接文件需 root:root 0600、无符号链接，状态目录 0700；脚本不会自动放宽不安全目录权限。

安装目录确认后，以其中 `backup-cli.mjs` 的绝对路径代替以下 `<agent>`：

```text
node <agent> init-local /etc/nav/dropbox-backup.json
node <agent> list /etc/nav/dropbox-backup.json
node <agent> plan /etc/nav/dropbox-backup.json /var/backups/nav/nav-<UTC>-<commit>
node <agent> backup /etc/nav/dropbox-backup.json /var/backups/nav/nav-<UTC>-<commit>
node <agent> download /etc/nav/dropbox-backup.json <backup-id>
node <agent> retention-plan /etc/nav/dropbox-backup.json
node <agent> local-retention-plan /etc/nav/dropbox-backup.json
node <agent> prune-local /etc/nav/dropbox-backup.json
```

`init-local` 只新建台账且拒绝覆盖；`list`/`retention-plan` 不联网；`plan` 会读取专用 App Folder，但不上传。
`backup` 还需受管配置显式允许；`download` 仅下载校验密文，检查本机剩余空间且不覆盖既有下载。
`local-retention-plan` 只校验并列出本地保留/清理对象；`prune-local` 需要 `allowLocalPrune: true`。本地操作同样持有 canonical 锁，不能与备份/恢复并发；不要同时启用旧 `nav-backup.sh --prune-local` 的另一套保留策略。
没有 systemd/cron 安装器、生产恢复、云端自动删除、网页 UI、用户级备份或全盘 Dropbox 管理。

## 测试与发布门禁

1. `node --test scripts/dropbox/backup.test.mjs`：18 组纯合成/假凭据测试。远程账号和文件 API 均为 mock。
2. `backup-linux.test.mjs`：待批准的临时 Linux 环境中，使用一次性 age 密钥、两个无网络 PostgreSQL 16 容器，验证真实加解密、篡改拒绝、pg_dump/pg_restore 与行内容一致，以及 canonical 锁和 CLI 防覆盖。
   仅当 `NAV_DROPBOX_DISPOSABLE_TEST=1` 才运行。它仍不等于完整 NAV 业务恢复或真实 Dropbox 云恢复。
3. `local-retention.test.mjs` 验证最新三份、损坏拒绝、边界保护及 Linux 合成目录的真实清理。`.github/workflows/dropbox-backup.yml` 仅用于已授权的独立测试分支及 Actions 临时环境。只读仓库权限、无账号秘密、无业务数据、无部署步骤、不上传备份或密钥。
4. 合成 Linux 通过后，再提出精确生产配置交接、专用恢复密钥离线保管、最小真实云往返与独立恢复方案，获得授权后执行。
5. 真实下载、age 解密、完整 NAV 隔离恢复及回执通过之前，不允许启用自动备份。

官方依据：[Dropbox content_hash](https://docs.dropboxapi.com/dropbox-api/docs/technical-reference/content-hash)、
[Dropbox upload sessions](https://dropbox.github.io/dropbox-sdk-js/Dropbox.html#filesUploadSessionStart)、
[age 标准工具](https://github.com/FiloSottile/age)。
