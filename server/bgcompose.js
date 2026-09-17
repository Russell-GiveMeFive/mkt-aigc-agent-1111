import sharp from 'sharp'

/**
 * L1 → L2 背景合成器
 * 底版图(plate, 必选) + 花纹/字效层(patterns: blend 混合模式 + opacity + fit)
 *   → 合成背景图 (720×1440, 入库为 L2:bg)
 * blend 白名单 = vips 支持的常见混合模式；fit: cover 铺满 | tile 平铺
 */

export const BLENDS = ['over', 'multiply', 'screen', 'overlay', 'soft-light', 'hard-light', 'darken', 'lighten', 'add', 'difference']

async function toDataUri(buffer) {
  const meta = await sharp(buffer).metadata()
  const fmt = meta.format === 'png' ? 'image/png' : 'image/jpeg'
  return `data:${fmt};base64,${buffer.toString('base64')}`
}

/** 单层 → 720×1440 带透明度的 PNG buffer */
async function renderLayer(layerBuf, { width, height, fit = 'cover', opacity = 1, tile = false }) {
  if (tile) {
    const meta = await sharp(layerBuf).metadata()
    const tw = Math.min(meta.width || 360, 480)
    const th = Math.min(meta.height || 360, 480)
    const uri = await toDataUri(await sharp(layerBuf).resize(tw, th, { fit: 'inside' }).png().toBuffer())
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><pattern id="t" width="${tw}" height="${th}" patternUnits="userSpaceOnUse">
        <image href="${uri}" width="${tw}" height="${th}"/>
      </pattern></defs>
      <rect width="${width}" height="${height}" fill="url(#t)" opacity="${opacity}"/>
    </svg>`
    return sharp(Buffer.from(svg)).png().toBuffer()
  }
  const uri = await toDataUri(await sharp(layerBuf).png().toBuffer())
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <image href="${uri}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" opacity="${opacity}"/>
  </svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

/** L1 组合 → 背景图 buffer */
export async function composeBackground({ plate, patterns = [], width = 720, height = 1440 }) {
  if (!plate) throw new Error('缺少底版图 plate')
  const base = await sharp(plate).resize(width, height, { fit: 'cover', position: 'centre' }).png().toBuffer()
  if (!patterns.length) return base

  const layers = []
  for (const p of patterns) {
    const blend = BLENDS.includes(p.blend) ? p.blend : 'over'
    const opacity = Math.max(0, Math.min(1, Number(p.opacity ?? 1)))
    const layerPng = await renderLayer(p.buffer, {
      width,
      height,
      opacity,
      tile: p.fit === 'tile',
    })
    layers.push({ input: layerPng, blend })
  }
  return sharp(base).composite(layers).png().toBuffer()
}
