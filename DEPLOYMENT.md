# NAV 部署文档

## 1. 适用场景

本文档分为两部分：

- 当前版本部署：适合你现在的测试版、演示版、小范围使用
- 商业化方向：适合后续公开给客户或团体自部署

当前项目是 `Vue 3 + Vite + Dexie.js` 前端应用，现阶段可以直接部署为静态站点。

注意：

- 当前用户数据仍保存在浏览器 `IndexedDB`
- 当前登录与审批逻辑仍以客户端实现为主
- 当前 Telegram 接口依赖 Vite 开发代理，生产环境不能直接沿用

所以：

- 现在可以部署做测试版
- 现在不建议直接作为公开商业正式版

## 2. 当前推荐服务器

### 你自己的测试环境

当前最推荐使用：

- `oracle-JP`

原因：

- 资源充足：`4 vCPU / 23GB RAM / 45GB 磁盘`
- 当前负载较轻
- 日本区域对你当前使用场景延迟更友好
- 后续接 `OpenClaw / CLI Proxy API` 更顺手

### 以后给客户交付的推荐规格

#### 最低可用

- `2 vCPU`
- `4GB RAM`
- `40GB SSD`
- `Ubuntu 22.04 LTS` 或 `Debian 12`

#### 更稳妥

- `4 vCPU`
- `8GB RAM`
- `80GB SSD`
- `Ubuntu 22.04 LTS`

推荐客户标准尽量使用：

- `x86_64`
- `Docker Compose`
- `Nginx`

## 3. 当前版本部署方式

当前版本最适合使用：

- `Nginx` 提供静态站点
- `Node.js 20` 仅用于构建
- 不额外启用后端服务

部署结果：

- 前端页面可访问
- 书签、便签、设置、本地登录等可用
- 数据保存在访问者自己的浏览器里

## 4. 部署前检查清单

### 服务器检查

- 系统为 `Ubuntu 22.04` 或 `Debian 12`
- 已能通过 SSH 登录
- `80` / `443` 端口可用
- 已安装 `git`
- 已安装 `curl`

### 域名检查

- 已准备域名或子域名
- 域名 A 记录已指向服务器 IP

### 项目检查

- 当前代码已推送 GitHub
- 当前提交点：`c941ef9`
- 本地构建已通过：`npm run build`

### 风险确认

- 当前默认管理员仍在前端逻辑中
- 当前 Telegram 审批在生产环境下不可直接使用
- 当前多设备不会自动同步数据

## 5. 服务器初始化步骤

以下以 `Debian 12 / root` 为例。

### 5.1 更新系统

```bash
apt update
apt upgrade -y
```

### 5.2 安装依赖

```bash
apt install -y git curl nginx
```

