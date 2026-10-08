// 默认项目各页功能测试：资产、规则集、BOM、测试、审核、发布、报告
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
  await page.getByLabel('资产状态').selectOption({ label: '活动资产' })

  // 搜索
  await page.getByPlaceholder('搜索规则').fill('评级')
  await page.waitForTimeout(800)
  shots.push(await saveShot(page, id, '搜索评级'))
  await page.getByPlaceholder('搜索规则').fill('')

  // 新建规则：创建对话框 → 填写 → 创建并打开（写操作，数据将恢复）
  await page.getByRole('button', { name: '新建规则' }).click()
  const createDialog = page.getByRole('dialog')
  await expect(createDialog).toBeVisible()
  const temporaryName = `e2e规则_${Date.now().toString(36).slice(-6)}`
  await createDialog.getByPlaceholder('客户年龄不足拒绝').fill(temporaryName)
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

  // 生命周期：废弃资产保留可见但只读，恢复后回到草稿。
  const temporaryRow = page.getByRole('row').filter({ hasText: temporaryName })
  await temporaryRow.click({ button: 'right' })
  await page.getByRole('button', { name: '标记为废弃' }).click()
  const deprecateDialog = page.getByRole('dialog', { name: '标记为废弃' })
  await deprecateDialog.getByLabel('废弃原因').fill('E2E 生命周期验收')
  await deprecateDialog.getByRole('button', { name: '确认废弃' }).click()
  await page.getByLabel('资产状态').selectOption({ label: '已废弃' })
  await expect(temporaryRow).toContainText('已废弃')
  await temporaryRow.click({ button: 'right' })
  await page.getByRole('button', { name: '恢复为草稿' }).click()
  await page.getByLabel('资产状态').selectOption({ label: '活动资产' })
  await expect(temporaryRow).toContainText('草稿')
  shots.push(await saveShot(page, id, '废弃并恢复为草稿'))

  const issues = col.stop()
  finishCase({ id, title: '资产页-包树筛选搜索新建规则', status: 'passed', issues, screenshots: shots })
})

test('feature-decision-table-field 决策表条件支持同类型业务字段', async ({ page }) => {
  const col = createCollector(page)
  const id = 'feature-decision-table-field'
  await page.goto('/projects/default/assets', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '新建规则' }).click()
  const dialog = page.getByRole('dialog', { name: '新建规则资产' })
  await dialog.getByRole('button', { name: /决策表/ }).click()
  await dialog.getByLabel('名称').fill(`e2e字段比较表_${Date.now().toString(36).slice(-6)}`)
  await dialog.getByLabel('所属包').selectOption({ index: 1 })
  const fieldPicker = dialog.getByLabel('BOM 字段选择器')
  await expect(fieldPicker.getByLabel('搜索 BOM 字段')).toBeVisible()
  await fieldPicker.getByLabel('搜索 BOM 字段').fill('客户年龄')
  await fieldPicker.getByLabel(/客户年龄/).check()
  await dialog.getByRole('button', { name: /动作列 0/ }).click()
  await fieldPicker.getByLabel('搜索 BOM 字段').fill('风险等级')
  await fieldPicker.getByLabel(/风险等级/).check()
  await expect(dialog.getByText('已选 1 个条件列、1 个动作列')).toBeVisible()
  await dialog.getByRole('button', { name: '创建并打开' }).click()

  const editor = page.getByLabel('可编辑决策表')
  await expect(editor).toBeVisible({ timeout: 15_000 })

  // 已有决策表可按 Fact/字段搜索并一次追加多个列，现有行同步扩展单元格。
  await editor.getByRole('button', { name: '条件列', exact: true }).click()
  const addColumnsDialog = page.getByRole('dialog', { name: '添加条件列' })
  const addColumnsPicker = addColumnsDialog.getByLabel('BOM 字段选择器')
  await addColumnsPicker.getByLabel('搜索 BOM 字段').fill('年收入')
  await addColumnsPicker.getByLabel(/年收入/).check()
  await addColumnsPicker.getByLabel('搜索 BOM 字段').fill('信用评分')
  await addColumnsPicker.getByLabel(/信用评分/).check()
  await expect(addColumnsDialog.getByText('已选择 2 列')).toBeVisible()
  await addColumnsDialog.getByRole('button', { name: '添加所选列' }).click()
  await expect(editor.locator('thead').getByText('年收入', { exact: true })).toBeVisible()
  await expect(editor.locator('thead').getByText('信用评分', { exact: true })).toBeVisible()
  await expect(editor.locator('[data-cell="0:conditions:0"]')).toHaveCount(1)
  await expect(editor.locator('[data-cell="0:conditions:1"]')).toHaveCount(1)
  await expect(editor.locator('[data-cell="0:conditions:2"]')).toHaveCount(1)

  await editor.locator('thead select').first().selectOption('>=')
  const conditionCell = editor.locator('[data-cell="0:conditions:0"]')
  await conditionCell.getByLabel('比较值来源').selectOption('field')
  await conditionCell.locator('select').nth(1).selectOption('creditScore')
  await expect(conditionCell.locator('select').nth(1)).toHaveValue('creditScore')
  const actionCell = editor.locator('[data-cell="0:actions:0"]')
  await actionCell.getByRole('button', { name: '请选择' }).click()
  await actionCell.getByText('高', { exact: true }).click()
  await expect(actionCell.getByRole('button', { name: '高' })).toBeVisible()
  const saveButton = editor.getByRole('button', { name: '保存', exact: true })
  await expect(saveButton).toBeEnabled({ timeout: 15_000 })
  await saveButton.click()
  await expect(saveButton).toBeDisabled({ timeout: 15_000 })
  await expect(conditionCell.locator('select').nth(1)).toHaveValue('creditScore')
  await editor.getByRole('button', { name: '编译', exact: true }).click()
  await expect(editor.getByText('Drools 校验通过')).toBeVisible({ timeout: 30_000 })
  const shots = [await saveShot(page, id, '决策表业务字段比较已编译')]
  const issues = col.stop()
  finishCase({ id, title: '决策表-同类型业务字段比较', status: 'passed', issues, screenshots: shots })
})

