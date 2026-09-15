# DOMO NAV — Docker Compose 自部署包

这是完整网站的**联网安装包候选版**：前端 + API + PostgreSQL 16 + Caddy HTTPS。
不是 Windows EXE，不是浏览器扩展，也不包含现有 nav.cristsau.cn/nav.skrskr.net 的账号、数据库、密钥或服务器配置。
解压后只需运行安装命令，按提示设置管理员。首次安装需要从 Docker Hub/npm 下载基础镜像和依赖；不是离线镜像包。

## 安装

前提：Linux x86-64、本机 Docker Engine + Docker Compose v2（至少 2.20）、Bash、tar、sha256sum、sed。建议至少 2 核/4 GB 内存、10 GB 空闲磁盘用于首次构建；这是预留建议，不是已测最低配置。当前用户须有 Docker 权限。
脚本**不会**安装 Docker、执行 sudo、修改防火墙/DNS/系统信任证书、关闭已有网站或删除已有目录。不要以已有生产目录作为安装目录。

先校验下载文件，再解压到自己的专用目录（名字不能包含逗号）：

```bash
sha256sum -c domonav-2026.09.15-compose.1.tar.gz.sha256
tar -xzf domonav-2026.09.15-compose.1.tar.gz
cd domonav-2026.09.15-compose.1
bash install.sh
```

默认模式仅绑定 `127.0.0.1:8080/8443`，网站地址为 `https://localhost:8443`；数据库和 API 没有宿主机发布端口。输入管理员用户名，以及至少 15 字符的不常用长密码，**请自行保存密码**。密码通过标准输入进入初始化容器，不显示在终端、命令参数或 Dockerfile 中。

本地 HTTPS 使用本实例独立的 Caddy CA。执行 `bash manage.sh local-ca` 导出**公有证书** `domonav-local-ca.crt`，核对确为自己生成的证书后，由你手动导入所用浏览器/系统的信任证书。脚本不会自动更改信任库。未信任前浏览器会提示证书不可信；不要把 `curl -k` 或忽略证书当成正式验收。远程服务器的 localhost 不是你电脑的 localhost；本地模式可先通过 SSH 转发 8443，再在自己的浏览器访问。

### 用自己的域名正式提供服务

仅在全新实例第一次初始化时选择：

```bash
bash install.sh --public
```

输入 `https://你的域名`（无路径、非 IP、443 标准端口），确认输入 `PUBLIC` 后，才会绑定 `0.0.0.0:80/443`。请自行确认这些端口空闲、域名 A/AAAA 都正确指向新主机，且公网 80/443 可达。Caddy 自动申请/续期证书；DNS、端口冲突、CA 限流、网络问题需要自行处理，脚本不会更改现有服务。容器健康不等于公网证书/DNS已验收。

**已有 Nginx/NPM 或同机已有网站：不要直接使用 `--public`。** 本版针对独立服务器/本机试用，不自动接管现有反向代理。先规划独立端口与准确的代理信任地址再接入，不要关闭 CSRF、放宽 CORS 或信任任意代理。

## 数据与安全边界

- Compose 自动生成独立项目名。数据库、集成设置、模型缓存、证书使用该项目专属的持久卷；重启/重建容器不应清空数据。
- 数据库密码、初始管理员密码、限流密钥和邮件认证密钥，首次随机生成或由你输入，存入本目录 `config/secrets/`。文件 0600、目录 0700；`.env` 只有非密钥部署参数。Compose secrets 是文件挂载，不是加密保险箱；主机管理员/Docker 权限持有者仍可读取。
- 管理员初始化只在数据库没有管理员时运行；重复启动不会重置已有管理员或密码。初始化失败后保留现场，不自动删除卷、重置密码或覆盖半成品配置。
- 原有 API 启动顺序：等待数据库健康 → 带锁迁移 → 创建初始管理员 → 监听。Web 必须先健康，API 才解析并信任该精确代理 IP；通过本工具重建 Web 时会同步重启 API 更新此信任。不要私自横向扩容或替换单个 Web 容器。
- 日志大小有上限；不要公开日志原文、`.env`、`config`、备份或 Docker inspect 内容。API 采用现有 CPU-only 依赖隔离，镜像构建时移除 ZIP 安装工具，不下载语义模型。
- 安装包测试分支采用 adm-zip 0.6.1 修复并保留 CPU-only 隔离；原有限时安全例外已撤销。仅在该分支的零漏洞审计和真实 Linux 镜像验证都通过后分发对应包；不代表以后没有新漏洞。安装包变更不等于现有网站后端已更新。

