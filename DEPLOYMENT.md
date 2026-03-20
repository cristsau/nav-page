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

## 本地到线上发布流程

推荐流程：

1. 本地开发
2. 本地测试
3. 提交到 GitHub
4. 服务器拉取并部署

仓库地址：

- [https://github.com/cristsau/nav-page.git](https://github.com/cristsau/nav-page.git)

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
