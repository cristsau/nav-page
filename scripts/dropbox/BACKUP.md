# NAV Dropbox 备份候选：上线前必读

归属：个人。包含管理员工具和只读网页状态候选；不是完整云备份服务。
唯一验收状态仍看仓库 `CURRENT.md`。不得在生产上直接试跑测试文件。

## 范围与原理

### 只读状态与备份记录

- `status <config.json>`：仅本地检查，输出不含密钥、OAuth、账号邮箱、绝对路径、远端 ID/revision 的白名单报告。不会刷新 OAuth、访问 Dropbox、上传、清理或开启任务。
- `publish-status <config.json> <integration-directory>`：在持有 canonical 备份锁期间，以 0600 原子替换目录中的 `dropbox-status.json`。目录及全部父级必须为 root 所有、无软链接且不可被其他用户写入，目标目录为 0700；目标文件如已存在也须满足私有文件校验。失败保留前一份报告，不能据旧报告声称当前成功。
- API 仅在既有管理员 `GET /api/admin/integrations` 中返回 `dropboxBackup` 白名单；非管理员不能读取。它从 `NAV_MANAGED_INTEGRATIONS_DIR` 中读报告，不读 root 台账或 Dropbox 凭据、不执行主机命令。报告超过 30 分钟标注过期，缺失、损坏、异常尺寸、硬链接/软链接均不能作为正常状态。
- “服务器清单已检查”“已上传”“下载已校验”“恢复已验证”分别展示。台账字节数不等于实时网盘用量；附件原件仍以 canonical 清单为准。`allowUpload` 不证明任务运行，服务器状态报告也不能证明独立离线钥匙已保存。
- 本备份模块尚无网页立即备份/下载/恢复按钮或定时服务安装器。独立 Full Dropbox 文件管理已由文件库模块提供，不复用本模块的 App Folder 凭据。部署者通过受控主机任务刷新报告；刷新网页不会触发备份。
- 网页保留计划只展示台账估计：待轮换 ID、保护范围和暂停原因。新报告增加 `cloud.pruneConfigured/pendingDeletes/retention`，旧报告仍兼容，但缺少计划时明确未知；不把配置标志当作已运行的任务。

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
- 超预算、远端 revision/hash 变化、陌生备份或未核对操作出现时暂停。默认已有三份也暂停；只有显式开启 `allowCloudPrune` 且已有有效恢复回执，才允许受控轮换。
- `retention-plan` 仍只生成建议。新增 `prune-cloud` 持有 canonical 锁，普通清理保留至多三份；`backup` 在源快照和加密工具通过检查后，必要时先为下一份预留一格，再上传。始终保留最新两份和最近一份独立恢复验证成功的备份；如果三份均被保护则暂停，不为满足数量而删除恢复证明。
- 新增 `pendingDeletes` 持久日志：每次调用删除前先落盘精确 ID/revision；云端再次核对后才移除台账记录。丢回执、保存失败或云端变化会保留阻断标记，后续上传/清理暂停，绝不自动重试或按时间清空。仅使用 App Folder 应用的普通 `delete_v2`，携带 `parent_rev`，不永久删除；可恢复时间由 Dropbox 账户保留规则决定，不承诺可撤销。
- 生产自动清理和定时开关本轮未开启。用户指定开发优先，真实恢复演练与项目总验收最后进行；此顺序不阻止继续编写和合成测试管理功能。

### 服务器本地：只保留最新 3 份

此策略与上述 Dropbox 5 GB/3 份云端预算完全独立。配置 `allowLocalPrune: true` 后，成功上传并下载校验的 `backup` 会自动执行本地清理；也可以在现有 canonical 备份成功后单独调用 `prune-local`，后者不需要 Dropbox 凭据、不受云端容量限制。

- 按 canonical 快照名称中的 UTC 时间排序，保留最新三份；支持真实服务器使用的 `nogit` 后缀，不依赖可变化的目录修改时间。
- 删除之前先校验全部拟保留与删除的快照完整性；缺文件、损坏、未登记/越界/变更的链接、硬链接、跨设备/嵌套挂载、未完成快照、时间冲突或并发备份均阻止清理。不是以文件夹数量代替备份有效性，也不等于数据库恢复验收。
- 只删除已验证备份根目录下的精确直接子目录；未知文件不删除。每次删除前再次检查最新三份及目标身份/清单。
- 不再附加“超过 30 天”条件。新备份完成前最多短暂存在第四份；失败时宁可暂时超过三份，也不先删旧份腾空间。
- 删除旧本地目录不可撤销；云端文件不变，但不承诺每个旧本地版本已在云端留存。生产首次开启前需列出当时精确清理清单并确认；配置样例仍默认关闭，复制代码不自动改生产设置。
- 上传失败不会触发其后置清理；独立本地备份流程可在自身成功后调用 `prune-local`。成功上传但清理受阻会单独返回 `LOCAL_RETENTION_BLOCKED`，不要求重传已提交备份。

