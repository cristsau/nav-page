# DOMO NAV Deployment Guide

## 当前线上部署

- 域名：[https://nav.skrskr.net](https://nav.skrskr.net)
- 服务器：`oracle-JP`
- 对外端口：`80 / 443`
- 前端发布目录：`/home/web/html/nav`
- 后端：`nav-api`
- 数据库：`nav-postgres`

## 当前定位

当前部署是：

- 可上线测试版
- 可用于日常自用、演示和小范围内测

还不是最终商业交付版，因为后续还要继续补：

- 备份
- 审计日志
- 限流
- 多环境部署
- 客户自部署文档

## 开发到线上发布流程

推荐流程：

1. 本地只做源码修改和静态差异检查
2. 提交到 GitHub 分支
3. 由 GitHub Actions 在云端执行 API 测试与前端构建
4. 云端检查通过后再由服务器拉取并部署

仓库地址：

- [https://github.com/cristsau/nav-page.git](https://github.com/cristsau/nav-page.git)

项目不要求在个人电脑运行 npm 测试；`.github/workflows/ci.yml` 是默认验收入口。

## 笔记图片与个人图床

笔记和备忘录的图片通过 NAV 后端代理上传到 CloudFlare-ImgBed，浏览器不会接触图床 Token，NAV
也不会把图片写入本机磁盘。生产环境在 `api/.env` 配置：

```dotenv
NAV_IMGBED_BASE_URL=https://pic.example.com
NAV_IMGBED_UPLOAD_TOKEN=<仅 upload 权限的 Token>
NAV_IMGBED_UPLOAD_FOLDER=nav-notes
NAV_IMGBED_MAX_IMAGE_BYTES=10485760
```

Token 只应授予上传权限，不要提交到 GitHub。当前第一版从笔记移除图片只解除引用，不会调用图床删除接口。
加密笔记禁止上传公开图床图片，防止图片绕过正文加密。

## 一键部署脚本

本地可用：

- `D:/DomoCodex/projects/NAV/scripts/deploy-oracle-jp.ps1`
- `D:/DomoCodex/projects/NAV/scripts/rollback-oracle-jp.ps1`

服务器可用：

- `D:/DomoCodex/projects/NAV/scripts/deploy.sh`
- `D:/DomoCodex/projects/NAV/scripts/rollback.sh`

## 反向代理说明

### 当前源站

- 源站域名：`nav.skrskr.net`
- 源站服务器：`150.230.212.137`

### 用 Nginx Proxy Manager 做外部反代

如果你要在 `45.143.234.47` 上给 `nav.cristsau.cn` 做外部反代，推荐这样配：

- Domain Names: `nav.cristsau.cn`
- Scheme: `https`
- Forward Hostname / IP: `nav.skrskr.net`
- Forward Port: `443`

额外建议：

- 打开 `Websockets Support`
- 打开 `Block Common Exploits`
- 上游优先用域名，不要直接用 `https://150.230.212.137:443`

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

如果需要回滚到指定提交：

```bash
git checkout <commit>
```

或使用项目里的回滚脚本。
