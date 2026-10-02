// CEP 项目功能测试：事件流编辑、编译、保存
const { test, expect } = require('@playwright/test')
const { beforeEachAuth, saveShot, finishCase, installFailureRecorder, createCollector } = require('./common')

installFailureRecorder(test)
test.beforeEach(beforeEachAuth)

test('feature-cep 事件流页-选择/编辑/编译', async ({ page }) => {
  test.setTimeout(180_000)
  const col = createCollector(page)
  const id = 'feature-cep'
  await page.goto('/projects/project-6f50ddcf/event-streams', { waitUntil: 'domcontentloaded' })
  const shots = []

  // 事件流列表
  await expect(page.getByRole('button', { name: /氨气浓度复杂事件检测/ }).first()).toBeVisible()
  await page.getByRole('button', { name: /氨气浓度复杂事件检测/ }).first().click()
  await page.waitForTimeout(800)
  shots.push(await saveShot(page, id, '选中事件流'))

  // EPL 编辑器出现（高级 EPL 语句 + 预览）
  await expect(page.getByPlaceholder('说明')).toBeVisible()
  await expect(page.getByText('EPL 预览').first()).toBeVisible({ timeout: 15_000 })

  // 编译（真实编译，等待按钮从"编译中"恢复为可点的"编译"）
  await page.getByRole('button', { name: '编译', exact: true }).click()
  await page.getByRole('button', { name: '编译中', exact: true }).waitFor({ timeout: 15_000 }).catch(() => {})
  await expect(page.getByRole('button', { name: '编译', exact: true })).toBeEnabled({ timeout: 120_000 })
  await expect(page.getByText('编译通过，当前草稿可以保存或发布。')).toBeVisible({ timeout: 120_000 })
  shots.push(await saveShot(page, id, '编译结果'))

  // 新建按钮与保存按钮存在
  await expect(page.getByRole('button', { name: '新建', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible()

  // 从向导新建（打开模板面板）
  await page.getByRole('button', { name: '从向导新建' }).click()
  await page.waitForTimeout(800)
  shots.push(await saveShot(page, id, '从向导新建'))

  const issues = col.stop()
  finishCase({ id, title: 'CEP事件流-选择编辑编译', status: 'passed', issues, screenshots: shots })
})
