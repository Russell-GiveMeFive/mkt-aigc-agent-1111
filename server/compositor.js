import sharp from 'sharp'
import { resolveLayout } from './layout.js'

/**
 * 严格版式合成引擎 v2 —— 对齐京东官方素材结构
 * 门头带 + 节日行 + 大字标题 + 价格角标 + 模特主视觉 + 商品(辉光垫底) + 名称胶囊 + CTA
 * 所有元素位置由 layout.zones 严格规定。
 */

const FONT = 'PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif'

/** mock 背景：按风格渲染渐变 + 光斑 + 流动光带 */
export async function renderMockBackground(style, w = 720, h = 1440, seed = 0) {
  const m = style.mock
  const rnd = mulberry(seed * 7919 + 13)
  let bokeh = ''
  for (let i = 0; i < 26; i++) {
    const x = rnd() * w
    const y = h * 0.4 + rnd() * h * 0.6
    const r = 6 + rnd() * 46
    const c = m.glow[Math.floor(rnd() * m.glow.length)]
    const o = (0.08 + rnd() * 0.3).toFixed(2)
    bokeh += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(0)}" fill="${c}" opacity="${o}"/>`
  }
  const ribbons = [0, 1, 2]
    .map((k) => {
      const yBase = 640 + k * 190 + rnd() * 60
      const c = k === 1 ? m.ribbon : m.glow[k % m.glow.length]
      return `<path d="M-40 ${yBase.toFixed(0)} C ${w * 0.3} ${(yBase - 90).toFixed(0)}, ${w * 0.7} ${(yBase + 90).toFixed(0)}, ${w + 40} ${(yBase - 30).toFixed(0)}" stroke="${c}" stroke-width="${(14 + k * 10).toFixed(0)}" fill="none" opacity="0.26" filter="url(#soft)"/>`
    })
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${m.top}"/><stop offset="0.45" stop-color="${m.mid}"/><stop offset="1" stop-color="${m.bottom}"/>
    </linearGradient>
    <radialGradient id="halo" cx="0.5" cy="0.28" r="0.55">
      <stop offset="0" stop-color="${m.glow[0]}" stop-opacity="0.5"/><stop offset="1" stop-color="${m.glow[0]}" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="18"/></filter>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect width="${w}" height="${h}" fill="url(#halo)"/>
  ${bokeh}${ribbons}
</svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

