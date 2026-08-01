# DOMO NAV Deployment Guide

## 当前线上部署

- 域名：[https://nav.skrskr.net](https://nav.skrskr.net)
- 反代域名：[https://nav.cristsau.cn](https://nav.cristsau.cn)
- 服务器：`oracle-JP`
- 对外端口：`80 / 443`
- 前端发布目录：`/home/web/html/nav`
- 后端：`nav-api`
- 数据库：`nav-postgres`
- 当前提交：`0dd11faaa3866924ce2bc52e288ff7934bab1e86`
- API 镜像：`nav-api:0dd11faaa3866924ce2bc52e288ff7934bab1e86`
- 发布证据：
  `/opt/nav-releases/20260802-001439-0dd11faaa3866924ce2bc52e288ff7934bab1e86/ACCEPTANCE.txt`

## 当前定位

当前部署是：

- 可上线测试版
- 可用于日常自用、演示和小范围内测

还不是最终商业交付版。会话撤销、账号恢复、动态 AI 模型目录、Responses API、数据导出、
命令面板、导航维护、到期提醒、图片库、本地备份/恢复工具、数据库共享限流、统一审计和
图床删除结果闭环已经上线。异地备份、告警、Passkey、多环境部署和客户自部署文档仍未收口。

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
  - /opt/nav/secrets/nav-ai-cli-proxy-api-key:/run/secrets/nav/cli-proxy-api-key:ro
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

认证、已认证写操作和 AI 限流已经迁移到 PostgreSQL。每个 API 副本必须在 owner-only
`api/.env` 中配置相同的稳定随机值：

```dotenv
NAV_RATE_LIMIT_KEY_SECRET=<至少 32 字符的独立随机值>
```

不得把该值提交到 GitHub、镜像、Compose、前端或日志。缺失或过短会使生产 API fail-fast；
轮换会主动开启一套新限流桶并改变后续审计指纹。详细故障策略、隔离测试与验收见
[`docs/NAV_SECURITY_CONTROLS.md`](./docs/NAV_SECURITY_CONTROLS.md)。

## 备份与恢复

当前运行手册与稳定入口：

- `docs/NAV_BACKUP_RUNBOOK.md`
- `scripts/nav-backup.sh`
- `scripts/nav-restore-rehearsal.sh`
- `scripts/nav-backup.env.example`
- `/usr/local/sbin/nav-backup`
- `/usr/local/sbin/nav-restore-rehearsal`
- `/etc/nav/nav-backup.env`

脚本支持同一 PostgreSQL 导出快照、完整表集合/行数/迁移记录、严格树清单、校验和、
隔离恢复、restic 加密上传双闸门和失败报警。没有 bucket-scoped R2 凭据、独立 restic
密码文件和专用报警端点前，只能算本地备份与恢复能力，不能声称异地备份和报警已经启用。

2026-08-02 的 `0dd11fa` 发布前与发布后备份均完成无网络隔离恢复演练；发布前为 14 张表和
13 条迁移，发布后为 16 张表和 15 条迁移，逐表行数完全一致。备份项目源已指向精确发布
提交；证据见当前 release 的 `ACCEPTANCE.txt`。当前没有启用计划任务、云上传、远端删除
或失败报警。

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
`/home/web/html/nav` 挂载到 `/var/www/nav`。

在现有通用 SPA `location /` 之前增加下列精确路由。`proxy_pass` 不带尾部 URI，确保
`/share/:code` 原样到达 Fastify：

```nginx
location ^~ /share/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

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

当前发布的应用回滚入口：

```bash
sudo /opt/nav-releases/20260802-001439-0dd11faaa3866924ce2bc52e288ff7934bab1e86/rollback.sh
```

它恢复发布前 API 环境、前端和备份项目配置，并切回固定旧镜像
`nav-api:1ee05335977112093586185a3132559394edd472`。正常应用回滚保留已经应用的加法迁移，
不得恢复旧整库覆盖发布后的用户写入。只有明确的数据损坏事故才评估在新数据库/新 volume
中恢复并验收后切换。
