import axios from 'axios'
import { http } from './client'

export async function downloadProjectReport(projectId: string, projectName: string) {
  try {
    const response = await http.get(`/projects/${encodeURIComponent(projectId)}/report`, { responseType: 'blob' })
    const url = URL.createObjectURL(response.data)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${projectName}-资产报告-${new Date().toISOString().slice(0, 10)}.html`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  } catch (error) {
    if (axios.isAxiosError(error)) throw new Error('报告 HTML 下载失败')
    throw error instanceof Error ? error : new Error('报告 HTML 下载失败')
  }
}
