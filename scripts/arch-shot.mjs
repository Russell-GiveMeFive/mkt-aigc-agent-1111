import { chromium } from 'playwright-core'
const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 2080, height: 1200 }, deviceScaleFactor: 2 })
await page.goto('file:///Users/minimax/Desktop/Projects/FDE/Agent-Develop/jd-aigc-1111/docs/architecture-v2.html')
await page.waitForTimeout(600)
await page.screenshot({ path: 'docs/architecture-v2.png', fullPage: true })
await browser.close()
console.log('PNG 已渲染')
