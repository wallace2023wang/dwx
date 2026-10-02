// 默认项目各页功能测试：资产、规则流、BOM、测试、审核、发布、报告
const { test, expect } = require('@playwright/test')
const { beforeEachAuth, saveShot, finishCase, installFailureRecorder, createCollector } = require('./common')

installFailureRecorder(test)
test.beforeEach(beforeEachAuth)

test('feature-assets 资产页-包树/筛选/搜索/新建规则', async ({ page }) => {
  const col = createCollector(page)
  const id = 'feature-assets'
  await page.goto('/projects/default/assets', { waitUntil: 'networkidle' })
  const shots = []

  // 包树展开
  await expect(page.getByRole('button', { name: /common 通用/ }).first()).toBeVisible()
  await page.getByRole('button', { name: /credit_risk 信贷风控/ }).click()
  await page.waitForTimeout(600)
  shots.push(await saveShot(page, id, '包树展开credit_risk'))

  // 类型筛选
  await page.getByLabel('资产类型').selectOption({ label: '决策表' })
  await page.waitForTimeout(800)
  shots.push(await saveShot(page, id, '筛选决策表'))
  await page.getByLabel('资产类型').selectOption({ label: '所有类型' })

  // 状态筛选
  await page.getByLabel('资产状态').selectOption({ label: '已发布' })
  await page.waitForTimeout(800)
  shots.push(await saveShot(page, id, '筛选已发布'))
  await page.getByLabel('资产状态').selectOption({ label: '全部状态' })

  // 搜索
  await page.getByPlaceholder('搜索规则').fill('评级')
  await page.waitForTimeout(800)
  shots.push(await saveShot(page, id, '搜索评级'))
  await page.getByPlaceholder('搜索规则').fill('')

  // 新建规则：创建对话框 → 填写 → 创建并打开（写操作，数据将恢复）
  await page.getByRole('button', { name: '新建规则' }).click()
  const createDialog = page.getByRole('dialog')
  await expect(createDialog).toBeVisible()
  await createDialog.getByPlaceholder('客户年龄不足拒绝').fill(`e2e规则_${Date.now().toString(36).slice(-6)}`)
  await createDialog.getByLabel('所属包').selectOption({ index: 1 })
  await createDialog.getByRole('button', { name: '创建并打开' }).click()

  const editor = page.getByLabel('BAL 规则编辑器')
  await expect(editor).toBeVisible({ timeout: 15_000 })
  shots.push(await saveShot(page, id, '新建规则编辑器'))

  // 条件右值切到业务字段，只能选择与“客户年龄”同为 Integer 的其他 input 字段。
  await editor.getByRole('button', { name: '业务字段', exact: true }).click()
  const valueField = editor.getByLabel('用于比较的业务字段')
  await expect(valueField).toBeVisible()
  await expect(valueField.locator('option')).toHaveCount(1)
  await expect(valueField.locator('option')).toHaveText(/· 信用评分/)
  await valueField.selectOption('creditScore')
  const enumSel = editor.getByLabel('枚举值').first()
  if (await enumSel.count()) {
    await enumSel.selectOption({ index: 1 })
  } else {
    const extra = editor.getByPlaceholder('输入值')
    if ((await extra.count()) > 1) await extra.nth(1).fill('true')
  }
  await editor.getByLabel('业务说明').fill('E2E 验收测试创建的临时规则')
  await expect(page.getByRole('button', { name: '保存草稿' })).toBeEnabled({ timeout: 10_000 })
  await page.getByRole('button', { name: '保存草稿' }).click()
  await expect(page.getByText(/BAL 草稿已保存/).first()).toBeVisible({ timeout: 15_000 })
  await expect(editor.getByLabel('用于比较的业务字段')).toHaveValue('creditScore')
  shots.push(await saveShot(page, id, '同类型业务字段比较已保存'))

  await editor.getByRole('button', { name: '编译', exact: true }).click()
  await expect(editor.getByText('Drools 编译通过')).toBeVisible({ timeout: 30_000 })

  // 将同一条件切回固定值，验证数字“介于”双输入和真实 Drools 编译。
  await editor.getByRole('button', { name: '固定值', exact: true }).click()
  await editor.getByLabel('比较符').selectOption('between')
  await editor.getByLabel('区间下界').fill('18')
  await editor.getByLabel('区间上界').fill('65')
  await expect(editor.getByRole('button', { name: '业务字段', exact: true })).toBeDisabled()
  await expect(editor.getByRole('button', { name: '保存草稿' })).toBeEnabled()
  await editor.getByRole('button', { name: '保存草稿' }).click()
  await expect(editor.getByText('BAL 草稿已保存')).toBeVisible({ timeout: 15_000 })
  await editor.getByRole('button', { name: '编译', exact: true }).click()
  await expect(editor.getByText('Drools 编译通过')).toBeVisible({ timeout: 30_000 })
  shots.push(await saveShot(page, id, '数字介于操作符已编译'))

  // 枚举“属于”使用结构化多选值，不依赖逗号拼接文本。
  await editor.getByRole('combobox', { name: '业务字段', exact: true }).selectOption('customerType')
  await editor.getByLabel('比较符').selectOption('in')
  await editor.getByLabel('枚举多选值').click()
  await editor.getByLabel('选择枚举值 企业').check()
  await expect(editor.getByLabel('枚举多选值')).toContainText('已选 2 项')
  await editor.getByRole('button', { name: '保存草稿' }).click()
  await expect(editor.getByText('BAL 草稿已保存')).toBeVisible({ timeout: 15_000 })
  await editor.getByRole('button', { name: '编译', exact: true }).click()
  await expect(editor.getByText('Drools 编译通过')).toBeVisible({ timeout: 30_000 })
  shots.push(await saveShot(page, id, '枚举属于多选已编译'))

  const issues = col.stop()
  finishCase({ id, title: '资产页-包树筛选搜索新建规则', status: 'passed', issues, screenshots: shots })
})

