<script setup>
import PublicPageLayout from './PublicPageLayout.vue'

const policySections = [
  { id: 'service', label: '一、服务说明' },
  { id: 'google-data', label: '二、Google 用户数据' },
  { id: 'purpose', label: '三、数据用途' },
  { id: 'sharing', label: '四、数据共享' },
  { id: 'security', label: '五、数据存储和安全' },
  { id: 'retention', label: '六、数据保留和删除' },
  { id: 'unlink', label: '七、解除绑定和撤销授权' },
  { id: 'updates', label: '八、隐私政策更新' },
  { id: 'contact', label: '九、联系方式' }
]
</script>

<template>
  <PublicPageLayout current-page="privacy">
    <article class="privacy-page" aria-labelledby="privacy-title">
      <header class="privacy-hero">
        <p>隐私与 Google 登录数据说明</p>
        <h1 id="privacy-title">DOMO NAV 隐私政策</h1>
        <p class="privacy-hero__summary">
          本政策说明 DOMO NAV 在用户使用 Google 登录时，如何访问、使用、存储和保护相关用户信息。
        </p>
        <p class="privacy-effective-date">
          <span>生效日期</span>
          <time datetime="2026-09-02">2026年9月2日</time>
        </p>
      </header>

      <div class="privacy-layout">
        <nav class="privacy-toc" aria-label="隐私政策目录">
          <p>页面目录</p>
          <a v-for="section in policySections" :key="section.id" :href="`#${section.id}`">
            {{ section.label }}
          </a>
        </nav>

        <div class="privacy-document">
          <aside class="privacy-scope" aria-label="Google 登录数据范围摘要">
            <strong>Google 登录权限范围</strong>
            <p>
              DOMO NAV 的 Google 登录只使用 <code>openid</code>、<code>email</code>、
              <code>profile</code>，用于身份验证、账号绑定和登录。
            </p>
          </aside>

          <section id="service">
            <h2>一、服务说明</h2>
            <p>DOMO NAV 是一项自托管的网址导航与个人工作入口服务。</p>
            <p>
              本隐私政策说明 DOMO NAV 在用户使用 Google 登录时，
              如何访问、使用、存储和保护相关用户信息。
            </p>
          </section>

          <section id="google-data">
            <h2>二、Google 用户数据</h2>
            <p>当用户选择“使用 Google 登录”时，DOMO NAV 仅申请以下权限：</p>
            <ul>
              <li><code>openid</code></li>
              <li><code>email</code></li>
              <li><code>profile</code></li>
            </ul>
            <p>根据用户授权，DOMO NAV 可能处理以下信息：</p>
            <ul>
              <li>Google 账号唯一身份标识</li>
              <li>Google 账号邮箱地址</li>
              <li>用户显示名称</li>
              <li>用户头像</li>
            </ul>
            <div class="privacy-emphasis">
              <p>作为 Google 登录流程的一部分，DOMO NAV 不申请、不访问也不读取：</p>
              <ul>
                <li>Gmail 邮件内容</li>
                <li>Google Drive 文件</li>
                <li>Google 联系人</li>
                <li>Google 日历</li>
                <li>其他未在授权页面中明确列出的 Google 数据</li>
              </ul>
            </div>
          </section>

          <section id="purpose">
            <h2>三、数据用途</h2>
            <p>上述通过 Google 登录获得的用户信息仅用于：</p>
            <ul>
              <li>验证用户身份</li>
              <li>将 Google 账号绑定至用户现有的 DOMO NAV 账号</li>
              <li>帮助用户登录 DOMO NAV</li>
              <li>显示用户名称或头像</li>
              <li>保障账号和登录安全</li>
            </ul>
            <p>
              DOMO NAV 不会将 Google 登录用户数据用于广告投放、用户画像，
              也不会出售 Google 用户数据。
            </p>
          </section>

          <section id="sharing">
            <h2>四、数据共享</h2>
            <p>
              除以下情况外，DOMO NAV 不会向第三方出售、出租、转让或披露 Google 用户数据：
            </p>
            <ul>
              <li>为维持服务器和基础设施正常运行所必需的服务</li>
              <li>为防止欺诈、攻击或滥用所必需的安全处理</li>
              <li>法律法规、司法机关或监管机构依法要求提供</li>
            </ul>
          </section>

          <section id="security">
            <h2>五、数据存储和安全</h2>
            <p>
              DOMO NAV 采取合理的访问控制、安全配置和技术措施，
              防止用户信息遭到未经授权的访问、泄露、修改或删除。
            </p>
            <p>OAuth Client Secret 等身份验证凭据不会向普通用户公开。</p>
          </section>

          <section id="retention">
            <h2>六、数据保留和删除</h2>
            <p>
              Google 账号绑定信息仅在提供登录和账号绑定功能所需的期间内保留。
            </p>
            <p>
              用户解除 Google 账号绑定、删除 DOMO NAV 账号或提交删除请求后，
              相关身份绑定数据将按照系统实际的数据删除和备份轮替机制进行删除。
            </p>
            <p>
              用户可以通过以下邮箱申请查询或删除相关数据：
              <a href="mailto:cristsaudomo@gmail.com">cristsaudomo@gmail.com</a>
            </p>
          </section>

          <section id="unlink">
            <h2>七、解除绑定和撤销授权</h2>
            <p>
              用户可以登录 DOMO NAV 后，在
              <RouterLink to="/settings?category=security">账号安全设置</RouterLink>
              中解除 Google 账号绑定。
            </p>
            <p>
              用户也可以在 Google 账号的第三方应用连接管理页面中撤销 DOMO NAV 的访问授权。
            </p>
          </section>

          <section id="updates">
            <h2>八、隐私政策更新</h2>
            <p>本隐私政策可能随着 DOMO NAV 功能或数据处理方式的变化而更新。</p>
            <p>更新后的政策将在本页面公布，并标明新的生效日期。</p>
          </section>

          <section id="contact">
            <h2>九、联系方式</h2>
            <p>对本隐私政策或个人数据处理有疑问，可以联系：</p>
            <a class="privacy-contact" href="mailto:cristsaudomo@gmail.com">
              cristsaudomo@gmail.com
            </a>
          </section>
        </div>
      </div>
    </article>
  </PublicPageLayout>
