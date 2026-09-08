# NAV 生产磁盘清理记录

核验时间：2026-09-07 19:44–19:45 +08:00。归属：个人。目标：SSH 别名 `ovh-US` 根盘。
状态：`CLEANUP_APPLIED / TECHNICAL_ACCEPTANCE_PASS`，不是新功能发布验收。

## 授权与边界

用户明确要求优先清理无用磁盘内容。已完成容量、容器、发布指针、镜像标签、构建状态、备份保留策略及恢复配置基线检查，并告知精确清理类别和不可直接撤销的影响。未清理 Windows 本机或其他主机。

保留 current `20260907-140500-b2ae023`、rollback `20260903-160400-94543f6` 及完整镜像；保留所有容器、数据库、挂载卷、上传/模型数据、备份、旧 release、prechange、源码归档、配置、凭据、日志和验收证据。没有停止、重启或重建服务。

最近发布后备份 `/var/backups/nav/nav-20260907T062639Z-nogit` 的完整 manifest 在本次删除前后均通过 SHA256 校验。本次未重做数据库恢复演练，之前 PostgreSQL 16 隔离恢复证据见 [发布台账](NAV_RELEASE_20260907_MAIL_RETIREMENT.md)。

## 实际删除

| 不承担当前/回滚职责的 NAV revision | 删除的 image ID 前缀 |
| --- | --- |
| `d774916e93cba8bb65120a780d9e265b836e4463` | `08f1830874bb` |
| `a7c00709545644587bda6113c8039d7e1acbba67` | `242ba2e21815` |
| `cec07bb4df050cd9814336ac10a435605482c770` | `25342ace23e9` |
| `0107844c63e6de48250c2d3379ae43e0c16cc84e` | `e80b8f49de1b` |
| `c8a0f06400e618937cf9c3344353f377a161c5da` | `26d8aa29e576` |
| `955fb5c7186e1fa25b0e3a7a24f6f7adcaf98b25` | `f01e8de0ac93` |

六项均逐个确认完整 image ID、revision label、精确 tag、运行和停止容器均无引用。对应 `/opt/nav-stack/incoming/nav-source-<revision>.tar.gz` 逐个 `gzip -t` 通过并计算 SHA256，保留这些源码归档；没有给待删缓存或旧镜像另造备份。**旧镜像删除无法直接撤销，可以从源码重建，但不保证重现旧 image digest。** 当前与回滚镜像无需重建、保持原样。

其他清理项：

- 默认 builder 超过 24 小时的闲置缓存：`docker buildx prune --builder default --all --force --filter 'until=24h'`。记录数 69 → 25；逻辑计量 6.661 GB → 6.472 MB，不等于实际释放字节数。
- 可重建 APT 索引 `/var/cache/apt/pkgcache.bin`（41,070,056 字节）、`/var/cache/apt/srcpkgcache.bin`（41,048,765 字节）。逐个核对真实路径、非符号链接和文件占用，未运行 apt/dpkg。

完整 allowlist、保护性检查及验收命令见 [一次性执行脚本](../scripts/release/nav-disk-cleanup-20260907.sh)。不是定时任务，成功后不要原样重跑；下一次须重新盘点。未运行 Docker system/volume/container prune、apt autoremove/升级、日志到期删除或备份清理。

## 容量与验收

| 指标 | 删除前 | 删除后 |
| --- | --- | --- |
| 根盘可用字节，同次脚本测量 | 1,485,107,200 | 7,411,154,944 |
| `df -h` 可用 | 1.4 GiB | 7.0 GiB |
| 根盘使用率 | 93% | 64% |
| 镜像数 | 17 | 11 |
| 容器数 / 运行数 | 8 / 7 | 8 / 7 |

实际释放 **5,926,047,744 字节，约 5.52 GiB（5.93 GB）**。不将共享镜像层和 build-cache 的逻辑计量相加。

- 六个目标镜像全部不存在；current/rollback、停止邮件 worker 与固定 PostgreSQL 恢复镜像均存在。
- 所有容器 ID、image ID、状态、启动时间、重启次数、按 Destination 排序后的完整挂载指纹前后相同。API/Web/PostgreSQL/Vaultwarden 健康；CLIProxy/Komari/NPM 仍运行；邮件 worker 仍停止。
- 两个发布指针完全不变；最近发布后备份 manifest 前后通过。
- 双域 `nav.skrskr.net`、`nav.cristsau.cn` 的 HTTPS `/api/health`、`/auth` 均 HTTP 200。
- 双域 `/api/auth/session` 匿名返回 `user:null`；受保护 `/api/auth/sessions` 均 HTTP 401。未操作真实用户登录，不是登录后完整业务或手机验收。
- 初次执行因 Docker 挂载数组返回顺序变化，在首次删除前触发保护退出；改为按 Destination 排序后比较全部字段，再执行成功。补充探测曾请求不存在的 `/api/auth/me` 得到 404，未当作验收；依据实际路由完成以上 session/sessions 检查。

## 保留与后续

canonical 本地备份仍为 25 份；现有策略保留 30 天、至少 14 份，本次未删备份或改策略。历史 release/source/prechange 有恢复与追溯用途，不因年代判定为垃圾。`8ac1f4a` 与当前镜像共享层，保留不计作可释放独占空间；近 24 小时缓存仅约 6.5 MB，留给后续构建。

容量风险已明显缓解，最终发布仍须结合镜像与构建峰值重新核验。Passkey 退役、邮箱验证码及 UI 优化尚未发布，不能把清理成功等同于实施计划完成。
