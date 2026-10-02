// 冒烟层：遍历全部路由，验证渲染不白屏、无 JS 异常
const { test, expect } = require('@playwright/test')
const { beforeEachAuth, saveShot, finishCase, installFailureRecorder, createCollector } = require('./common')

installFailureRecorder(test)

// 匿名页面（登录页）——不注入登录态
test('smoke-login 登录页渲染', async ({ page }) => {
  const col = createCollector(page)
  await page.goto('/login', { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { name: 'Decision Workbench' })).toBeVisible()
  await expect(page.getByRole('button', { name: /登\s*录/ })).toBeVisible()
  const shots = [await saveShot(page, 'smoke-login', '登录页')]
  const issues = col.stop()
  finishCase({ id: 'smoke-login', title: '登录页渲染与登录表单', status: 'passed', issues, screenshots: shots })
})

// 已登录页面冒烟清单：路由 | 期望出现的标志元素
const SMOKE_PAGES = [
  { id: 'smoke-home', url: '/home', marker: '主页' },
  { id: 'smoke-library', url: '/library', marker: '新建决策服务' },
  { id: 'smoke-explore', url: '/explore', marker: '搜索' },
  { id: 'smoke-admin', url: '/admin', marker: '用户' },
  { id: 'smoke-project-index', url: '/projects/default', expectUrl: /assets$/, marker: '新建规则' },
  { id: 'smoke-project-assets', url: '/projects/default/assets', marker: '新建规则' },
  { id: 'smoke-project-flow', url: '/projects/default/flow', marker: '新建规则流' },
  { id: 'smoke-project-bom', url: '/projects/default/bom', marker: '编辑模型' },
  { id: 'smoke-project-tests', url: '/projects/default/tests', marker: '新建套件' },
  { id: 'smoke-project-reviews', url: '/projects/default/reviews', marker: '审核' },
  { id: 'smoke-project-releases', url: '/projects/default/releases', marker: '构建新 Release' },
  { id: 'smoke-project-report', url: '/projects/default/report', marker: '下载 HTML' },
  { id: 'smoke-cep-index', url: '/projects/project-6f50ddcf', expectUrl: /event-streams$/, marker: '保存' },
  { id: 'smoke-cep-event-streams', url: '/projects/project-6f50ddcf/event-streams', marker: '保存' },
  { id: 'smoke-drools-assets', url: '/projects/project-93d1309c/assets', marker: '新建规则' },
]

test.describe('已登录页面', () => {
  test.beforeEach(beforeEachAuth)

  for (const p of SMOKE_PAGES) {
    test(`${p.id} ${p.url} 渲染正常`, async ({ page }) => {
      const col = createCollector(page)
      await page.goto(p.url, { waitUntil: 'networkidle' })
      if (p.expectUrl) await expect(page).toHaveURL(p.expectUrl)
      // 非白屏：页面有可见文本
      const bodyText = await page.locator('body').innerText()
      expect(bodyText.trim().length).toBeGreaterThan(20)
      // 标志元素可见
      await expect(page.getByText(p.marker).first()).toBeVisible()
      const shots = [await saveShot(page, p.id, '页面全景')]
      const issues = col.stop()
      // 任意未预期 HTTP、console 或页面异常都会由 finishCase 阻断。
      finishCase({ id: p.id, title: `${p.url} 渲染冒烟`, status: 'passed', issues, screenshots: shots })
    })
  }
})