test('feature-advanced-bal 高级条件只读显示并可编译', async ({ page }) => {
  const col = createCollector(page)
  const id = 'feature-advanced-bal'
  await page.goto('/projects/project-63dbe140/assets?asset=c721380a-f8e6-47ab-864f-a53d3e340142', { waitUntil: 'networkidle' })

  const editor = page.getByLabel('BAL 规则编辑器')
  await expect(editor).toBeVisible({ timeout: 15_000 })
  await expect(page.getByLabel('BOM 引用失效')).toHaveCount(0)
  await expect(editor.getByRole('alert')).toHaveCount(0)
  await expect(editor.getByLabel('高级表达式')).toHaveCount(3)
  await expect(editor.getByText('nitrogenPct >= maxPct', { exact: true })).toBeVisible()
  await expect(editor.getByText('paused == false', { exact: true })).toBeVisible()
  await expect(editor.getByText('endReached == false', { exact: true })).toBeVisible()
  await expect(editor.getByText('字段已失效')).toHaveCount(0)
  await expect(editor.getByRole('button', { name: '保存草稿' })).toBeDisabled()
  await expect(editor.getByRole('button', { name: '编译' })).toBeEnabled()

  const shots = [await saveShot(page, id, '高级条件只读展示')]
  await editor.getByRole('button', { name: '编译' }).click()
  await expect(editor.getByText('Drools 编译通过')).toBeVisible({ timeout: 30_000 })
  shots.push(await saveShot(page, id, '高级条件编译通过'))

  const issues = col.stop()
  finishCase({ id, title: 'BAL高级条件-只读显示与编译', status: 'passed', issues, screenshots: shots })
})

