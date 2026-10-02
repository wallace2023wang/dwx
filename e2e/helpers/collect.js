// 错误收集器：捕获 console error、页面未捕获异常、HTTP 4xx/5xx
const fs = require('fs')
const path = require('path')

const OUTPUT_DIR = path.join(__dirname, '..', 'output')
const RESULTS_FILE = path.join(OUTPUT_DIR, 'results.ndjson')

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

const IGNORED_HTTP_PATTERNS = [
  /favicon/i,
  /\/build-api\/health/,
  /\/res-api\/health/,
]

function createCollector(page) {
  const issues = []

  const onConsole = (msg) => {
    if (msg.type() === 'error') {
      issues.push({ kind: 'console', text: msg.text().slice(0, 500) })
    }
  }
  const onPageError = (err) => {
    issues.push({ kind: 'pageerror', text: String(err).slice(0, 500) })
  }
  const onResponse = (resp) => {
    if (resp.status() >= 400) {
      const url = resp.url()
      if (IGNORED_HTTP_PATTERNS.some((re) => re.test(url))) return
      issues.push({ kind: 'http', status: resp.status(), url: url.slice(0, 300) })
    }
  }

  page.on('console', onConsole)
  page.on('pageerror', onPageError)
  page.on('response', onResponse)

  return {
    issues,
    stop() {
      page.off('console', onConsole)
      page.off('pageerror', onPageError)
      page.off('response', onResponse)
      return issues
    },
  }
}

// 记录一个用例的结果（每行 JSON，globalTeardown 汇总）
function recordResult(entry) {
  fs.appendFileSync(RESULTS_FILE, JSON.stringify(entry) + '\n')
}

function resetResults() {
  if (fs.existsSync(RESULTS_FILE)) fs.rmSync(RESULTS_FILE)
}

function hasRecordedResult(id) {
  if (!fs.existsSync(RESULTS_FILE)) return false
  return fs.readFileSync(RESULTS_FILE, 'utf8').split('\n').filter(Boolean).some(line => {
    try { return JSON.parse(line).id === id } catch { return false }
  })
}

module.exports = { createCollector, recordResult, resetResults, hasRecordedResult, OUTPUT_DIR, RESULTS_FILE }
