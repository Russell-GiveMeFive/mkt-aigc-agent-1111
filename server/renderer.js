import path from 'node:path'
import fs from 'node:fs'
import { chromium } from 'playwright-core'
import sharp from 'sharp'

/**
 * HTML → 截图渲染引擎（L2 背景合成）
 * LLM 生成 720×1440 的 HTML（绝对定位，可精细控制位置）→ 无头 Chrome 截图 → PNG
 * 找不到浏览器时回退 sharp 渐变底图（保证 mock 可用）。
 */

export const CANVAS_W = 720
export const CANVAS_H = 1440

let browserAvailable = null // null=未探测, true/false

async function launchBrowser() {
  const candidates = []
  if (process.env.CHROMIUM_PATH) candidates.push({ executablePath: process.env.CHROMIUM_PATH })
  candidates.push({ channel: 'chrome' })
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (fs.existsSync(p)) candidates.push({ executablePath: p })
  }
  let lastErr
  for (const opt of candidates) {
    try {
      // 不加 --disable-gpu：macOS headless 下会触发渲染进程崩溃
      return await chromium.launch({ headless: true, args: ['--no-sandbox'], ...opt })
    } catch (e) {
      lastErr = e
    }
  }
  browserAvailable = false
  throw lastErr || new Error('未找到可用浏览器')
}

/** 截图（失败返回 null，由调用方回退） */
export async function screenshotHtmlSafe(html, { width = CANVAS_W, height = CANVAS_H } = {}) {
  try {
    return await screenshotHtml(html, { width, height })
  } catch (e) {
    console.error('[renderer] 截图失败，回退底图:', e.message?.slice(0, 120))
    return null
  }
}

export async function screenshotHtml(html, { width = CANVAS_W, height = CANVAS_H } = {}) {
  const browser = await launchBrowser()
  browserAvailable = true
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 })
    await page.setContent(html, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(400) // 字体/图片稳定
    const buf = await page.screenshot({ type: 'png' }) // 先 await 再 return，否则 finally 会提前 close 浏览器
    return buf
  } finally {
    await browser.close()
  }
}

export function hasBrowser() {
  return browserAvailable !== false
}
export async function inlineImages(html) {
  const urls = [...html.matchAll(/src="(\/v2\/files\/[^"]+|https?:\/\/[^"]+)"/g)].map((m) => m[1])
  let out = html
  for (const u of [...new Set(urls)]) {
    try {
      const abs = u.startsWith('/') ? `http://127.0.0.1:${process.env.PORT || 8788}${u}` : u
      const res = await fetch(abs)
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      const mime = res.headers.get('content-type') || 'image/png'
      out = out.split(`src="${u}"`).join(`src="data:${mime};base64,${buf.toString('base64')}"`)
    } catch {}
  }
  return out
}

/** 回退底图：无浏览器/无 LLM 时的确定性渐变 */
export async function fallbackBackground({ top = '#4130a1', mid = '#8a76d8', bottom = '#d8cde8' } = {}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${top}"/><stop offset="0.55" stop-color="${mid}"/><stop offset="1" stop-color="${bottom}"/>
    </linearGradient></defs>
    <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#g)"/></svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}
