# DOMO NAV Deployment Guide

## 当前线上部署（2026-08-23 只读基线）

- 域名：[https://nav.skrskr.net](https://nav.skrskr.net)
- 反代域名：[https://nav.cristsau.cn](https://nav.cristsau.cn)
- 承载服务器：OVH `ovh-US`；Oracle-JP 不再是当前生产承载
- 外层入口：Nginx Proxy Manager → `nav-web` → `nav-api`
- 当前 release：`/opt/nav-stack/releases/20260822-162146-5a42279`
- 当前应用提交：`5a42279e7fba2d9f378ae7e6532f7e1f2464ef6a`
- 前端容器静态目录：`/usr/share/nginx/html`
- 前端配置挂载：`/etc/nginx/conf.d/default.conf`
- 后端服务：`nav-api`
- 数据库服务：`nav-postgres`
- API 镜像：`nav-ovh-api:5a42279e7fba2d9f378ae7e6532f7e1f2464ef6a`
- 发布证据：当前 release 的 `evidence/PRE_SWITCH.txt`、`evidence/SWITCH.txt`、
  `evidence/ACCEPTANCE.txt`

以上是带日期的验收快照，不是下一次发布的免检依据。发布前仍须重新核对 release、镜像、
Compose、容器挂载、代理链、备份和双域状态。

## 当前定位

当前部署是：

- 可上线测试版
- 可用于日常自用、演示和小范围内测

还不是最终商业交付版。会话撤销、账号恢复、动态 AI 模型目录、Responses API、数据导出、
命令面板、导航维护、到期提醒、图片库、数据库共享限流、统一审计、分层保留、图片删除重试、
后台状态和运行内失败/恢复告警已经上线。自动异地加密备份、主机外失联监测、Passkey、
多环境部署和客户自部署文档仍未收口。

## 开发到线上发布流程

推荐流程：

1. 本地只做源码修改和静态差异检查
2. 提交到 GitHub 分支
3. 由 GitHub Actions 在云端执行 API 测试与前端构建
4. 云端检查通过后锁定 merge SHA，生成干净 LF 源码包，在服务器独立 release 目录构建
5. 完成备份、隔离恢复、受控迁移、固定镜像切换、双域验收和发布后恢复演练

仓库地址：

- [https://github.com/cristsau/nav-page.git](https://github.com/cristsau/nav-page.git)

项目不要求在个人电脑运行 npm 测试；`.github/workflows/ci.yml` 是默认验收入口。

## 当前服务端 AI 配置

生产 API 从 CLI Proxy `/v1/models` 动态发现最多 6 个可用模型，并默认选择最新稳定
通用模型。2026-08-02 生产实测目录来源为 live，默认模型为 `gpt-5.6-sol`。配置：

```dotenv
NAV_AI_CLI_PROXY_BASE_URL=https://ap.example.com
NAV_AI_CLI_PROXY_API_MODE=responses
NAV_AI_CLI_PROXY_API_KEY_FILE=/run/secrets/nav/cli-proxy-api-key
```

生产使用 `responses`，从而启用 `reasoning.effort` 和内置 `web_search`；旧网关可显式改回
`chat-completions`。不要仅依靠 Base URL 猜测协议。模型目录是动态结果，文档中的模型名
只是 2026-08-02 的验收快照，不应硬编码为永久默认值。

Compose 只读挂载 owner-only 文件：

```yaml
volumes:
  - "${NAV_SECRETS_DIR:?set NAV_SECRETS_DIR to the release-local secrets directory}/cliproxy-api-key:/run/secrets/nav/cli-proxy-api-key:ro"
```

密钥文件必须是绝对路径、普通文件、非符号链接，权限只能是 `0400` 或 `0600`。
不要把 key 写入 GitHub、镜像、Compose 或前端设置。当前生产继续使用已有有效 client key；
独立 NAV client key 仍需在 Management Center 中追加后再轮换，切勿先删除旧 key。

## 可信代理与限流

API 只信任 loopback 和 `TRUSTED_PROXY_ADDRESSES` 中的精确地址。每次发布前必须现场
复核 Docker bridge gateway 和外层代理，不得填写宽网段，也不要把实时基础设施地址提交
到仓库。Compose 网络重建后网关可能变化，发布时必须重查。验收时应从两个不同
外网客户端经两个域名登录，确认会话页显示的客户端 IP 不同，且限流不会把全部用户视作
同一地址。

OVH 的正式代理链为“外部客户端或 `v.ps-JP` → Nginx Proxy Manager → `nav-web` →
`nav-api`”。NPM 必须把实际入站 peer 追加到它已经规范化的 `X-Forwarded-For`；`nav-web`
使用 [`ovh/nginx.conf`](./ovh/nginx.conf) 原样转发该链，只有头为空时才回退到
`$remote_addr`，绝不能再次使用 `$proxy_add_x_forwarded_for`。这样 API 不会把 NPM 的
Docker 地址误记成客户端。

`TRUSTED_PROXY_ADDRESSES` 只能列出 API 真实 socket peer（例如为 `nav-web` 固定的单个
容器地址）以及确实会出现在 XFF 可信尾部的固定代理地址。`v.ps-JP` 作为外层固定公网
代理使用时，必须现场确认并精确加入它的单个公网地址；停用该路径后同步移除。禁止配置
`trustProxy: true`、`0.0.0.0/0`、整个 Docker bridge 或任意 RFC1918 网段。若生产 Compose
不能固定 `nav-web` 地址，则每次容器重建后必须先查出新地址、更新精确列表并完成伪造 XFF
负向验收，再开放流量。

认证、已认证写操作和 AI 限流已经迁移到 PostgreSQL。每个 API 副本必须在 owner-only
`api/.env` 中配置相同的稳定随机值：

```dotenv
NAV_RATE_LIMIT_KEY_SECRET=<至少 32 字符的独立随机值>
```

不得把该值提交到 GitHub、镜像、Compose、前端或日志。缺失或过短会使生产 API fail-fast；
轮换会主动开启一套新限流桶并改变后续审计指纹。详细故障策略、隔离测试与验收见
[`docs/NAV_SECURITY_CONTROLS.md`](./docs/NAV_SECURITY_CONTROLS.md)。

## 备份与恢复

仓库已提供运行手册与脚本：

- `docs/NAV_BACKUP_RUNBOOK.md`
- `scripts/nav-backup.sh`
- `scripts/nav-restore-rehearsal.sh`
- `scripts/nav-backup.env.example`

脚本支持同一 PostgreSQL 导出快照、完整表集合/行数/迁移记录、严格树清单、校验和、
隔离恢复、restic 加密上传双闸门和失败报警。2026-08-23 只读核验确认 OVH 尚未安装
`restic`，也没有 `/etc/nav/nav-backup.env`、`/etc/nav/restic.env`、`/usr/local/sbin/nav-backup`、
`/usr/local/sbin/nav-restore-rehearsal` 或 NAV/restic 的 systemd timer。因此当前只能证明每次
受控发布创建备份并完成隔离恢复，不能声称自动异地备份和失败报警已经启用。

2026-08-22 的 `5a42279` 发布前与发布后备份均完成无网络隔离恢复演练；发布前为 16 张表和
16 条迁移，发布后为 17 张表和 17 条迁移。迁移 018 只增加固定两行的后台任务状态表；
证据保存在当前 release 的受限 `evidence` 中。当前没有启用计划备份、异地上传、远端保留
清理或主机外失败报警。

2026-08-12 的前端热修 `0a11f1f` 发布前创建了
`/var/backups/nav/nav-20260812T061320Z-0dd11faaa386`，并在无网络临时 PostgreSQL 中完成
16 张表、15 条迁移及逐表行数的精确恢复演练。该发布没有迁移、重启或替换 API/数据库；
双域登录和真实浏览器 DOM 验收均确认 3 个分组、19 条书签及 `16/1/2` 分组计数可见。

## 笔记图片与个人图床

笔记和备忘录的图片通过 NAV 后端代理上传到 CloudFlare-ImgBed，浏览器不会接触图床 Token，
NAV 也不会把图片写入本机磁盘。上传与库管理必须使用两个 Token，并限制到同一个 NAV
用户目录：

```dotenv
NAV_IMGBED_BASE_URL=https://pic.example.com
NAV_IMGBED_UPLOAD_TOKEN=<仅 upload 权限的 Token>
NAV_IMGBED_LIBRARY_TOKEN_FILE=/run/secrets/nav/imgbed-library-token
NAV_IMGBED_UPLOAD_FOLDER=nav-notes
NAV_IMGBED_MAX_IMAGE_BYTES=10485760
```

上传 Token 只允许 `upload`；库管理 Token 只允许 `list + delete`，禁止上传、越界目录和文件夹
批量删除。库管理 Token 使用绝对路径、普通文件、非符号链接和 owner-only 权限；所有 Token
都不得提交到 GitHub、镜像、前端或文档。部署 Compose/override 时必须把该文件只读挂载到
容器中的同一路径。

仓库的 [`docker-compose.backend.yml`](./docker-compose.backend.yml) 已包含下列正式挂载，
迁移或新建 release 时不得删除：

```yaml
volumes:
  - "${NAV_SECRETS_DIR:?set NAV_SECRETS_DIR to the release-local secrets directory}/imgbed-library-token:/run/secrets/nav/imgbed-library-token:ro"
```

`NAV_SECRETS_DIR` 必须在 Compose 解析前指向当前 release 自己的 `secrets` 目录；变量缺失时
Compose 应直接报错，不能回退到全局 `/opt/nav/secrets`。容器内路径保持
`/run/secrets/nav/imgbed-library-token`，与 `api/.env` 一致。

发布前应在容器内只输出布尔状态与权限检查结果，确认文件存在、非符号链接、非空且为
`0400`/`0600`，不得输出文件内容。仅配置 upload Token 不能恢复图库同步；仅配置 library
Token 也不能恢复笔记上传。双 Token、Base URL、上传目录和只读挂载必须作为同一个门禁验收。

当前 `/media` 支持图片列表、引用、保留、分享、对账和删除。移除最后一个引用后，只有保留
策略为 `auto` 的图片才进入清理；上游失败时保留可重试状态。Telegram 来源受平台删除时限
约束，旧记录可能只能解除关联并撤销公开访问，不能把所有 2xx 响应都描述成物理删除来源。
当前生产 NAV 已严格校验并持久化图床返回的来源删除/legacy/缓存撤销细分结果，并按真实
结果给出保守提示。一次性图片的上传、源文件删除、原始与绕缓存 URL 404、图库移除和双域
访问均已通过生产验收。

加密笔记禁止上传公开图床图片，防止图片绕过正文加密。

## 发布脚本边界

下列历史脚本不覆盖完整生产备份、固定 API 镜像、受控迁移和完整回滚，不能直接作为
当前生产“一键发布”入口：

- `D:/DomoCodex/projects/NAV/scripts/deploy-oracle-jp.ps1`
- `D:/DomoCodex/projects/NAV/scripts/rollback-oracle-jp.ps1`

历史服务器脚本：

- `D:/DomoCodex/projects/NAV/scripts/deploy.sh`
- `D:/DomoCodex/projects/NAV/scripts/rollback.sh`

当前生产使用锁定 merge SHA 的独立 release 目录：先在 release 内完成 CI 等价检查和
固定镜像构建，再做生产备份/隔离恢复、受控迁移、API 切换、前端 `index.html` 最后替换、
双域验收和发布后恢复演练。严禁对含生产专属文件的 `/opt/nav` 执行 `git reset`、清空目录
或覆盖式拉取。

前端独立 release 使用 `umask 077` 保护源码和证据，但发布到 Nginx live 目录时必须显式
把目录安装为 `0755`、静态文件安装为 `0644`，不能用 `cp -a` 把构建目录的 `0600` 权限
带到 live。验收必须同时校验响应类型和构建文件内容；仅看到 HTTP 200 不足以通过，因为
SPA fallback 可能在资源不可读时返回 `index.html`。

## 反向代理说明

### 公开分享的动态预览

`/share/:code` 的初始 HTML 由 `nav-api` 生成，以便微信、Telegram、Slack 等不执行
JavaScript 的抓取器读取动态标题、摘要、Open Graph、Twitter Card 和 canonical。API
只读挂载当前前端发布目录，并且每次请求读取当前 `index.html`，避免前后端独立发布后
继续引用旧的 Vite 哈希资源。

生产 `api/.env` 必须配置：

```dotenv
NAV_PUBLIC_APP_ORIGIN=https://nav.skrskr.net
NAV_FRONTEND_INDEX_PATH=/var/www/nav/index.html
```

前端构建同时使用同一个公开主域（仓库的 `app/.env.production` 已提供非敏感配置）：

```dotenv
VITE_PUBLIC_APP_ORIGIN=https://nav.skrskr.net
```

`NAV_PUBLIC_APP_ORIGIN` 是 canonical/OG URL 的固定可信来源，必须是无路径、无查询参数的
HTTPS origin；不要从请求 `Host` 或 `X-Forwarded-Host` 动态生成。Compose 以只读方式把
当前 release 的 `frontend-dist` 挂载到 API 容器内的 `/var/www/nav`；宿主机 release 路径
属于发布时现场值，不写成固定全局目录。

`nav.skrskr.net` 是公开分享的唯一规范域名：ShareManager 新建或复制链接、浏览器端
canonical/OG 更新以及服务端为抓取器生成的 canonical/OG URL 都必须读取上述两个同值环境
变量，不得读取 `window.location.origin`。`nav.cristsau.cn` 继续作为完整可登录的应用别名，
也继续兼容已有分享路径，但页面元数据始终指向 `nav.skrskr.net`。不要做全站 301/308，
也不要设置跨域 Cookie `Domain`；这样可以保留两个域名当前各自的 Secure/HttpOnly 会话行为。

### OVH `nav-web` 正式模板与缓存策略

[`ovh/nginx.conf`](./ovh/nginx.conf) 是 OVH `nav-web` 的正式 `http` context 配置片段。生产
Compose 应把它只读挂载为 `/etc/nginx/conf.d/default.conf`；它有意不包含 `user`、
`events` 或 `http` 外壳，并确保 `nav-api` 是同一私有网络中的服务别名。静态根目录沿用
官方 Nginx 镜像的 `/usr/share/nginx/html`。模板同时保留 12 MB 请求上限、`nosniff`、
静态页面的 `strict-origin-when-cross-origin`、公开分享页更严格的 `no-referrer`、API 300 秒
超时与分享页 60 秒超时。缓存边界为：

- `/assets/` 仅包含 Vite 内容哈希构件，返回
  `Cache-Control: public, max-age=31536000, immutable`，缺失文件必须为 404；
- `/`, `index.html`、其他 HTML、`manifest.webmanifest` 和未来的 `service-worker.js` 使用
  `no-cache, must-revalidate`；
- `/api/` 和动态 `/share/` 显式 `private, no-store`，并禁用代理缓存；
- 其他静态文件使用正常条件请求，不把 SPA fallback 误标成 immutable。

发布前在候选 `nav-web` 容器中运行 `nginx -t`；发布后分别检查 HTML、manifest、一个真实
哈希资源、一个不存在的哈希资源、健康接口和动态分享页的状态、`Content-Type` 与缓存头。
缓存发布只能重建/替换 `nav-web`，不得顺带重建数据库、API、CLIProxyAPI、NPM 或改变 DNS。

在现有通用 SPA `location /` 之前增加下列精确路由。`proxy_pass` 不带尾部 URI，确保
`/share/:code` 原样到达 Fastify：

```nginx
location ^~ /share/ {
    proxy_pass http://nav-api:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $nav_real_ip;
    proxy_set_header X-Forwarded-For $nav_forwarded_for;
    proxy_set_header X-Forwarded-Proto $nav_forwarded_proto;
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
}
```

其中三个 `$nav_*` 变量由同一 `conf.d` 模板顶部的 `map` 定义。不要把这段替换回
`$proxy_add_x_forwarded_for`，否则 `nav-web` 会再次追加自己的 Docker 地址，审计记录将
停在中间代理而不是真实客户端。

这项变更不能单独发布 API：先确认前端目录只读挂载和两个环境变量，再发布 API，最后经
`nginx -t` 验证后才可加载 nginx 配置。回滚时需同时恢复 nginx `/share/` 路由、API
版本和 Compose 挂载。任何生产修改、重载或发布仍需单独授权。

### 当前源站

- 源站域名：`nav.skrskr.net`
- 源站地址与外层代理地址属于实时基础设施配置，发布前现场核对，不写入仓库。

### 用 Nginx Proxy Manager 做外部反代

如果要给 `nav.cristsau.cn` 配置外部反代，推荐这样配：

- Domain Names: `nav.cristsau.cn`
- Scheme: `https`
- Forward Hostname / IP: `nav.skrskr.net`
- Forward Port: `443`

额外建议：

- 打开 `Websockets Support`
- 打开 `Block Common Exploits`
- 上游优先用域名，不要直接使用 HTTPS 裸 IP

原因：

- 源站证书是给域名签的，不是给裸 IP 签的
- 直接反代 HTTPS 裸 IP 容易出现 TLS / SNI 不匹配，导致 `502 Bad Gateway`

如果未来要长期走双层反代，建议额外做一个专门给源站用的域名，例如：

- `origin-nav.skrskr.net`

这样更容易管理证书和回源链路。

## 扩展与反代

浏览器扩展默认访问：

- `https://nav.skrskr.net`

如果以后你切到：

- `https://nav.cristsau.cn`

那么只需要：

1. 确保新域名完整转发 `/`
2. 确保完整转发 `/api`
3. 确保完整转发 `/downloads`
4. 确保完整转发 `/quick-add`
5. 在扩展设置里把站点地址改成新域名

这样扩展、快速添加页和下载包都不会受影响。

## 回滚

当前前端热修的回滚入口：

```bash
sudo /opt/nav-releases/20260812-061103-0a11f1f26bd8e87e39888a56a538a0b12bcf3c04/rollback-frontend.sh
```

它只在当前 live `index.html` 仍与本次热修哈希一致时恢复前端快照，不修改 API 环境、
数据库、Compose、Nginx 或 Secret。旧 release 下的 `rollback.sh` 是 API/前端联合回滚，
会切换 API 镜像，不得用于本次纯前端热修的常规回滚。

正常应用回滚保留已经应用的加法迁移，不得恢复旧整库覆盖发布后的用户写入。只有明确的
数据损坏事故才评估在新数据库/新 volume 中恢复并验收后切换。
