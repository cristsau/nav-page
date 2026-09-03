<script setup>
import Icon from '@/shared/components/Icon.vue'
import PublicPageLayout from './PublicPageLayout.vue'

const purposes = [
  {
    icon: 'compass',
    title: '集中导航',
    description: '集中管理常用网站、工具与个人导航内容，减少在不同入口之间来回寻找。'
  },
  {
    icon: 'note',
    title: '个人工作入口',
    description: '把导航、个人内容与日常工作入口放在一个自托管空间中。'
  },
  {
    icon: 'shield',
    title: '身份与安全',
    description: '通过受控登录和账号绑定确认身份，同时保留自托管服务的管理边界。'
  }
]
</script>

<template>
  <PublicPageLayout current-page="about">
    <article class="about-page" aria-labelledby="about-title">
      <header class="about-hero">
        <div class="about-hero__copy">
          <p class="about-eyebrow">网址导航与个人工作入口</p>
          <h1 id="about-title">DOMO NAV</h1>
          <p class="about-lead">
            DOMO NAV 是一项自托管的网址导航与个人工作入口服务，
            用于集中管理常用网站、工具和个人导航内容。
          </p>
          <div class="about-actions">
            <RouterLink class="about-action about-action--primary" to="/privacy">
              <Icon name="shield" :size="18" />
              查看隐私政策
            </RouterLink>
            <RouterLink class="about-action" to="/auth">登录 DOMO NAV</RouterLink>
          </div>
        </div>

        <div class="about-brand-card" aria-label="CrisTsau 品牌标志">
          <img src="/brand/cristsau-lockup-v2.png" alt="CrisTsau">
        </div>
      </header>

      <section class="about-section" aria-labelledby="about-purpose-title">
        <div class="about-section__heading">
          <p>主要用途</p>
          <h2 id="about-purpose-title">让常用入口更集中，也更容易回到手边</h2>
        </div>
        <div class="about-purpose-grid">
          <section v-for="purpose in purposes" :key="purpose.title" class="about-purpose-card">
            <span class="about-purpose-card__icon" aria-hidden="true">
              <Icon :name="purpose.icon" :size="22" />
            </span>
            <h3>{{ purpose.title }}</h3>
            <p>{{ purpose.description }}</p>
          </section>
        </div>
      </section>

      <section class="about-section about-google" aria-labelledby="about-google-title">
        <div>
          <p class="about-section__label">Google 登录</p>
          <h2 id="about-google-title">只用于身份验证、账号绑定和登录</h2>
        </div>
        <div class="about-google__content">
          <p>
            DOMO NAV 支持使用 Google 账号进行身份验证和账号绑定。
            Google 登录仅请求以下基础身份权限：
          </p>
          <ul aria-label="Google 登录权限">
            <li><code>openid</code><span>OpenID 身份标识</span></li>
            <li><code>email</code><span>Google 账号邮箱地址</span></li>
            <li><code>profile</code><span>显示名称和头像等基础资料</span></li>
          </ul>
          <p>
            这些信息只用于确认用户身份、绑定现有 DOMO NAV 账号以及完成登录。
          </p>
          <p class="about-google__notice">
            在 Google 登录流程中，DOMO NAV 不请求、不读取也不处理用户的 Gmail 邮件、
            Google Drive 文件、Google 联系人或 Google 日历内容。
          </p>
        </div>
      </section>

      <section class="about-privacy-callout" aria-labelledby="about-privacy-title">
        <span class="about-privacy-callout__icon" aria-hidden="true">
          <Icon name="lock" :size="24" />
        </span>
        <div>
          <p>公开说明</p>
          <h2 id="about-privacy-title">了解 DOMO NAV 如何处理 Google 登录数据</h2>
        </div>
        <RouterLink to="/privacy">隐私政策</RouterLink>
      </section>

      <p class="about-contact">
        联系邮箱：<a href="mailto:cristsaudomo@gmail.com">cristsaudomo@gmail.com</a>
      </p>
    </article>
  </PublicPageLayout>
</template>

<style scoped>
.about-page {
  padding: clamp(54px, 9vw, 112px) 0 72px;
}

.about-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(300px, 0.9fr);
  align-items: center;
  gap: clamp(36px, 7vw, 88px);
}

.about-eyebrow,
.about-section__label,
.about-section__heading > p,
.about-privacy-callout > div > p {
  margin: 0 0 12px;
  color: #78716b;
  font-size: 0.75rem;
  font-weight: 760;
  letter-spacing: 0.13em;
  text-transform: uppercase;
}

.about-hero h1 {
  margin: 0;
  color: #17181c;
  font-size: clamp(4rem, 10vw, 8.5rem);
  font-weight: 820;
  letter-spacing: -0.075em;
  line-height: 0.86;
}

.about-lead {
  max-width: 670px;
  margin: 34px 0 0;
  color: #58534f;
  font-size: clamp(1.05rem, 2vw, 1.28rem);
  line-height: 1.9;
}

.about-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 32px;
}

.about-action {
  display: inline-flex;
  min-height: 48px;
  padding: 0 18px;
  align-items: center;
  justify-content: center;
  gap: 9px;
  color: #25262a;
  border: 1px solid rgba(36, 36, 36, 0.17);
  border-radius: 999px;
  font-size: 0.88rem;
  font-weight: 700;
  transition: transform 0.16s ease, border-color 0.16s ease, background-color 0.16s ease;
}

