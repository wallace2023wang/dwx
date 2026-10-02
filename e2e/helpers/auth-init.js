// 登录态注入：该应用把登录态存在 sessionStorage（Playwright storageState 不支持 sessionStorage），
// 因此通过 addInitScript 在每个页面加载前注入。
const fs = require('fs')
const path = require('path')

const SESSION_FILE = path.join(__dirname, '..', '.auth', 'session.json')

function sessionValue() {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(`未找到登录态文件 ${SESSION_FILE}，请先运行 npx playwright test 触发 globalSetup`)
  }
  return fs.readFileSync(SESSION_FILE, 'utf8')
}

// 返回可被 addInitScript 序列化的函数：页面加载前把 rts-session 写入 sessionStorage
function authInjectScript() {
  const value = sessionValue()
  return `(function () {
    if (!window.sessionStorage.getItem('rts-session')) {
      window.sessionStorage.setItem('rts-session', ${JSON.stringify(value)});
    }
  })()`
}

// 测试内使用：test.beforeEach 时调用
async function injectAuth(context) {
  await context.addInitScript(authInjectScript())
}

module.exports = { injectAuth, authInjectScript }
