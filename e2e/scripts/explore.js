// 页面功能清单探索脚本：dump 每个页面的可交互元素 + 截图
// 运行: node scripts/explore.js
const { chromium } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const { injectAuth } = require('../helpers/auth-init')

const BASE = 'http://127.0.0.1:5180'
const OUT_DIR = path.join(__dirname, '..', 'output', 'explore')
const AUTH_STATE = path.join(__dirname, '..', '.auth', 'session.json')

const PAGES = [
  { id: 'login', url: '/login', auth: false },
  { id: 'home', url: '/home' },
  { id: 'library', url: '/library' },
  { id: 'explore', url: '/explore' },
  { id: 'admin', url: '/admin' },
  { id: 'project-default-index', url: '/projects/default' },
  { id: 'project-default-assets', url: '/projects/default/assets' },
  { id: 'project-default-flow', url: '/projects/default/flow' },
  { id: 'project-default-bom', url: '/projects/default/bom' },
  { id: 'project-default-tests', url: '/projects/default/tests' },
  { id: 'project-default-reviews', url: '/projects/default/reviews' },
  { id: 'project-default-releases', url: '/projects/default/releases' },
  { id: 'project-default-report', url: '/projects/default/report' },
  { id: 'project-cep-index', url: '/projects/project-6f50ddcf' },
  { id: 'project-cep-event-streams', url: '/projects/project-6f50ddcf/event-streams' },
  { id: 'project-drools-assets', url: '/projects/project-93d1309c/assets' },
]

async function collectInteractives(page) {
  const items = await page.evaluate(() => {
    const out = []
    const seen = new Set()
    const sel = 'button, a[href], [role="tab"], [role="button"], input[type="checkbox"], input[type="text"], input:not([type]), textarea, select, [contenteditable="true"]'
    document.querySelectorAll(sel).forEach((el) => {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return // 不可见
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') return
      const key = el.tagName + '|' + (el.textContent || '').trim().slice(0, 40)
      if (seen.has(key)) return
      seen.add(key)
      out.push({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
        name: (el.getAttribute('aria-label') || '').slice(0, 60),
        href: el.getAttribute('href') || '',
        placeholder: el.getAttribute('placeholder') || '',
      })
    })
    return out
  })
  return items
}

;(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })

  const browser = await chromium.launch({ channel: 'chrome', headless: true })

  // 若无登录态，先自行登录
  if (!fs.existsSync(AUTH_STATE)) {
    console.log('未找到登录态，正在自动登录...')
    const ctx = await browser.newContext()
    const pg = await ctx.newPage()
    await pg.goto(BASE + '/login', { waitUntil: 'networkidle' })
    await pg.fill('#username', 'wallace')
    await pg.fill('#password', 'rules123')
    await pg.getByRole('button', { name: /登\s*录/ }).click()
    await pg.waitForURL(/\/library$/, { timeout: 15_000 })
    await pg.waitForTimeout(1200)
    const dir = path.dirname(AUTH_STATE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const sessionValue = await pg.evaluate(() => sessionStorage.getItem('rts-session'))
    fs.writeFileSync(path.join(dir, 'session.json'), sessionValue)
    await ctx.close()
    console.log('登录成功')
  }

  const results = []

  for (const p of PAGES) {
    const context = await browser.newContext()
    if (p.auth !== false) await injectAuth(context)
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    try {
      await page.goto(BASE + p.url, { waitUntil: 'networkidle', timeout: 30_000 })
      await page.waitForTimeout(800)
      const interactives = await collectInteractives(page)
      const title = await page.title()
      const shot = path.join(OUT_DIR, `${p.id}.png`)
      await page.screenshot({ path: shot, fullPage: false })
      results.push({ id: p.id, url: p.url, title, pageErrors, interactives, screenshot: shot })
      console.log(`[${p.id}] ${p.url} -> ${interactives.length} 个交互元素, 标题="${title}"${pageErrors.length ? ' 有页面异常: ' + pageErrors.join('; ') : ''}`)
    } catch (e) {
      results.push({ id: p.id, url: p.url, error: e.message, screenshot: null })
      console.log(`[${p.id}] ${p.url} -> 访问失败: ${e.message}`)
    } finally {
      await context.close()
    }
  }
  await browser.close()

  fs.writeFileSync(path.join(__dirname, '..', 'output', 'explore-pages.json'), JSON.stringify(results, null, 2))
  console.log('\n完成，结果写入 output/explore-pages.json')
})().catch((e) => { console.error(e); process.exit(1) })