.about-action:hover {
  border-color: rgba(36, 36, 36, 0.42);
  transform: translateY(-2px);
}

.about-action--primary {
  color: #fff;
  background: #1e2024;
  border-color: #1e2024;
}

.about-action--primary:hover {
  background: #34363c;
  border-color: #34363c;
}

.about-brand-card {
  min-height: 360px;
  display: grid;
  place-items: center;
  padding: clamp(28px, 5vw, 56px);
  overflow: hidden;
  background:
    linear-gradient(145deg, rgba(255, 255, 255, 0.96), rgba(239, 236, 231, 0.94));
  border: 1px solid rgba(36, 36, 36, 0.12);
  border-radius: 38px 10px 38px 10px;
  box-shadow: 0 30px 80px rgba(27, 25, 23, 0.13);
}

.about-brand-card img {
  width: min(100%, 520px);
  display: block;
}

.about-section {
  margin-top: clamp(76px, 12vw, 144px);
}

.about-section__heading {
  max-width: 760px;
}

.about-section h2,
.about-privacy-callout h2 {
  margin: 0;
  color: #1d1e22;
  font-size: clamp(1.8rem, 4vw, 3.35rem);
  letter-spacing: -0.045em;
  line-height: 1.12;
  text-wrap: balance;
}

.about-purpose-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-top: 36px;
}

.about-purpose-card {
  min-height: 230px;
  padding: 26px;
  background: rgba(255, 255, 255, 0.72);
  border: 1px solid rgba(36, 36, 36, 0.11);
  border-radius: 22px;
}

.about-purpose-card__icon {
  width: 46px;
  height: 46px;
  display: grid;
  place-items: center;
  color: #25262a;
  background: #ece9e4;
  border-radius: 14px;
}

.about-purpose-card h3 {
  margin: 38px 0 8px;
  color: #222327;
  font-size: 1.08rem;
}

.about-purpose-card p {
  margin: 0;
  color: #67615c;
  font-size: 0.88rem;
  line-height: 1.75;
}

.about-google {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
  gap: clamp(34px, 7vw, 92px);
  padding: clamp(28px, 5vw, 56px);
  background: #202126;
  border-radius: 34px;
}

.about-google h2 {
  color: #fff;
  font-size: clamp(2rem, 4vw, 3.7rem);
}

.about-google__content {
  color: #cfcbc5;
  line-height: 1.8;
}

.about-google__content > p {
  margin: 0;
}

.about-google__content > p + p,
.about-google__content ul + p {
  margin-top: 20px;
}

.about-google__content ul {
  display: grid;
  gap: 9px;
  margin: 24px 0;
}

.about-google__content li {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.065);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
}

.about-google__content code {
  color: #fff;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.82rem;
  font-weight: 750;
}

.about-google__notice {
  padding: 18px;
  color: #f3f1ee;
  background: rgba(255, 255, 255, 0.08);
  border-left: 3px solid #c7a987;
  border-radius: 4px 14px 14px 4px;
}

.about-privacy-callout {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 20px;
  margin-top: clamp(72px, 11vw, 128px);
  padding: clamp(24px, 4vw, 38px);
  align-items: center;
  background: rgba(255, 255, 255, 0.78);
  border: 1px solid rgba(36, 36, 36, 0.14);
  border-radius: 26px;
}

.about-privacy-callout__icon {
  width: 54px;
  height: 54px;
  display: grid;
  place-items: center;
  background: #ece8e2;
  border-radius: 16px;
}

.about-privacy-callout h2 {
  max-width: 680px;
  font-size: clamp(1.45rem, 3vw, 2.4rem);
}

.about-privacy-callout > a {
  display: inline-flex;
  min-height: 48px;
  padding: 0 18px;
  align-items: center;
  color: #fff;
  background: #1f2024;
  border-radius: 999px;
  font-size: 0.88rem;
  font-weight: 720;
}

.about-contact {
  margin: 26px 0 0;
  color: #77716b;
  font-size: 0.84rem;
  text-align: center;
}

.about-contact a {
  color: #26272b;
  text-decoration: underline;
  text-underline-offset: 4px;
}

@media (max-width: 820px) {
  .about-hero,
  .about-google {
    grid-template-columns: 1fr;
  }

  .about-brand-card {
    min-height: 280px;
  }

  .about-purpose-grid {
    grid-template-columns: 1fr;
  }

  .about-purpose-card {
    min-height: auto;
  }
}

@media (max-width: 620px) {
  .about-page {
    padding-top: 46px;
  }

  .about-hero h1 {
    font-size: clamp(3.6rem, 22vw, 5.6rem);
  }

  .about-brand-card {
    min-height: 230px;
    border-radius: 26px 8px 26px 8px;
  }

  .about-actions,
  .about-action {
    width: 100%;
  }

  .about-google {
    padding: 26px 20px;
    border-radius: 24px;
  }

  .about-google__content li {
    grid-template-columns: 74px minmax(0, 1fr);
  }

  .about-privacy-callout {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .about-privacy-callout > a {
    grid-column: 1 / -1;
    width: 100%;
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .about-action {
    transition-duration: 0.01ms;
  }
}
</style>
