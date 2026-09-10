// Called by the auth-only build runner; all records and network replies synthetic.
import assert from 'node:assert/strict'
import { join } from 'node:path'

export async function checkRegistrationAdminUi({ browser, origin, output }) {
  const checks = []
  for (const [width, height] of [[320, 640], [390, 900], [1440, 900]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block' })
    const page = await context.newPage(); page.setDefaultTimeout(12000)
    const errors = []; page.on('pageerror', e => errors.push(e.message))
    const admin = { id: '22222222-2222-4222-8222-222222222222', username: 'synthetic-admin', role: 'admin', status: 'approved' }
    let item = { id: '11111111-1111-4111-8111-111111111111', username: 'synthetic-applicant', email: 'applicant@example.test', status: 'pending', createdAt: '2026-01-01T00:00:00Z' }
    let signedIn = false, writeCount = 0, failRefresh = false, failDecision = false, releaseDecision
    await context.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== origin) return route.abort()
      if (!url.pathname.startsWith('/api/')) return route.continue()
      let body = {}, status = 200
      if (url.pathname === '/api/auth/session') body = { user: signedIn ? admin : null }
      else if (url.pathname === '/api/auth/login') { signedIn = true; body = { user: admin } }
      else if (url.pathname === '/api/auth/capabilities') body = { password: true, emailLogin: false }
      else if (url.pathname === '/api/auth/oauth/config') body = { providers: { google: { enabled: false }, wechat: { enabled: false } } }
      else if (/\/admin\/registration-requests\/[^/]+\/(approve|reject)$/.test(url.pathname)) {
        assert.equal(route.request().method(), 'POST'); writeCount++
        await new Promise(resolve => { releaseDecision = resolve })
        if (failDecision) { status = 500; body = { error: 'Request failed' } }
        else { item = { ...item, status: url.pathname.endsWith('/approve') ? 'approved' : 'rejected', decidedBy: admin.id, updatedAt: '2026-01-01T01:00:00Z' }; body = { request: item, notification: { mailStatus: 'pending' } } }
      }
      else if (url.pathname === '/api/admin/registration-requests') {
        status = failRefresh ? 503 : 200
        body = { requests: url.searchParams.get('status') === 'pending' ? (item.status === 'pending' ? [item] : []) : [item] }
      }
      else if (url.pathname === '/api/admin/users') { status = failRefresh ? 503 : 200; body = { users: item.status === 'approved' ? [admin, { ...item, role: 'user' }] : [admin] } }
      else if (url.pathname === '/api/admin/mail/status') body = { mail: { enabled: true, configured: true } }
      else if (url.pathname.includes('/settings')) body = { value: null, settings: {} }
      else if (url.pathname.includes('/notifications')) body = { notifications: [], unreadCount: 0 }
      else if (url.pathname.includes('/bookmarks')) body = { bookmarks: [] }
      else if (url.pathname.includes('/groups')) body = { groups: [] }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    })
    const target = `${origin}/settings?category=users&request=${item.id}`
    await page.goto(target, { waitUntil: 'networkidle' })
    await page.getByLabel('用户名', { exact: true }).fill('synthetic-admin')
    assert.equal(new URL(page.url()).pathname, '/auth', 'Mail link requires login')
    assert.equal(new URL(page.url()).searchParams.get('redirect'), `/settings?category=users&request=${item.id}`)
    await page.getByLabel('密码', { exact: true }).fill('synthetic-password-long')
    await page.locator('.auth-form').getByRole('button', { name: '登录', exact: true }).click()
    await page.getByLabel('邮件对应的注册申请').waitFor()
    assert.equal(writeCount, 0, 'Opening mail link never makes a decision')
    await page.getByRole('button', { name: '批准此申请', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await page.getByRole('dialog', { name: '批准注册申请', exact: true }).waitFor()
    assert.equal(writeCount, 0, 'Confirmation is required')
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await page.getByRole('button', { name: '批准此申请', exact: true }).evaluate(e => e === document.activeElement), true)
    assert.equal(writeCount, 0)

    // Reproduce the original problem: open from the normal pending row, far below the header.
    const rowApprove = page.locator('.request-card').getByRole('button', { name: '批准', exact: true })
    await rowApprove.evaluate(e => e.scrollIntoView({ block: 'center', behavior: 'instant' }))
    const scrollBefore = await page.evaluate(() => scrollY)
    assert.ok(scrollBefore > 200, 'Fixture must actually be scrolled away from the header')
    await rowApprove.click()
    await dialog.waitFor()
    const cancel = dialog.getByRole('button', { name: '取消', exact: true })
    await page.waitForFunction(() => document.activeElement?.classList.contains('decision-cancel'))
    const bounds = await dialog.boundingBox()
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1, 'Modal must fit the current viewport')
    assert.ok(Math.abs(bounds.y + bounds.height / 2 - height / 2) < 2, 'Modal is viewport centered')
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - scrollBefore) <= 2, 'Opening must not jump the page')
    assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden')
    await page.keyboard.press('Shift+Tab')
    assert.equal(await dialog.getByRole('button', { name: '关闭弹窗' }).evaluate(e => e === document.activeElement), true)
    await page.keyboard.press('Shift+Tab')
    assert.equal(await dialog.getByRole('button', { name: '确认批准' }).evaluate(e => e === document.activeElement), true)
    await page.keyboard.press('Tab')
    assert.equal(await dialog.getByRole('button', { name: '关闭弹窗' }).evaluate(e => e === document.activeElement), true)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await rowApprove.evaluate(e => e === document.activeElement), true, 'Escape returns focus to the row action')
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - scrollBefore) <= 2, 'Closing must preserve list position')
    assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden')
    for (const closeWith of ['backdrop', 'close button', 'cancel']) {
      await rowApprove.click(); await dialog.waitFor()
      if (closeWith === 'backdrop') await page.locator('.modal-overlay').click({ position: { x: 4, y: 4 } })
      else if (closeWith === 'close button') await dialog.getByRole('button', { name: '关闭弹窗' }).click()
      else await cancel.click()
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(await rowApprove.evaluate(e => e === document.activeElement), true, `${closeWith} restores focus`)
    }
    assert.equal(writeCount, 0, 'Opening and all cancel paths make no approval request')
    await rowApprove.click(); await dialog.waitFor()
    // Long applicant details and short mobile viewports must not hide the footer.
    await page.locator('.decision-applicant').evaluate(e => {
      e.querySelector('strong').textContent = 'long-synthetic-applicant-'.repeat(5)
      e.querySelector('span:last-child').textContent = 'long-synthetic-address-'.repeat(5) + '@example.test'
    })
    const confirmBounds = await dialog.getByRole('button', { name: '确认批准' }).boundingBox()
    assert.ok(confirmBounds.y >= 0 && confirmBounds.y + confirmBounds.height <= height, 'Footer remains visible with long details')
    assert.equal(await dialog.evaluate(e => e.scrollWidth > e.clientWidth + 1), false, 'Long details must wrap')
    await cancel.click(); await dialog.waitFor({ state: 'hidden' })
    await rowApprove.click(); await dialog.waitFor()
    await page.screenshot({ path: join(output, `admin-confirm-modal-${width}.png`) })
    checks.push(`${width}x${height}: scrolled-row centered modal, safe initial focus, focus trap, Escape/backdrop/close/cancel restoration, scroll lock, long details and visible footer`)
    const request = page.waitForRequest(r => r.url().endsWith('/approve'))
    await page.getByRole('button', { name: '确认批准', exact: true }).click(); await request
    assert.equal(await page.getByRole('button', { name: '处理中…', exact: true }).isDisabled(), true)
    assert.equal(await cancel.isDisabled(), true)
    assert.equal(await dialog.getByRole('button', { name: '关闭弹窗' }).isDisabled(), true)
    await page.keyboard.press('Escape')
    await page.locator('.modal-overlay').click({ position: { x: 4, y: 4 } })
    assert.equal(await dialog.isVisible(), true, 'Busy modal cannot be dismissed')
    await page.getByRole('button', { name: '处理中…', exact: true }).evaluate(e => e.click())
    assert.equal(writeCount, 1, 'Busy clicks cannot duplicate the decision')
    await page.waitForTimeout(50); releaseDecision()
    await page.getByRole('status').filter({ hasText: '结果邮件已进入发送队列' }).waitFor()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await page.getByLabel('注册审批列表', { exact: true }).evaluate(e => e === document.activeElement), true, 'Removed row returns focus to pending section without header jump')
    assert.equal(await page.locator('.request-list').count(), 0)
    assert.equal(await page.locator('.summary-card').filter({ hasText: '待审批申请' }).locator('strong').innerText(), '0')
    assert.equal(await page.locator('.summary-card').filter({ hasText: '已批准用户' }).locator('strong').innerText(), '2')
    assert.match(await page.getByLabel('邮件对应的注册申请').innerText(), /已批准/)
    assert.ok(await page.locator('.table__row').filter({ hasText: '普通用户' }).count())
    assert.ok(await page.locator('.table__row').filter({ hasText: '已批准' }).count())
    assert.equal(writeCount, 1)
    await page.screenshot({ path: join(output, `admin-approved-${width}.png`), fullPage: true })
    checks.push(`${width}: login redirect, explicit confirmation, busy guard, automatic pending/users/history refresh`)

    // Rejection acknowledged, then a secondary refresh fails: do not restore the stale pending row.
    item = { ...item, status: 'pending' }; await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '拒绝此申请', exact: true }).click()
    failRefresh = true
    const rejectRequest = page.waitForRequest(r => r.url().endsWith('/reject'))
    await page.getByRole('button', { name: '确认拒绝', exact: true }).click(); await rejectRequest
    await page.waitForTimeout(50); releaseDecision()
    await page.getByRole('button', { name: '刷新审批列表', exact: true }).waitFor()
    assert.equal(await page.locator('.request-list').count(), 0)
    assert.match(await page.getByLabel('邮件对应的注册申请').innerText(), /已拒绝/)
    assert.equal(await page.getByRole('button', { name: '批准此申请', exact: true }).count(), 0)
    failRefresh = false
    await page.getByRole('button', { name: '刷新审批列表', exact: true }).click()
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(e => e.textContent === '刷新审批列表'))
    checks.push(`${width}: failed refresh preserves acknowledged decision, manual retry converges`)

    // Failure to approve must remain pending, with actionable UI and no success message.
    item = { ...item, status: 'pending' }; failDecision = true
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '批准此申请', exact: true }).click()
    const failedRequest = page.waitForRequest(r => r.url().endsWith('/approve'))
    await page.getByRole('button', { name: '确认批准', exact: true }).click(); await failedRequest
    await page.waitForTimeout(50); releaseDecision()
    await page.getByRole('alert').filter({ hasText: '未能确认审批完成' }).waitFor()
    assert.equal(await dialog.getByRole('alert').isVisible(), true, 'Failure stays in the modal, not behind it')
    assert.equal(await dialog.getByRole('button', { name: '确认批准' }).isDisabled(), true, 'Uncertain result requires refresh before another decision')
    assert.equal(await page.locator('.request-list .request-card').count(), 1)
    assert.equal(await page.getByRole('status').filter({ hasText: '申请已批准' }).count(), 0)
    failRefresh = true
    await dialog.getByRole('button', { name: '刷新审批列表', exact: true }).click()
    await dialog.getByRole('alert').filter({ hasText: '列表刷新失败' }).waitFor()
    failRefresh = false
    await dialog.getByRole('button', { name: '刷新审批列表', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await page.locator('.request-list .request-card').count(), 1)
    assert.equal(writeCount, 3, 'Refreshing after failure does not retry a mutation')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    assert.deepEqual(errors, [])
    checks.push(`${width}: decision failure visible without false success or lost pending application`)
    await context.close()
  }
  return checks
}
