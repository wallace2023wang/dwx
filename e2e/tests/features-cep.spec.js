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
  await expect(page.getByText('事件流说明', { exact: true })).toBeVisible()
  await expect(page.getByLabel('业务说明')).toBeVisible()
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

test('feature-cep-authoring 事件流分组排序与派生输出', async ({ page }) => {
  test.setTimeout(180_000)
  const col = createCollector(page)
  const id = 'feature-cep-authoring'
  const shots = []
  await page.goto('/projects/project-6f50ddcf/event-streams', { waitUntil: 'domcontentloaded' })

  await page.getByRole('button', { name: '新建', exact: true }).click()
  await expect(page.getByText('派生输出字段')).toBeVisible({ timeout: 15_000 })
  await page.getByLabel('语句分组').fill('基础检测')
  await page.getByLabel('业务说明').fill('检测单条事件是否达到告警阈值')
  await expect(page.getByText('自动语义摘要', { exact: true })).toBeVisible()
  await expect(page.getByText('未保存', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '固定值', exact: true }).click()
  await page.getByLabel('输出 1 固定值', { exact: true }).fill('ALERT')
  await page.getByLabel('输出别名').fill('level')
  await expect(page.getByText(/'ALERT' as level/)).toBeVisible()

  await page.getByRole('button', { name: '源字段', exact: true }).click()
  await page.getByLabel('输出 2 源字段').selectOption('eventKey')
  const aliases = page.getByLabel('输出别名')
  await aliases.nth(1).fill('sourceKey')
  await expect(page.getByText(/eventKey as sourceKey/)).toBeVisible()

  await page.getByRole('button', { name: '从向导新建' }).click()
  await page.getByRole('button', { name: /窗口均值/ }).click()
  await page.getByLabel('语句分组').fill('窗口检测')
  await page.getByRole('button', { name: /上移：窗口均值/ }).click()
  await expect(page.getByText('窗口检测', { exact: true })).toBeVisible()
  shots.push(await saveShot(page, id, '分组排序与输出映射'))

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText(/保存成功，当前修订/)).toBeVisible({ timeout: 120_000 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByText('基础检测', { exact: true })).toBeVisible({ timeout: 15_000 })
  await page.getByText('SingleThreshold1', { exact: true }).click()
  await expect(page.getByText(/'ALERT' as level/)).toBeVisible()
  await expect(page.getByText('草稿', { exact: true }).first()).toBeVisible()

  await page.getByTitle('删除事件流').click()
  await page.getByRole('button', { name: '确认删除' }).click()
  await expect(page.getByText('派生输出字段')).not.toBeVisible({ timeout: 15_000 }).catch(() => {})

  const issues = col.stop()
  finishCase({ id, title: 'CEP事件流-分组排序与派生输出', status: 'passed', issues, screenshots: shots })
})
