import { chromium } from 'playwright-core'

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
const errors = []
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 150)) })

await page.goto('http://localhost:8788/', { waitUntil: 'networkidle' })
await page.waitForTimeout(600)
for (const [key, label] of [['l1', '基础素材'], ['l2', '平台合成素材'], ['l3', '商家最终海报'], ['l4', '视频合成'], ['settings', '设置'], ['skills', '技能']]) {
  await page.click(`text=${label}`)
  await page.waitForTimeout(700)
  await page.screenshot({ path: `/tmp/ui-${key}.png` })
}
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none')
await browser.close()
process.exit(0)