function mulberry(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 标题拆两行：显式 \n 优先，否则按 12 字自动断行 */
function splitHeadline(text) {
  const t = String(text || '')
  if (t.includes('\n')) return t.split('\n').slice(0, 2)
  if (t.length <= 12) return [t]
  const cut = Math.ceil(t.length / 2)
  return [t.slice(0, cut), t.slice(cut)]
}

/** 简化吉祥物占位：白色 Joy 轮廓 */
function mascotSvg(x, y, w, h) {
  const cx = x + w / 2
  const r = Math.min(w, h) * 0.42
  return `
  <circle cx="${cx}" cy="${y + h * 0.42}" r="${r}" fill="#ffffff"/>
  <circle cx="${cx - r * 0.45}" cy="${y + h * 0.36}" r="${r * 0.16}" fill="#2a2a2a"/>
  <circle cx="${cx + r * 0.45}" cy="${y + h * 0.36}" r="${r * 0.16}" fill="#2a2a2a"/>
  <path d="M${cx - r * 0.3} ${y + h * 0.5} Q ${cx} ${y + h * 0.62} ${cx + r * 0.3} ${y + h * 0.5}" stroke="#2a2a2a" stroke-width="${r * 0.09}" fill="none" stroke-linecap="round"/>
  <ellipse cx="${cx}" cy="${y + h * 0.18}" rx="${r * 0.34}" ry="${r * 0.42}" fill="#ffffff"/>
  <ellipse cx="${cx - r * 0.14}" cy="${y + h * 0.12}" rx="${r * 0.1}" ry="${r * 0.2}" fill="#e8e8e8"/>
  <ellipse cx="${cx + r * 0.14}" cy="${y + h * 0.12}" rx="${r * 0.1}" ry="${r * 0.2}" fill="#e8e8e8"/>`
}

function textSvgLayer(copy, layout) {
  const { zones, style, canvas } = layout
  const z = zones
  const priceMain = String(copy.price ?? '').replace(/[^0-9.]/g, '') || '299'
  const oldPrice = String(copy.oldPrice ?? '').replace(/[¥￥\s]/g, '') // 模型可能自带 ¥ 前缀，渲染时统一去掉避免「¥¥459」

  // 门头口号（两行）
  const sloganLines = String(style.headerSlogan || '').split('\n').slice(0, 2)
  const sloganSvg = sloganLines
    .map(
      (line, i) =>
        `<text x="${z.header.x + 44}" y="${z.header.y + 52 + i * 44}" font-family="${FONT}" font-size="34" font-weight="800" fill="${style.headerColor}" dominant-baseline="central">${esc(line)}</text>`
    )
    .join('')

  // 标题（两行居中，字号随行宽自适应）
  const lines = splitHeadline(copy.headline)
  const maxLen = Math.max(...lines.map((l) => l.length), 1)
  const hSize = Math.max(46, Math.min(76, Math.floor(z.headline.w / maxLen)))
  const headlineSvg = lines
    .map(
      (line, i) =>
        `<text x="${z.headline.x + z.headline.w / 2}" y="${z.headline.y + 62 + i * (hSize + 22)}" font-family="${FONT}" font-size="${hSize}" font-weight="800" fill="${style.headlineColor}" text-anchor="middle" dominant-baseline="central" style="paint-order:stroke" stroke="rgba(255,255,255,0.9)" stroke-width="${style.headlineStroke || 10}">${esc(line)}</text>`
    )
    .join('')

  // 商品名胶囊
  const pName = esc(copy.productName || copy.headline || '')
  const pillW = Math.min(z.productPill.w, 40 + pName.length * 22)
  const pillX = z.productPill.x + (z.productPill.w - pillW) / 2
  const pillSvg = copy.productName
    ? `<rect x="${pillX}" y="${z.productPill.y}" width="${pillW}" height="${z.productPill.h}" rx="${z.productPill.h / 2}" fill="${style.productPillBg}" opacity="0.92"/>
       <text x="${pillX + pillW / 2}" y="${z.productPill.y + z.productPill.h / 2 + 1}" font-family="${FONT}" font-size="26" font-weight="600" fill="${style.productPillColor}" text-anchor="middle" dominant-baseline="central">${esc(copy.productName)}</text>`
    : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}">
  <defs>
    <linearGradient id="headerBg" x1="0" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="${style.headerBg1}"/><stop offset="1" stop-color="${style.headerBg2}"/>
    </linearGradient>
    <radialGradient id="pGlow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0.85"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgba(10,6,30,0)"/>
      <stop offset="0.55" stop-color="rgba(10,6,30,0.40)"/>
      <stop offset="1" stop-color="rgba(10,6,30,0.74)"/>
    </linearGradient>
    <linearGradient id="badgeBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${style.badgeBg1}"/><stop offset="1" stop-color="${style.badgeBg2}"/>
    </linearGradient>
  </defs>

  <!-- 底部信息区垫层 -->
  <rect x="0" y="${Math.floor(canvas.height * 0.62)}" width="${canvas.width}" height="${Math.ceil(canvas.height * 0.38)}" fill="url(#scrim)"/>

  <!-- 门头带 + 吉祥物位 -->
  <rect x="${z.header.x}" y="${z.header.y}" width="${z.header.w}" height="${z.header.h}" fill="url(#headerBg)"/>
  ${sloganSvg}
  ${z.mascot ? mascotSvg(z.mascot.x, z.mascot.y, z.mascot.w, z.mascot.h) : ''}

  <!-- 节日行：白色胶囊芯片保证任何背景下可读 -->
  ${style.festivalText ? (() => {
    const ft = esc(style.festivalText)
    const fw = Math.min(560, 60 + style.festivalText.length * 26)
    const fx = (canvas.width - fw) / 2
    return `<rect x="${fx}" y="${z.festival.y + 6}" width="${fw}" height="${z.festival.h - 12}" rx="${(z.festival.h - 12) / 2}" fill="#ffffff" opacity="0.94"/>
    <text x="${canvas.width / 2}" y="${z.festival.y + z.festival.h / 2}" font-family="${FONT}" font-size="32" font-weight="700" fill="${style.accent}" text-anchor="middle" dominant-baseline="central" letter-spacing="2">${ft}</text>`
  })() : ''}

  <!-- 大字标题 -->
  ${headlineSvg}

  <!-- 价格圆形角标（叠标题右下，参考图同款） -->
  <circle cx="${z.badge.x + z.badge.d / 2}" cy="${z.badge.y + z.badge.d / 2}" r="${z.badge.d / 2}" fill="url(#badgeBg)"/>
  <circle cx="${z.badge.x + z.badge.d / 2}" cy="${z.badge.y + z.badge.d / 2}" r="${z.badge.d / 2 - 7}" fill="none" stroke="rgba(255,255,255,0.65)" stroke-width="2.5" stroke-dasharray="4 6"/>
  <text x="${z.badge.x + z.badge.d / 2}" y="${z.badge.y + z.badge.d / 2 - 12}" font-family="${FONT}" font-size="24" font-weight="600" fill="${style.badgeColor}" text-anchor="middle" dominant-baseline="central">到手价</text>
  <text x="${z.badge.x + z.badge.d / 2}" y="${z.badge.y + z.badge.d / 2 + 26}" font-family="${FONT}" font-size="52" font-weight="800" fill="${style.badgeColor}" text-anchor="middle" dominant-baseline="central">¥${esc(priceMain)}</text>
  ${oldPrice ? `<text x="${z.badge.x + z.badge.d / 2}" y="${z.badge.y + z.badge.d + 22}" font-family="${FONT}" font-size="24" fill="rgba(255,255,255,0.85)" text-anchor="middle" dominant-baseline="central" text-decoration="line-through">¥${esc(oldPrice)}</text>` : ''}

  <!-- 商品名胶囊 -->
  ${pillSvg}

  <!-- CTA 胶囊 -->
  <rect x="${z.cta.x}" y="${z.cta.y}" width="${z.cta.w}" height="${z.cta.h}" rx="${z.cta.h / 2}" fill="${style.ctaBg}" opacity="0.92"/>
  <text x="${z.cta.x + z.cta.w / 2}" y="${z.cta.y + z.cta.h / 2 + 2}" font-family="${FONT}" font-size="30" font-weight="700" fill="${style.ctaColor}" text-anchor="middle" dominant-baseline="central">${esc(copy.cta || '立即抢购')}</text>

  <!-- 促销标签 -->
  ${copy.promo ? `<rect x="${z.promo.x}" y="${z.promo.y}" width="${z.promo.w}" height="${z.promo.h}" rx="${z.promo.h / 2}" fill="${style.promoBg}"/>
  <text x="${z.promo.x + z.promo.w / 2}" y="${z.promo.y + z.promo.h / 2 + 2}" font-family="${FONT}" font-size="30" font-weight="600" fill="${style.promoColor}" text-anchor="middle" dominant-baseline="central">${esc(copy.promo)}</text>` : ''}
</svg>`
}

/** 合成一张海报，返回 PNG Buffer */
export async function composePoster({ background, product, model, copy, layoutOverride }) {
  const layout = resolveLayout(layoutOverride)
  const { canvas, zones, style } = layout
  const W = canvas.width
  const H = canvas.height

  const bg = await sharp(background)
    .resize(W, H, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer()

  const layers = []

  // 模特：contain 进主视觉静区
  if (model) {
    const mz = zones.model
    const modelPng = await sharp(model)
      .resize(mz.w, mz.h, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
    layers.push({ input: modelPng, left: Math.round(mz.x), top: Math.round(mz.y) })
  }

  // 商品：glow 辉光垫底（适配白底商品图）/ card 白卡 / none
  if (product) {
    const pz = zones.product
    if (style.productMode === 'glow') {
      const glowPad = 70
      const glowSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pz.w + glowPad * 2}" height="${pz.h + glowPad * 2}">
        <rect width="${pz.w + glowPad * 2}" height="${pz.h + glowPad * 2}" fill="url(#g)"/>
        <defs><radialGradient id="g" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0.3" stop-color="#ffffff" stop-opacity="0.92"/>
          <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
        </radialGradient></defs></svg>`
      layers.push({ input: Buffer.from(glowSvg), left: Math.round(pz.x - glowPad), top: Math.round(pz.y - glowPad) })
    } else if (style.productMode === 'card') {
      const cardSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pz.w}" height="${pz.h}">
        <rect width="${pz.w}" height="${pz.h}" rx="${style.productCardRadius ?? 28}" fill="${style.productCardBg ?? '#ffffff'}"/></svg>`
      layers.push({ input: Buffer.from(cardSvg), left: Math.round(pz.x), top: Math.round(pz.y) })
    }
    const pad = style.productMode === 'card' ? (style.productCardPad ?? 14) : 0
    const productPng = await sharp(product)
      .resize(pz.w - pad * 2, pz.h - pad * 2, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
    layers.push({ input: productPng, left: Math.round(pz.x + pad), top: Math.round(pz.y + pad) })
  }

  // 文字层（门头/节日/标题/角标/胶囊/CTA）
  layers.push({ input: Buffer.from(textSvgLayer(copy, layout)), left: 0, top: 0 })

  return sharp(bg).composite(layers).png().toBuffer()
}
