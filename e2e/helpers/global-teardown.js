// 全局 Teardown：恢复 data/ 目录 + 生成验收报告
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..') // rules 项目根
const DATA_DIR = path.join(ROOT, 'data')
const BACKUP_DIR = path.join(__dirname, '..', '.data-backup')
const { resetResults, RESULTS_FILE } = require('./collect')
const { buildAcceptanceReport } = require('./report')

module.exports = async function globalTeardown() {
  // ---- 1. 恢复数据（仅在备份存在时） ----
  if (!fs.existsSync(BACKUP_DIR)) {
    console.warn('[teardown] 未找到备份目录，跳过数据恢复！')
  } else {
    const backupFiles = fs.readdirSync(BACKUP_DIR)
    if (backupFiles.length === 0) {
      console.warn('[teardown] 备份目录为空，跳过数据恢复！')
    } else {
      fs.rmSync(DATA_DIR, { recursive: true, force: true })
      fs.cpSync(BACKUP_DIR, DATA_DIR, { recursive: true })
      console.log(`[teardown] 已恢复 data/ (${backupFiles.length} 个文件)`)
    }
  }

  // ---- 2. 生成验收报告 ----
  try {
    const report = buildAcceptanceReport(RESULTS_FILE)
    const out = path.join(__dirname, '..', 'output', 'acceptance-report.html')
    fs.writeFileSync(out, report)
    console.log(`[teardown] 验收报告已生成 -> e2e/output/acceptance-report.html`)
  } catch (err) {
    console.error('[teardown] 生成验收报告失败:', err.message)
  }
}