</template>

<style scoped>
.privacy-page {
  padding: clamp(54px, 8vw, 96px) 0 80px;
}

.privacy-hero {
  max-width: 900px;
}

.privacy-hero > p:first-child {
  margin: 0 0 14px;
  color: #77716b;
  font-size: 0.75rem;
  font-weight: 760;
  letter-spacing: 0.13em;
  text-transform: uppercase;
}

.privacy-hero h1 {
  margin: 0;
  color: #17181c;
  font-size: clamp(2.9rem, 7vw, 6.7rem);
  font-weight: 820;
  letter-spacing: -0.065em;
  line-height: 0.98;
  text-wrap: balance;
}

.privacy-hero__summary {
  max-width: 720px;
  margin: 28px 0 0;
  color: #5f5a55;
  font-size: clamp(1rem, 2vw, 1.18rem);
  line-height: 1.85;
}

.privacy-effective-date {
  display: inline-flex;
  gap: 12px;
  margin: 24px 0 0;
  padding: 10px 14px;
  color: #625d58;
  background: rgba(255, 255, 255, 0.74);
  border: 1px solid rgba(36, 36, 36, 0.12);
  border-radius: 999px;
  font-size: 0.8rem;
}

.privacy-effective-date span {
  color: #8a837c;
}

.privacy-layout {
  display: grid;
  grid-template-columns: 220px minmax(0, 760px);
  justify-content: space-between;
  gap: clamp(42px, 8vw, 112px);
  margin-top: clamp(58px, 9vw, 104px);
  align-items: start;
}

.privacy-toc {
  position: sticky;
  top: 28px;
  display: grid;
  gap: 4px;
  padding: 18px;
  background: rgba(255, 255, 255, 0.66);
  border: 1px solid rgba(36, 36, 36, 0.1);
  border-radius: 18px;
}

.privacy-toc p {
  margin: 0 0 10px;
  color: #8a837c;
  font-size: 0.7rem;
  font-weight: 750;
  letter-spacing: 0.12em;
}

.privacy-toc a {
  min-height: 44px;
  display: flex;
  padding: 8px 10px;
  align-items: center;
  color: #67615c;
  border-radius: 9px;
  font-size: 0.77rem;
  line-height: 1.45;
}

.privacy-toc a:hover,
.privacy-toc a:focus-visible {
  color: #222327;
  background: rgba(36, 36, 36, 0.06);
}

.privacy-document {
  min-width: 0;
}

.privacy-scope {
  padding: 24px;
  color: #eeeae5;
  background: #202126;
  border-radius: 20px;
}

.privacy-scope strong {
  color: #fff;
  font-size: 0.88rem;
}

.privacy-document .privacy-scope p {
  margin: 10px 0 0;
  color: #d0cbc5;
  line-height: 1.75;
}

.privacy-document .privacy-scope code {
  color: #fff;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-weight: 750;
}

.privacy-document > section {
  padding: 50px 0 4px;
  scroll-margin-top: 24px;
  border-bottom: 1px solid rgba(36, 36, 36, 0.11);
}

.privacy-document > section:last-child {
  border-bottom: 0;
}

.privacy-document h2 {
  margin: 0 0 22px;
  color: #222327;
  font-size: clamp(1.4rem, 3vw, 2rem);
  letter-spacing: -0.025em;
}

.privacy-document p,
.privacy-document li {
  color: #5f5a55;
  font-size: 0.94rem;
  line-height: 1.9;
}

.privacy-document p {
  margin: 0 0 14px;
}

.privacy-document ul {
  display: grid;
  gap: 8px;
  margin: 16px 0 22px;
}

.privacy-document li {
  position: relative;
  padding-left: 20px;
}

.privacy-document li::before {
  position: absolute;
  top: 0.78em;
  left: 2px;
  width: 5px;
  height: 5px;
  content: '';
  background: #28292d;
  border-radius: 50%;
}

.privacy-document code {
  color: #292a2e;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.88em;
  font-weight: 720;
}

.privacy-document a {
  color: #1f2024;
  font-weight: 680;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 4px;
}

.privacy-emphasis {
  margin: 24px 0 6px;
  padding: 22px 24px;
  background: #efede9;
  border-left: 3px solid #2b2c31;
  border-radius: 4px 16px 16px 4px;
}

.privacy-emphasis p {
  color: #2f3034;
  font-weight: 680;
}

.privacy-emphasis ul {
  margin-bottom: 0;
}

.privacy-contact {
  display: inline-flex;
  min-height: 48px;
  padding: 0 18px;
  align-items: center;
  color: #fff !important;
  background: #1f2024;
  border-radius: 999px;
  text-decoration: none !important;
}

@media (max-width: 860px) {
  .privacy-layout {
    grid-template-columns: 1fr;
  }

  .privacy-toc {
    position: static;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .privacy-toc p {
    grid-column: 1 / -1;
  }
}

@media (max-width: 560px) {
  .privacy-page {
    padding-top: 46px;
  }

  .privacy-toc {
    grid-template-columns: 1fr;
    padding: 14px;
  }

  .privacy-toc p {
    grid-column: auto;
  }

  .privacy-scope,
  .privacy-emphasis {
    padding: 20px;
  }

  .privacy-effective-date {
    border-radius: 14px;
  }
}
</style>