test('feature-flow 规则流页-画布与编辑器操作', async ({ page }) => {
  const col = createCollector(page)
  const id = 'feature-flow'
  await page.goto('/projects/default/flow', { waitUntil: 'networkidle' })
  const shots = []

  // 流程选择器存在（RulesetConfig 下拉）
  await expect(page.getByLabel('选择规则流')).toBeVisible()
  // 画布渲染（ReactFlow 节点可能因布局动画短暂不可见，用尺寸检测等待）
  await page.waitForFunction(() => {
    const nodes = document.querySelectorAll('.react-flow__node')
    return nodes.length > 0 && Array.from(nodes).some((n) => {
      const r = n.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
  }, null, { timeout: 30_000 })
  await page.waitForTimeout(1000)
  shots.push(await saveShot(page, id, '规则流画布全景'))

  // 展开"结构化备用编辑"面板（添加步骤/条件分支/默认分支在折叠区内）
  await page.getByText('结构化备用编辑').click()
  await page.waitForTimeout(500)

  // 添加步骤
  await page.getByRole('button', { name: '添加步骤', exact: true }).click()
  await page.waitForTimeout(600)
  shots.push(await saveShot(page, id, '添加步骤面板'))

  // 条件分支 / 默认分支按钮存在
  await expect(page.getByRole('button', { name: '条件分支', exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '默认分支', exact: true }).first()).toBeVisible()

  // 校验（工具栏常驻按钮）
  await page.getByRole('button', { name: '校验', exact: true }).click()
  await expect(page.getByText(/Drools .*校验通过/)).toBeVisible({ timeout: 120_000 })
  shots.push(await saveShot(page, id, '校验结果'))

  // 若有多个规则流则切换（默认项目可能仅一个）
  const rulesetCount = await page.getByLabel('选择规则流').locator('option').count()
  if (rulesetCount > 1) {
    await page.getByLabel('选择规则流').selectOption({ index: 1 })
    await page.waitForTimeout(1200)
    shots.push(await saveShot(page, id, '切换流程'))
  }

  // 不保存，避免破坏既有流程
  const issues = col.stop()
  finishCase({ id, title: '规则流页-画布校验添加步骤', status: 'passed', issues, screenshots: shots })
})

test('feature-bom BOM页-编辑模型', async ({ page }) => {
  const col = createCollector(page)
  const id = 'feature-bom'
  await page.goto('/projects/default/bom', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '编辑模型', exact: true }).click()
  // BomEditor 为行内编辑面板（非对话框）
  await expect(page.getByRole('button', { name: '保存模型' })).toBeVisible({ timeout: 15_000 })
  const shots = [await saveShot(page, id, 'BOM 编辑模型')]
  // 验证字段列表出现
  await expect(page.getByText('RuleInput').or(page.getByText('风险等级')).first()).toBeVisible()
  // 取消不保存
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存模型' })).toBeHidden()
  const issues = col.stop()
  finishCase({ id, title: 'BOM页-编辑模型打开与取消', status: 'passed', issues, screenshots: shots })
})

test('feature-tests 测试套件页-运行套件', async ({ page }) => {
  const col = createCollector(page)
  const id = 'feature-tests'
  await page.goto('/projects/default/tests', { waitUntil: 'networkidle' })
  const shots = []

  await expect(page.getByRole('button', { name: '新建套件' })).toBeVisible()
  await expect(page.getByRole('button', { name: '全量运行' })).toBeVisible()

  // 选择第一个套件并运行（真实调用 RES）
  await page.getByRole('button', { name: '运行套件' }).first().click()
  // 等待结果出现（运行可能耗时，给足时间）
  await page.getByText(/通过|失败|运行中/).first().waitFor({ timeout: 60_000 })
  await page.waitForTimeout(1500)
  shots.push(await saveShot(page, id, '套件运行结果'))

  const issues = col.stop()
  finishCase({ id, title: '测试套件页-运行套件', status: 'passed', issues, screenshots: shots })
})

test('feature-reviews 审核页-筛选与搜索', async ({ page }) => {
  const col = createCollector(page)
  const id = 'feature-reviews'
  await page.goto('/projects/default/reviews', { waitUntil: 'networkidle' })
  const shots = []

  await expect(page.getByPlaceholder('名称或提交人')).toBeVisible()
  await page.getByPlaceholder('名称或提交人').fill('演示')
  await page.waitForTimeout(800)
  shots.push(await saveShot(page, id, '按名称搜索'))

  await page.getByLabel('审核状态').selectOption({ label: '全部状态' })
  await page.waitForTimeout(800)
  shots.push(await saveShot(page, id, '全部状态'))

  const issues = col.stop()
  finishCase({ id, title: '审核页-筛选与搜索', status: 'passed', issues, screenshots: shots })
})

test('feature-releases 发布页-构建向导', async ({ page }) => {
  const col = createCollector(page)
  const id = 'feature-releases'
  await page.goto('/projects/default/releases', { waitUntil: 'networkidle' })
  const shots = []

  await page.getByRole('button', { name: '构建新 Release' }).click()
  // 向导第一步：默认项目为真实服务（singleTarget），显示"选择发布目标"
  await expect(page.getByRole('heading', { name: /选择 Release 的发布目标|选择.*资产/ }).first()).toBeVisible({ timeout: 15_000 })
  shots.push(await saveShot(page, id, '发布向导-选择发布目标'))

  // 勾选第一个已发布目标（radio）
  await page.locator('input[aria-label^="选择 "]').first().check()
  // 下一步
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await expect(page.getByRole('heading', { name: '版本信息' })).toBeVisible({ timeout: 10_000 })
  shots.push(await saveShot(page, id, '发布向导-版本信息'))

  // 返回，不实际构建（完整发布链路在 flow-e2e 中验证）
  await page.getByRole('button', { name: '上一步', exact: true }).click()
  await page.getByRole('button', { name: /返回发布历史/ }).click()
  await expect(page.getByRole('button', { name: '构建新 Release' })).toBeVisible({ timeout: 10_000 })
  shots.push(await saveShot(page, id, '返回发布历史'))

  const issues = col.stop()
  finishCase({ id, title: '发布页-构建向导打开与返回', status: 'passed', issues, screenshots: shots })
})

test('feature-report 报告页-下载', async ({ page }) => {
  const col = createCollector(page)
  const id = 'feature-report'
  await page.goto('/projects/default/report', { waitUntil: 'networkidle' })

  // 报告六章节目录应渲染
  await expect(page.getByText(/项目概览|BOM 资产总览|规则资产清单|规则流拓扑|测试矩阵|发布部署历史/).first()).toBeVisible({ timeout: 20_000 })
  const shots = [await saveShot(page, id, '报告页面')]

  // 下载 HTML
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20_000 }),
    page.getByRole('button', { name: '下载 HTML' }).click(),
  ])
  const file = `output/downloads/${id}-${Date.now()}.html`
  await download.saveAs(file)
  shots.push(await saveShot(page, id, '下载HTML触发'))
  finishCase({ id, title: '报告页-渲染与下载HTML', status: 'passed', issues: col.stop(), screenshots: shots, notes: `下载文件: ${file}` })
})
