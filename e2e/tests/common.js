// 测试公共工具：登录注入、截图、结果记录
const path = require('path')
const fs = require('fs')
const { injectAuth } = require('../helpers/auth-init')
const { createCollector, recordResult, hasRecordedResult } = require('../helpers/collect')

const SHOT_DIR = path.join(__dirname, '..', 'output', 'screenshots')

function ensureShotDir(testId) {
  const dir = path.join(SHOT_DIR, testId)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// 截图并存记录，返回 { label, path }
async function saveShot(page, testId, label) {
  const dir = ensureShotDir(testId)
  const file = path.join(dir, `${String(label).replace(/[\\/:*?"<>|]/g, '_')}.png`)
  await page.screenshot({ path: file, fullPage: false })
  return { label, path: file }
}

// 在每个 spec 中使用：注入登录态
async function beforeEachAuth({ context }) {
  await injectAuth(context)
}

// 收尾：汇总 collector 的问题并记录用例结果
function finishCase({ id, title, status, issues, screenshots, notes }) {
  const collected = issues || []
  const finalStatus = status === 'passed' && collected.length > 0 ? 'failed' : status
  recordResult({ id, title, status: finalStatus, issues: collected, screenshots: screenshots || [], notes: notes || '' })
  if (finalStatus === 'failed' && status === 'passed') {
    const summary = collected.map(issue => issue.kind === 'http' ? `${issue.status} ${issue.url}` : issue.text).join(' | ')
    throw new Error(`验收期间发现未预期错误：${summary}`)
  }
}

function installFailureRecorder(test) {
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return
    const id = testInfo.title.split(/\s+/)[0]
    if (hasRecordedResult(id)) return
    const text = testInfo.errors.map(error => error.message || String(error)).join(' | ').slice(0, 1500) || `Playwright 状态：${testInfo.status}`
    recordResult({ id, title: testInfo.title, status: 'failed', issues: [{ kind: 'assertion', text }], screenshots: [], notes: '' })
  })
}

module.exports = { beforeEachAuth, saveShot, finishCase, installFailureRecorder, createCollector, SHOT_DIR }