test('feature-structured-bal 充氮动态阈值以结构化 BAL 显示并可编译', async ({ page }) => {
  const col = createCollector(page)
  const id = 'feature-advanced-bal'
  await page.goto('/projects/project-63dbe140/assets?asset=c721380a-f8e6-47ab-864f-a53d3e340142', { waitUntil: 'networkidle' })

  const editor = page.getByLabel('BAL 规则编辑器')
  await expect(editor).toBeVisible({ timeout: 15_000 })
  await expect(page.getByLabel('BOM 引用失效')).toHaveCount(0)
  await expect(editor.getByRole('alert')).toHaveCount(0)
  await expect(editor.getByLabel('高级表达式')).toHaveCount(0)
  const conditionFields = editor.getByRole('combobox', { name: '业务字段', exact: true })
  await expect(conditionFields).toHaveCount(4)
  await expect(conditionFields.nth(0)).toHaveValue('phase')
  await expect(conditionFields.nth(1)).toHaveValue('nitrogenPct')
  await expect(conditionFields.nth(2)).toHaveValue('paused')
  await expect(conditionFields.nth(3)).toHaveValue('endReached')
  await expect(editor.getByLabel('比较符').nth(1)).toHaveValue('>=')
  await expect(editor.getByLabel('用于比较的业务字段')).toHaveValue('maxPct')
  await expect(editor.getByText('字段已失效')).toHaveCount(0)
  await expect(editor.getByRole('button', { name: '保存草稿' })).toBeDisabled()
  await expect(editor.getByRole('button', { name: '编译' })).toBeEnabled()

  const shots = [await saveShot(page, id, '动态阈值结构化展示')]
  await editor.getByRole('button', { name: '编译' }).click()
  await expect(editor.getByText('Drools 编译通过')).toBeVisible({ timeout: 30_000 })
  shots.push(await saveShot(page, id, '结构化条件编译通过'))

  const issues = col.stop()
  finishCase({ id, title: 'BAL动态阈值-结构化显示与编译', status: 'passed', issues, screenshots: shots })
})

