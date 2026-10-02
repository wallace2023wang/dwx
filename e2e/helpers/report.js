// 验收报告生成器：把 results.ndjson 汇总为自包含 HTML（内嵌缩略图）
const fs = require('fs')
const path = require('path')

function thumbnailBase64(pngPath, maxWidth = 520) {
  try {
    const buf = fs.readFileSync(pngPath)
    if (!buf || buf.length === 0) return null
    // 使用 <img> 直接引用原图路径不可行（交付时路径失效），因此内嵌原图，
    // 但为避免报告过大，仅内嵌缩略图数据：这里直接内嵌压缩后的 JPEG 不可行，
    // 简化方案：内嵌原 PNG base64（截图控制在合理大小），完整图另存目录。
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

function buildAcceptanceReport(resultsFile) {
  const entries = fs.existsSync(resultsFile)
    ? fs.readFileSync(resultsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l) } catch { return null }
      }).filter(Boolean)
    : []

  const passed = entries.filter((e) => e.status === 'passed').length
  const failed = entries.filter((e) => e.status === 'failed').length
  const skipped = entries.filter((e) => e.status === 'skipped').length
  const withIssues = entries.filter((e) => e.issues && e.issues.length > 0).length
  const total = entries.length

  const rows = entries.map((e) => {
    const issuesHtml = (e.issues || []).map((i) => {
      const cls = i.kind === 'http' ? 'issue-http' : i.kind === 'pageerror' ? 'issue-pageerror' : 'issue-console'
      const detail = i.kind === 'http' ? `${i.status} ${i.url}` : i.text
      return `<li class="issue ${cls}">[${i.kind}] ${detail.replace(/</g, '&lt;')}</li>`
    }).join('')

    const shots = (e.screenshots || []).map((s) => {
      const b64 = thumbnailBase64(s.path)
      if (!b64) return ''
      return `<div class="shot"><img src="${b64}" alt="${s.label}" /><p>${s.label}</p></div>`
    }).join('')

    return `<tr class="${e.status}">
      <td class="id">${e.id}</td>
      <td class="title">${e.title}</td>
      <td><span class="badge badge-${e.status}">${e.status}</span></td>
      <td>${(e.issues || []).length ? `<ul class="issues">${issuesHtml}</ul>` : '<span class="ok">无</span>'}</td>
      <td class="shots-cell">${shots || '—'}</td>
    </tr>`
  }).join('')

  const summary = [
    ['用例总数', total],
    ['通过', passed],
    ['失败', failed],
    ['跳过', skipped],
    ['存在问题(console/HTTP)', withIssues],
    ['通过率', total ? `${((passed / total) * 100).toFixed(1)}%` : '—'],
  ].map(([k, v]) => `<div class="stat"><span class="stat-num">${v}</span><span class="stat-label">${k}</span></div>`).join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>规则工作台 E2E 验收报告</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; background: #f5f6f8; color: #1f2937; }
  .wrap { max-width: 1280px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 22px; }
  .meta { color: #6b7280; font-size: 13px; margin-bottom: 16px; }
  .summary { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0 24px; }
  .stat { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 20px; min-width: 110px; text-align: center; }
  .stat-num { display: block; font-size: 26px; font-weight: 700; }
  .stat-label { font-size: 12px; color: #6b7280; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
  th, td { border-bottom: 1px solid #eef0f3; padding: 10px 12px; font-size: 13px; vertical-align: top; text-align: left; }
  th { background: #f9fafb; font-weight: 600; position: sticky; top: 0; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge-passed { background: #dcfce7; color: #166534; }
  .badge-failed { background: #fee2e2; color: #991b1b; }
  .badge-skipped { background: #f3f4f6; color: #4b5563; }
  .ok { color: #16a34a; }
  .issues { margin: 0; padding-left: 16px; }
  .issue { font-size: 12px; margin-bottom: 4px; }
  .issue-http { color: #b45309; }
  .issue-pageerror { color: #b91c1c; font-weight: 600; }
  .issue-console { color: #7c3aed; }
  .shots-cell { max-width: 620px; }
  .shot { display: inline-block; margin: 4px 6px 4px 0; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; vertical-align: top; }
  .shot img { width: 240px; display: block; }
  .shot p { margin: 0; font-size: 11px; color: #6b7280; padding: 4px 6px; background: #f9fafb; }
  .id { color: #6b7280; font-family: ui-monospace, monospace; font-size: 12px; white-space: nowrap; }
</style>
</head>
<body>
<div class="wrap">
  <h1>规则工作台 E2E 页面验收报告</h1>
  <div class="meta">被测地址：http://127.0.0.1:5180 ｜ 测试时间：${new Date().toLocaleString('zh-CN')} ｜ 数据策略：测试前备份、结束后恢复</div>
  <div class="summary">${summary}</div>
  <table>
    <thead><tr><th>用例 ID</th><th>用例名称</th><th>状态</th><th>问题（console / HTTP / 异常）</th><th>截图</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>
</body>
</html>`
}

module.exports = { buildAcceptanceReport }