### 5.3 安装 Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v
npm -v
```

## 6. 项目部署步骤

### 6.1 克隆项目

```bash
mkdir -p /opt/nav
cd /opt/nav
git clone https://github.com/cristsau/nav-page.git .
git checkout c941ef9
```

如果你后续要部署最新版本，可以改成：

```bash
git pull origin master
```

### 6.2 构建前端

```bash
cd /opt/nav/app
npm install
npm run build
```

构建产物目录：

- `/opt/nav/app/dist`

### 6.3 发布静态文件

```bash
mkdir -p /var/www/nav
cp -r /opt/nav/app/dist/* /var/www/nav/
```

## 7. Nginx 配置

由于项目使用的是 Vue Router `createWebHistory()`，必须配置 history fallback，否则刷新子页面会 404。

创建配置文件：

```bash
cat >/etc/nginx/sites-available/nav <<'EOF'
server {
    listen 80;
    server_name your-domain.com;

    root /var/www/nav;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location = /favicon.ico {
        log_not_found off;
        access_log off;
    }
}
EOF
```

启用站点：

```bash
ln -sf /etc/nginx/sites-available/nav /etc/nginx/sites-enabled/nav
nginx -t
systemctl reload nginx
```

如果默认站点冲突，可以先禁用：

```bash
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
```

## 8. HTTPS 配置

如果域名已经解析到服务器，推荐直接开启 HTTPS。

### 8.1 安装 Certbot

```bash
apt install -y certbot python3-certbot-nginx
```

### 8.2 申请证书

```bash
certbot --nginx -d your-domain.com
```

### 8.3 验证续期

```bash
systemctl status certbot.timer
certbot renew --dry-run
```

## 9. 部署后验收清单

- 首页可打开
- `/auth` 可打开
- `/settings` 刷新不 404
- `/whisper` 刷新不 404
- 登录后能正常进入首页
- 书签和便签能正常新增
- 暗色模式与亮色模式可切换
- Nginx 配置已启用 HTTPS

## 10. 当前版本上线注意事项

### 可以正常使用的部分

- 静态页面访问
- 前端路由
- 本地书签、分组、便签、设置
- 本地用户隔离逻辑

### 当前不适合作为正式商业版的部分

- 默认管理员账号仍在前端逻辑中
- 用户审批不是服务端权威模型
- Telegram 接口依赖 Vite 开发代理
- 用户数据不会自动跨设备同步
- AI 搜索还未落地为正式 API

## 11. 回滚步骤

### 回滚到当前稳定提交

```bash
cd /opt/nav
git fetch origin
git checkout c941ef9
cd /opt/nav/app
npm install
npm run build
rm -rf /var/www/nav/*
cp -r /opt/nav/app/dist/* /var/www/nav/
systemctl reload nginx
```

### 更新到最新提交

```bash
cd /opt/nav
git pull origin master
cd /opt/nav/app
npm install
npm run build
rm -rf /var/www/nav/*
cp -r /opt/nav/app/dist/* /var/www/nav/
systemctl reload nginx
```

## 11.1 脚本化发布与回滚

项目现在已经补了发布脚本：

- 服务器部署脚本：[scripts/deploy.sh](D:/DomoCodex/projects/NAV/scripts/deploy.sh)
- 服务器回滚脚本：[scripts/rollback.sh](D:/DomoCodex/projects/NAV/scripts/rollback.sh)
- 本地一键部署脚本：[deploy-oracle-jp.ps1](D:/DomoCodex/projects/NAV/scripts/deploy-oracle-jp.ps1)
- 本地一键回滚脚本：[rollback-oracle-jp.ps1](D:/DomoCodex/projects/NAV/scripts/rollback-oracle-jp.ps1)

### 本地一键部署到 oracle-JP

在本地项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-oracle-jp.ps1
```

如果你要部署指定 Git 引用：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-oracle-jp.ps1 -Ref master
```

这个脚本会：

- 检查本地是否有未提交修改
- 先把当前分支推到 GitHub
- 再 SSH 到 `oracle-JP`
- 调用服务器上的 `scripts/deploy.sh`

### 本地一键回滚 oracle-JP

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\rollback-oracle-jp.ps1 -Ref 0ca3300
```

这个脚本会在服务器上：

- checkout 到指定提交
- 重新构建前端
- 覆盖发布到 `/home/web/html/nav`

## 12. 商业化改造路线

推荐按下面顺序推进：

1. 增加正式后端 API
2. 将登录、注册、审批迁移到服务端
3. 将 Telegram 接口从 Vite 开发代理迁到后端
4. 将用户数据迁移到服务端数据库
5. 保留 Dexie 作为本地缓存层
6. 接入 Brave Search / OpenAI-compatible / OpenClaw
7. 增加日志、限流、审计、备份

## 13. 推荐的商业版架构

### 最小可行商业架构

- 前端：Vue 3 + Vite
- 反向代理：Nginx
- API：Node.js
- 数据库：PostgreSQL
- 本地缓存：Dexie

### 更适合长期交付的架构

- 前端：Vue 3 + Vite
- API：Node.js / Fastify
- 数据库：PostgreSQL
- 缓存：Redis
- 本地离线层：Dexie
- HTTPS：Nginx + Let's Encrypt
- 部署：Docker Compose

## 14. 你当前最推荐的执行顺序

### 现在

先部署当前测试版到 `oracle-JP`

### 接下来

1. 先做生产可用的认证与审批后端
2. 再做 Telegram 后端接口
3. 再做搜索 API 与 AI 接入
4. 最后整理客户自部署交付方案

## 15. 当前已部署环境记录

### 已部署站点

- 域名：`nav.skrskr.net`
- 服务器：`oracle-JP`
- 公网 IP：`150.230.212.137`

### 对外访问端口

- `80`：HTTP，自动跳转到 HTTPS
- `443`：HTTPS，当前正式访问入口

说明：

- NAV 没有单独暴露新的应用端口
- 当前直接复用服务器现有 `nginx` Web 入口

### 服务器上的部署目录

- 项目代码：`/opt/nav`
- 前端构建目录：`/opt/nav/app/dist`
- 站点发布目录：`/home/web/html/nav`
- Nginx 站点配置：`/home/web/conf.d/nav.skrskr.net.conf`
- 证书文件：
  - `/home/web/certs/nav.skrskr.net_cert.pem`
  - `/home/web/certs/nav.skrskr.net_key.pem`

### 当前部署版本

- Git 提交：`0ca3300`

### 验证结果

- `https://nav.skrskr.net` 返回 `200`
- `https://nav.skrskr.net/settings` 返回 `200`
- HTTP 已正确跳转到 HTTPS
