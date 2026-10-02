// 全局页面功能测试：库、浏览、管理、主页
const { test, expect } = require('@playwright/test')
const { beforeEachAuth, saveShot, finishCase, installFailureRecorder, createCollector } = require('./common')

installFailureRecorder(test)
test.beforeEach(beforeEachAuth)

test('feature-library 库页-新建决策服务对话框与服务卡片', async ({ page }) => {
  const col = createCollector(page)
  const id = 'feature-library'
  await page.goto('/library', { waitUntil: 'networkidle' })

  // 服务卡片可见
  await expect(page.getByText('个人贷款审批').first()).toBeVisible()
  await expect(page.getByText('粮库温控决策').first()).toBeVisible()

  // 打开新建对话框
  await page.getByRole('button', { name: '新建决策服务' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const shots = [await saveShot(page, id, '新建决策服务对话框')]
  // 关闭对话框（Modal 右上角关闭按钮）
  await dialog.getByTitle('关闭').click()
  await expect(dialog).toBeHidden()

  // 点击服务卡片进入默认项目
  await page.getByText('个人贷款审批').click()
  await page.waitForURL(/\/projects\/default/, { timeout: 15_000 })
  await expect(page.getByText('新建规则').first()).toBeVisible()
  shots.push(await saveShot(page, id, '进入默认项目'))

  const issues = col.stop()
  finishCase({ id, title: '库页-新建决策服务对话框与服务卡片跳转', status: 'passed', issues, screenshots: shots })
})

test('feature-explore 浏览页-搜索/筛选/清除/重载', async ({ page }) => {
  const col = createCollector(page)
  const id = 'feature-explore'
  await page.goto('/explore', { waitUntil: 'networkidle' })
  await expect(page.getByRole('table').getByRole('row')).not.toHaveCount(1)

  // 搜索：按 BOM 业务术语搜索
  await page.getByPlaceholder('规则名 / 业务术语 / BOM 字段').fill('信用')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.waitForTimeout(1200)
  const shots = [await saveShot(page, id, '搜索信用')]

  // 类型筛选
  await page.getByLabel('筛选资产类型').selectOption({ label: 'BAL 规则' })
  await page.waitForTimeout(800)
  shots.push(await saveShot(page, id, '筛选BAL规则'))

  // 清除筛选
  await page.getByRole('button', { name: '清除筛选' }).click()
  await page.waitForTimeout(800)
  await expect(page.getByPlaceholder('规则名 / 业务术语 / BOM 字段')).toHaveValue('')
  shots.push(await saveShot(page, id, '清除筛选后'))

  // CEP 项目必须按事件流索引，不能请求 Rules 专用的 /flows。
  await page.getByLabel('筛选资产类型').selectOption({ label: '事件流' })
  await expect.poll(() => page.getByRole('table').getByRole('row').count()).toBeGreaterThan(1)
  await expect(page.getByRole('table').getByText(/^事件流 ·/).first()).toBeVisible()
  await page.getByLabel('筛选资产类型').selectOption({ label: '全部类型' })

  // 重新加载
  await page.getByRole('button', { name: '刷新目录' }).click()
  await expect(page.getByRole('button', { name: '刷新目录' })).toBeEnabled({ timeout: 15_000 })
  shots.push(await saveShot(page, id, '重新加载'))

  const issues = col.stop()
  finishCase({ id, title: '浏览页-搜索筛选清除重载', status: 'passed', issues, screenshots: shots })
})

test('feature-admin 管理页-Tab切换与新增用户', async ({ page }) => {
  const col = createCollector(page)
  const id = 'feature-admin'
  await page.goto('/admin', { waitUntil: 'networkidle' })
  const shots = []

  // 三个 Tab 切换（role=tab）
  for (const tab of ['用户', '角色与权限', '环境与 RES']) {
    await page.getByRole('tab', { name: tab, exact: true }).click()
    await page.waitForTimeout(600)
    shots.push(await saveShot(page, id, `Tab-${tab}`))
  }

  // 回到用户 Tab，新增用户（行内表单，非对话框）
  await page.getByRole('tab', { name: '用户', exact: true }).click()
  await page.getByRole('button', { name: '新增用户' }).click()
  const userForm = page.getByLabel('新增用户', { exact: true })
  await expect(userForm).toBeVisible()
  shots.push(await saveShot(page, id, '新增用户表单'))
  // 关闭表单
  await userForm.getByLabel('关闭').click()
  await expect(userForm).toBeHidden()

  const issues = col.stop()
  finishCase({ id, title: '管理页-Tab切换与新增用户', status: 'passed', issues, screenshots: shots })
})

test('feature-home 主页-导航与内容', async ({ page }) => {
  const col = createCollector(page)
  const id = 'feature-home'
  await page.goto('/home', { waitUntil: 'networkidle' })
  // 主页有内容（导航 + 信息区）
  await expect(page.getByRole('heading', { name: '欢迎，wallace' })).toBeVisible()
  await expect(page.getByLabel('最近活动列表')).toBeVisible()
  await expect(page.getByText('陈分析师发布了')).toHaveCount(0)
  await expect(page.getByRole('link', { name: '库' })).toBeVisible()
  await expect(page.getByRole('link', { name: '浏览' })).toBeVisible()
  const shots = [await saveShot(page, id, '主页全景')]
  // 通过顶部导航切换到库
  await page.getByRole('link', { name: '库' }).click()
  await page.waitForURL(/\/library$/)
  shots.push(await saveShot(page, id, '导航到库'))
  const issues = col.stop()
  finishCase({ id, title: '主页-导航与内容', status: 'passed', issues, screenshots: shots })
})
