<script setup>
defineProps({
  currentPage: {
    type: String,
    default: ''
  }
})
</script>

<template>
  <div class="public-info-page">
    <a class="public-skip-link" href="#public-page-content">跳到正文</a>

    <header class="public-header">
      <RouterLink class="public-brand" to="/about" aria-label="DOMO NAV 关于页面">
        <span>DOMO NAV</span>
        <small>自托管个人工作入口</small>
      </RouterLink>

      <nav class="public-nav" aria-label="公开页面导航">
        <RouterLink to="/about" :aria-current="currentPage === 'about' ? 'page' : undefined">
          关于
        </RouterLink>
        <RouterLink to="/privacy" :aria-current="currentPage === 'privacy' ? 'page' : undefined">
          隐私政策
        </RouterLink>
        <RouterLink class="public-nav__login" to="/auth">登录</RouterLink>
      </nav>
    </header>

    <main id="public-page-content" class="public-content" tabindex="-1">
      <slot />
    </main>

    <footer class="public-footer">
      <p>DOMO NAV</p>
      <nav aria-label="页脚导航">
        <RouterLink to="/about">关于 DOMO NAV</RouterLink>
        <RouterLink to="/privacy">隐私政策</RouterLink>
        <a href="mailto:cristsaudomo@gmail.com">cristsaudomo@gmail.com</a>
      </nav>
    </footer>
  </div>
</template>

<style scoped>
.public-info-page {
  min-height: 100vh;
  padding: 0 clamp(18px, 4vw, 56px) 40px;
  color: #242424;
  background:
    radial-gradient(circle at 8% 0%, rgba(34, 34, 34, 0.075), transparent 30rem),
    radial-gradient(circle at 92% 18%, rgba(146, 112, 82, 0.1), transparent 28rem),
    #f8f7f4;
}

.public-skip-link {
  position: fixed;
  top: 10px;
  left: 12px;
  z-index: 10;
  padding: 10px 14px;
  color: #fff;
  background: #1f2024;
  border-radius: 10px;
  transform: translateY(-160%);
  transition: transform 0.16s ease;
}

.public-skip-link:focus {
  transform: translateY(0);
}

.public-header,
.public-footer,
.public-content {
  width: min(1120px, 100%);
  margin-inline: auto;
}

.public-header {
  display: flex;
  min-height: 84px;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  border-bottom: 1px solid rgba(36, 36, 36, 0.12);
}

.public-brand {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.public-brand span {
  font-size: 0.92rem;
  font-weight: 800;
  letter-spacing: 0.18em;
}

.public-brand small {
  color: #77716b;
  font-size: 0.68rem;
  letter-spacing: 0.04em;
}

.public-nav {
  display: flex;
  align-items: center;
  gap: 6px;
}

.public-nav a {
  display: inline-flex;
  min-height: 44px;
  padding: 0 14px;
  align-items: center;
  justify-content: center;
  color: #625d58;
  border-radius: 999px;
  font-size: 0.84rem;
  font-weight: 650;
  transition: color 0.16s ease, background-color 0.16s ease, transform 0.16s ease;
}

.public-nav a:hover,
.public-nav a[aria-current='page'] {
  color: #17181c;
  background: rgba(36, 36, 36, 0.07);
}

.public-nav a:hover {
  transform: translateY(-1px);
}

.public-nav .public-nav__login {
  color: #fff;
  background: #1f2024;
}

.public-nav .public-nav__login:hover {
  color: #fff;
  background: #35373d;
}

.public-content {
  outline: none;
}

.public-footer {
  display: flex;
  padding-top: 28px;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  color: #77716b;
  border-top: 1px solid rgba(36, 36, 36, 0.12);
  font-size: 0.78rem;
}

.public-footer > p {
  color: #28292d;
  font-weight: 780;
  letter-spacing: 0.14em;
}

.public-footer nav {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px 20px;
}

.public-footer a {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
}

.public-footer a:hover {
  color: #17181c;
  text-decoration: underline;
  text-underline-offset: 4px;
}

@media (max-width: 680px) {
  .public-info-page {
    padding-inline: 16px;
  }

  .public-header {
    min-height: auto;
    padding: 18px 0 16px;
    align-items: flex-start;
    flex-direction: column;
    gap: 14px;
  }

  .public-nav {
    width: 100%;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .public-nav a {
    padding-inline: 8px;
  }

  .public-footer {
    flex-direction: column;
  }

  .public-footer nav {
    justify-content: flex-start;
  }
}

@media (prefers-reduced-motion: reduce) {
  .public-skip-link,
  .public-nav a {
    transition-duration: 0.01ms;
  }
}
</style>