test('feature-flow 规则集页-画布与编辑器操作', async ({ page }) => {
  const col = createCollector(page)
  const id = 'feature-flow'
  await page.goto('/projects/default/flow', { waitUntil: 'networkidle' })
  const shots = []

  // 流程选择器存在（RulesetConfig 下拉）
  await expect(page.getByLabel('选择规则集')).toBeVisible()
  const previousFlowCount = await page.getByLabel('选择规则集').locator('option').count()
  await page.getByRole('button', { name: '新建规则集' }).click()
  await expect(page.getByLabel('选择规则集').locator('option')).toHaveCount(previousFlowCount + 1)
  await expect(page.getByLabel('规则集名称')).toHaveValue('未命名规则集')
  // 画布渲染（ReactFlow 节点可能因布局动画短暂不可见，用尺寸检测等待）
  await page.waitForFunction(() => {
    const nodes = document.querySelectorAll('.react-flow__node')
    return nodes.length > 0 && Array.from(nodes).some((n) => {
      const r = n.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
  }, null, { timeout: 30_000 })
  await page.waitForTimeout(1000)
  shots.push(await saveShot(page, id, '规则集画布全景'))

  // 条件判断必须是主画布一级入口，不依赖展开备用编辑器。
  const gatewayPaletteItem = page.getByTitle('点击或拖入画布：排他网关')
  await expect(gatewayPaletteItem).toBeVisible()
  await gatewayPaletteItem.click()
  await expect(page.locator('.react-flow__node-gateway')).toBeVisible()
  await expect(page.getByText('排他网关', { exact: true }).last()).toBeVisible()
  await page.getByLabel('第 1 个分支条件字段').selectOption('customerAge')
  await page.getByLabel('第 1 个分支运算符').selectOption('>=')
  await page.getByLabel('第 1 个分支比较值').fill('18')
  await page.getByRole('button', { name: '默认分支', exact: true }).first().click()
  await expect(page.getByText('默认分支', { exact: true }).first()).toBeVisible()
  shots.push(await saveShot(page, id, '主画布条件网关编辑'))

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('规则集草稿已保存')).toBeVisible({ timeout: 15_000 })
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '条件网关', exact: true }).click()
  await expect(page.getByLabel('第 1 个分支条件字段')).toHaveValue('customerAge')
  await expect(page.getByLabel('第 1 个分支运算符')).toHaveValue('>=')
  await expect(page.getByLabel('第 1 个分支比较值')).toHaveValue('18')
  await expect(page.getByText('默认分支', { exact: true }).first()).toBeVisible()

  // 校验（工具栏常驻按钮）
  await page.getByRole('button', { name: '校验', exact: true }).click()
  await expect(page.getByText(/Drools .*校验通过/)).toBeVisible({ timeout: 120_000 })
  shots.push(await saveShot(page, id, '校验结果'))

  // 全局 teardown 会恢复 data/，临时规则集不会污染验收基线。
  const issues = col.stop()
  finishCase({ id, title: '规则集页-主画布条件网关编辑', status: 'passed', issues, screenshots: shots })
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

test('feature-release-activation 发布页-唯一生效版本与稳定入口', async ({ page }) => {
  const col = createCollector(page)
  const id = 'feature-release-activation'
  await page.goto('/projects/project-63dbe140/releases', { waitUntil: 'networkidle' })

  await expect(page.getByText('当前生效', { exact: true })).toHaveCount(1)
  await expect(page.getByText('已部署', { exact: true })).toHaveCount(2)
  await expect(page.getByRole('button', { name: '回退', exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: '激活', exact: true })).toHaveCount(2)
  await expect(page.getByText('稳定执行入口', { exact: true })).toBeVisible()
  await expect(page.getByText(/POST .*\/services\/nitrogen-control\/execute/)).toBeVisible()
  await expect(page.getByText('当前路由至 v3.0.0', { exact: true })).toBeVisible()
  await expect(page.getByText(/undefined/)).toHaveCount(0)

  const shots = [await saveShot(page, id, '唯一生效版本与稳定入口')]
  finishCase({ id, title: '发布页-唯一生效版本与稳定入口', status: 'passed', issues: col.stop(), screenshots: shots })
})

test('feature-report 报告页-下载', async ({ page }) => {
  const col = createCollector(page)
  const id = 'feature-report'
  await page.goto('/projects/default/report', { waitUntil: 'networkidle' })

  // 报告六章节目录应渲染
  await expect(page.getByText(/项目概览|BOM 资产总览|规则资产清单|规则集拓扑|测试矩阵|发布部署历史/).first()).toBeVisible({ timeout: 20_000 })
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