## 数据覆盖与灾备边界

开启 `NAV_ENABLE_ATTACHMENT_ORIGINALS` 后，`image-originals.mjs` 从一致性数据库快照中提取笔记/图库引用，仅抓取允许图床的当前文件响应。每个文件最多 10 MiB，总计最多 128 MiB，预留 2 GiB 磁盘；仍校验公共 DNS 固定地址、禁止重定向、MIME、图片签名、实际字节数与 SHA-256。

数据库 `size` 是上传输入大小，不一定等于图床当前表示。版本 2 的 `originals-manifest.json` 将历史 `sourceSize/sourceMime`、HTTP `responseMime` 与实收 `size/mime` 分开，明确记录大小、历史类型和响应类型的差异计数。HTTP 声明长度存在时必须匹配实际流，chunked 响应仍受大小和内容校验。响应头只能为允许的四种图片类型，实收内容也必须具有 JPEG/PNG/GIF/WebP 签名；存储扩展名按实际类型确定，标作 PNG 的 HTML 等仍拒绝。`byteIdentity: imagebed_response` 表示备份的是当前图床文件，不能声称与最初上传文件逐字节相同。失败不发布完整清单，不修改数据库元数据。完整恢复证明仍须最后的隔离恢复演练。

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
node <agent> verify /etc/nav/dropbox-backup.json <backup-id>
node <agent> retention-plan /etc/nav/dropbox-backup.json
node <agent> local-retention-plan /etc/nav/dropbox-backup.json
node <agent> prune-local /etc/nav/dropbox-backup.json
node <agent> prune-cloud /etc/nav/dropbox-backup.json
```

`init-local` 只新建台账且拒绝覆盖；`list`/`retention-plan` 不联网；`plan` 会读取专用 App Folder，但不上传。
`backup` 还需受管配置显式允许；`download` 仅下载校验密文，检查本机剩余空间且不覆盖既有下载。
`verify` 流式回读精确 revision，不在磁盘保存内容，核对大小、SHA-256、Dropbox 内容哈希后更新 download_verified；已有 restore_verified 不降级。

## 网页操作执行器（开发候选，默认不安装、不开放）

`control-host.mjs` 是 Linux/root 独立执行器；API 不获得备份 OAuth、私钥、口令、任意 shell 或主机路径。仅固定操作：创建 canonical 本地快照并加密上传/回读校验、指定备份 ID 校验、下载密文、保存每日时间。没有网页恢复、任意删除、命令或路径输入。原 Full Dropbox 文件库授权保持独立。

- 持久任务：原子写入与 fsync，先保存 queued/running 再产生副作用；一次只执行一个任务。32 位随机请求 ID 幂等，近期终态回执至少保留 72 小时，最多 50 条。结果不明或重启时仍 running 的任务转 review，拒绝新任务，不自动重试或清空台账。管理员须同时核对 canonical 快照和云 ledger；没有网页“忽略错误再上传”按钮。
- 每日计划：北京时间 HH:mm；修改计划后从次日开始，每日最多一次，停机多日不会补跑积压。持久 lastDay 与入队原子提交。关闭计划不杀正在执行任务；尚排队的定时任务在启动前再次核对开关。页面区别“配置开启”与“执行器当前安全条件满足”。
- 开启计划同时需要 root 配置 allowSchedule/allowManual、备份 allowUpload、没有 pending 上传/删除，以及台账有效 restore_verified。用户已明确演练最后做，因此本批只开发，不开启实际计划或云轮换。
- 浏览器下载是精确 revision 的密文流，受同一管理员会话和绑定 owner 限制；服务端完成哈希校验前扣住最后一个分块。错误/断线截断响应，浏览器不可收到声明长度的完整损坏文件。一次一个下载、最长 15 分钟、最大 1 GB，不生成临时 tar/密文副本。不会把下载成功视为业务恢复。
- 控制平面仅 Unix socket，无 TCP/公网监听。单实例 `/run/lock/nav-dropbox-control.lock` 与 canonical 备份锁分开，复用 canonical 锁的实际云/本地操作仍串行。文件状态丢失或损坏直接拒绝，不能静默新建；仅显式 init 可第一次创建。

受控部署准备（本批未执行）：

1. 使用 `control-config.example.json` 确认真实路径，替换为已校验的不可变 release 路径，不能使用 `current` 等符号链接。确认 snapshotConfig 与 backupConfig 指向同一 canonical backupRoot；root 配置 0600、私有状态/报告/socket 目录 0700，父目录 root 拥有且不可被组/其他用户写入。allowManual/allowSchedule/allowDownload 初始全部 false。
2. 核对 Node >=22、bash、flock、age、Docker 和 canonical 备份工具。不要重复运行 init：`node <release>/scripts/dropbox/control-host.mjs init /etc/nav/dropbox-control.json` 拒绝覆盖已有 control.json。系统服务模板需替换真实 Node 和不可变 release；不得把模板原样 enable。
3. API 配置 `<managed-dir>/dropbox-backup-control.json` 只包含 version:1、ownerUserId 和固定 socketPath `/run/nav-dropbox-control/control.sock`，0600。API 容器只挂这个 0700 socket **目录**，不挂备份根、凭据、恢复钥匙或主机 Docker socket。当前 API/root 执行身份需匹配；非 root 安装不准靠 chmod 777 绕过，需另行设计 UID。
4. runtime socket 目录需在 API 容器创建前存在；服务 `RuntimeDirectoryPreserve=yes` 保留目录 inode，避免重启后 Docker bind 指向旧目录。在最终 Linux 集成验收中验证进程/容器重启、flock、权限、socket 重新连接、损坏状态、断网/断线。当前 Dev60 合成测试不能替代这些。
5. 发布时显式评估备份/上传任务元数据的备份排除，尤其短期上传会话密钥和状态；不要把新状态目录加入 canonical payload 导致循环备份。先保留配置/版本回退，再开放手动和密文下载。完整恢复演练通过后才单独开放计划/轮换。定时关闭或移除 API 的 controller 配置即可关闭入口，不删除云台账/备份/独立授权。

任务记录就是页面反馈，目前不另发邮件或 Telegram。若任务 review/报告过期，要显示真实阻断，不以按钮提交或 HTTP 202 冒充备份成功。
`local-retention-plan` 只校验并列出本地保留/清理对象；`prune-local` 需要 `allowLocalPrune: true`。本地操作同样持有 canonical 锁，不能与备份/恢复并发；不要同时启用旧 `nav-backup.sh --prune-local` 的另一套保留策略。
`prune-cloud` 需要 `allowCloudPrune: true` 和有效恢复回执；默认配置仍关闭。此候选已有上述独立网页操作执行器和 systemd 模板，但没有自动安装器、生产恢复或用户级备份。真实恢复与自动计划/清理须另行验收后启用，文件库另见 `FILES.md`。

## 测试与发布门禁

1. `node --test scripts/dropbox/backup.test.mjs scripts/dropbox/cloud-retention.test.mjs`：纯合成/假凭据测试，覆盖保留保护、容量/变化拒绝、删除前日志、失联不重试和回执核对。远程账号和文件 API 均为 mock。
2. `backup-linux.test.mjs`：待批准的临时 Linux 环境中，使用一次性 age 密钥、两个无网络 PostgreSQL 16 容器，验证真实加解密、篡改拒绝、pg_dump/pg_restore 与行内容一致，以及 canonical 锁和 CLI 防覆盖。
   仅当 `NAV_DROPBOX_DISPOSABLE_TEST=1` 才运行。它仍不等于完整 NAV 业务恢复或真实 Dropbox 云恢复。
3. `local-retention.test.mjs` 验证最新三份、损坏拒绝、边界保护及 Linux 合成目录的真实清理。`.github/workflows/dropbox-backup.yml` 仅用于已授权的独立测试分支及 Actions 临时环境。只读仓库权限、无账号秘密、无业务数据、无部署步骤、不上传备份或密钥。
4. 合成 Linux 通过后，再提出精确生产配置交接、专用恢复密钥离线保管、最小真实云往返与独立恢复方案，获得授权后执行。
5. 真实下载、age 解密、完整 NAV 隔离恢复及回执通过之前，不允许启用自动备份。

官方依据：[Dropbox content_hash](https://docs.dropboxapi.com/dropbox-api/docs/technical-reference/content-hash)、
[Dropbox upload sessions](https://dropbox.github.io/dropbox-sdk-js/Dropbox.html#filesUploadSessionStart)、
[age 标准工具](https://github.com/FiloSottile/age)。
