// 全局 Setup：1) 备份 data/ 目录  2) 登录并保存 storageState
const { chromium } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const { resetResults } = require('./collect')

const ROOT = path.join(__dirname, '..', '..') // rules 项目根
const DATA_DIR = path.join(ROOT, 'data')
const BACKUP_DIR = path.join(__dirname, '..', '.data-backup')
const AUTH_DIR = path.join(__dirname, '..', '.auth')
const AUTH_STATE = path.join(AUTH_DIR, 'state.json')

module.exports = async function globalSetup() {
  resetResults() // 清空上一次运行的结果
  // ---- 1. 备份数据 ----
  if (!fs.existsSync(DATA_DIR)) throw new Error(`数据目录不存在: ${DATA_DIR}`)
  const files = fs.readdirSync(DATA_DIR)
  if (files.length === 0) throw new Error('data/ 目录为空，拒绝备份')
  if (fs.existsSync(BACKUP_DIR)) fs.rmSync(BACKUP_DIR, { recursive: true, force: true })
  fs.cpSync(DATA_DIR, BACKUP_DIR, { recursive: true })
  console.log(`[setup] 已备份 data/ (${files.length} 个文件) -> e2e/.data-backup/`)

  // ---- 2. 登录并保存 session（sessionStorage 不被 storageState 支持，需 addInitScript 注入） ----
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true })
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  try {
    await page.goto('http://127.0.0.1:5180/login', { waitUntil: 'networkidle' })
    await page.waitForSelector('#username', { timeout: 15_000 })
    await page.fill('#username', 'wallace')
    await page.fill('#password', 'rules123')
    await page.getByRole('button', { name: /登\s*录/ }).click()
    await page.waitForURL(/\/library$/, { timeout: 15_000 })
    await page.waitForTimeout(1200) // 等待 zustand persist 写入 sessionStorage
    const sessionValue = await page.evaluate(() => sessionStorage.getItem('rts-session'))
    if (!sessionValue) throw new Error('登录后未找到 rts-session，无法保存登录态')
    fs.writeFileSync(path.join(AUTH_DIR, 'session.json'), sessionValue)
    console.log('[setup] 登录成功，session 已保存 -> e2e/.auth/session.json')
  } finally {
    await browser.close()
  }
}