## 首次登录与可选能力

打开安装时指定的地址，选“账号密码”，用刚设置的管理员登录。默认不要求邮箱验证码。邮件、Cloudflare Turnstile、设备密钥、Web Push、语义模型、定时任务均未启用；不会冒用原站服务或自动发送邮件。

邮件可在“登录与系统集成”配置，经测试收发后再开启；可管理设置和秘密写入专属 integrations 卷。图床、AI 等外部服务仍需你自己的配置与账号，基础安装不代表外部能力已可用。域名绑定的设备登录/Google OAuth 回调必须另行适配，不能直接复用原站配置。

Edge 商店扩展目前面向原站的允许域名；本包只部署网站，**不保证该扩展能连接任意自建域名**。不要以扩大跨站允许范围来解决。

## 日常管理

```bash
bash manage.sh status
bash manage.sh logs      # 仅在自己终端查看，不公开粘贴
bash manage.sh stop      # 主动停止本实例，不删数据
bash manage.sh start     # 首次构建/继续失败安装/启动，等待健康
```

不要运行 `docker compose down -v`、`docker volume prune` 或删除 config；这些可能永久破坏数据。首次构建失败时修复网络/磁盘后用 `manage.sh start` 重试，不要重新生成密钥。

## 备份、升级和回退

当前提供**显式停写备份**，不悄悄安排定时任务。确认没有人在编辑后运行：

```bash
bash manage.sh backup --allow-pause
```

该命令暂停**本实例** Web/API，导出 PostgreSQL 自定义格式 dump、集成卷、配置/秘密，再恢复服务；失败也尝试恢复服务。备份写入 `backups/` 下唯一私有目录并生成校验表。备份含明文私密数据和密钥，请在离开该主机前加密；不自动上传。模型缓存可重建；Caddy 证书卷保留在主机，备份未包含 CA 私钥，迁移后可重新签发/重新信任。

本候选**不提供自动跨版本升级、数据库降级或覆盖式恢复按钮**。安全升级顺序：先备份并在新独立 Compose 项目恢复验证 → 保存旧包/原配置/镜像 ID → 阅读迁移兼容说明 → 明确停机窗口后切换。若新版本写入了不兼容 schema，不能只换回旧 API 镜像；应恢复整套经过验证的数据库与对应配置/密钥。不要在现有实例直接试恢复命令。暂未完成真实 Docker 安装/恢复验收时，不能将备份文件存在视作可恢复保证。

## 开发者制作包

在安装包测试分支的源码仓库使用 PowerShell 7 执行（仅制包需要，Linux 安装不需要 PowerShell）：

```powershell
.\scripts\New-ComposePackage.ps1 -SourceRef HEAD
```

打包只读取指定提交的 app/api 白名单源码，不收集工作区的 .env、个人数据、旧扩展 ZIP、运维脚本和诊断文件。selfhost 内安装器文件按固定列表加入；官方 Postgres/Caddy 镜像在打包时解析并锁定 manifest digest，Node 沿用项目已锁定基础镜像。输出 `dist/compose-时间戳/` 的 tar.gz、SHA-256 旁文件和包内逐文件校验表。校验和用于完整性比对，不是签名或发布者身份证明。

参考：[Compose 启动顺序](https://docs.docker.com/compose/how-tos/startup-order/)、[文件形式的 secrets](https://docs.docker.com/compose/how-tos/use-secrets/)、[Caddy TLS](https://caddyserver.com/docs/caddyfile/directives/tls)。
