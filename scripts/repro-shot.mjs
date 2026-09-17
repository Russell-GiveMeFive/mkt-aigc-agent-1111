import { chromium } from 'playwright-core'
import { composeHtml } from '../server/llmCompose.js'
import fs from 'node:fs'

const items = [
  { fileId: 'plate_x.png', url: '/v2/files/l1/plate_x.png', category: 'plate', name: 'x' },
  { fileId: 'pattern_y.png', url: '/v2/files/l1/pattern_y.png', category: 'pattern', name: 'y' },
]
const { html } = await composeHtml({ items, instruction: '底版铺满' })
console.log('=== mock HTML (前500字):')
console.log(html.slice(0, 500))

// 用真实图片 dataURI 替换
for (const it of items) {
  const f = it.category === 'plate' ? 'data/assets/l1-plate/l1-plate-2.png' : 'data/assets/l1-pattern/l1-pattern-3.png'
  const b64 = fs.readFileSync(f).toString('base64')
  it.url = `data:image/png;base64,${b64}`
}
const html2 = (await composeHtml({ items, instruction: '' })).html
console.log('=== html2 bytes:', html2.length)

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 720, height: 1440 }, deviceScaleFactor: 2 })
await page.setContent(html2, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(400)
const buf = await page.screenshot({ type: 'png' })
console.log('screenshot OK bytes=', buf.length)
await browser.close()
process.exit(0)
