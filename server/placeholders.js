import sharp from 'sharp'
import path from 'node:path'
import fs from 'node:fs'
import { DATA_DIR } from './config.js'
import { addAsset } from './assets.js'
import { composeBackground } from './bgcompose.js'

/**
 * 占位素材生成（SVG → PNG），开发期用；三层全量：
 *  L1: plate 背景底版×3 · pattern 花纹×3 · arttext 艺术字效×2
 *  L2: product 商品×3 · model_image 模特×3 · bg 演示合成背景×1
 * 真实素材直接上传替换。
 */

function plateSvg(variant) {
  const defs = {
    0: `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4130a1"/><stop offset="0.55" stop-color="#8a76d8"/><stop offset="1" stop-color="#d8cde8"/></linearGradient>
        <radialGradient id="halo" cx="0.78" cy="0.16" r="0.5"><stop offset="0" stop-color="#b7a6ff" stop-opacity="0.55"/><stop offset="1" stop-color="#b7a6ff" stop-opacity="0"/></radialGradient>`,
    1: `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c81623"/><stop offset="0.6" stop-color="#a01018"/><stop offset="1" stop-color="#5c070c"/></linearGradient>
        <radialGradient id="halo" cx="0.75" cy="0.14" r="0.5"><stop offset="0" stop-color="#ffd28a" stop-opacity="0.5"/><stop offset="1" stop-color="#ffd28a" stop-opacity="0"/></radialGradient>`,
    2: `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b5f9e"/><stop offset="0.6" stop-color="#7fa8d9"/><stop offset="1" stop-color="#dce9f7"/></linearGradient>
        <radialGradient id="halo" cx="0.75" cy="0.15" r="0.5"><stop offset="0" stop-color="#cfe6ff" stop-opacity="0.55"/><stop offset="1" stop-color="#cfe6ff" stop-opacity="0"/></radialGradient>`,
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1440"><defs>${defs[variant % 3]}</defs>
  <rect width="720" height="1440" fill="url(#g)"/>
  <rect width="720" height="1440" fill="url(#halo)"/>
  <rect y="1080" width="720" height="360" fill="rgba(0,0,0,0.12)"/></svg>`
}

function patternSvg(variant) {
  if (variant % 3 === 0) {
    // 波点（可平铺，元素完整不出界）
    let dots = ''
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 3; x++)
        dots += `<circle cx="${50 + x * 100 + (y % 2) * 50}" cy="${50 + y * 100}" r="${14 + ((x + y) % 3) * 6}" fill="rgba(255,255,255,0.32)"/>`
    return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="rgba(65,48,161,0.18)"/>${dots}</svg>`
  }
  if (variant % 3 === 1) {
    // 斜向光纹（可平铺）
    let stripes = ''
    for (let i = -300; i < 600; i += 60) stripes += `<rect x="${i}" y="-20" width="18" height="640" fill="rgba(255,255,255,0.14)" transform="rotate(24 150 150)"/>`
    return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">${stripes}</svg>`
  }
  // 金色粒子
  const pts = [[30,40,5],[90,120,3],[160,60,6],[220,170,4],[270,90,5],[60,220,4],[180,260,6],[250,30,3],[120,180,5]]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">${pts
    .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r * 2.2}" fill="rgba(255,210,138,0.12)"/><circle cx="${x}" cy="${y}" r="${r}" fill="rgba(255,226,160,0.5)"/>`)
    .join('')}</svg>`
}

function arttextSvg(variant) {
  const words = ['双11狂欢', '限时直降']
  const fills = ['url(#gold)', 'url(#violet)']
  const grads = {
    gold: `<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe28a"/><stop offset="1" stop-color="#ff9d3c"/></linearGradient>`,
    violet: `<linearGradient id="violet" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfc0ff"/><stop offset="1" stop-color="#7c5cff"/></linearGradient>`,
  }
  const w = variant % 2 === 0 ? 520 : 440
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="180"><defs>${grads[variant % 2]}</defs>
  <text x="${w / 2}" y="96" font-family="PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif" font-size="92" font-weight="900"
    text-anchor="middle" dominant-baseline="central" fill="${fills[variant % 2]}"
    style="paint-order:stroke" stroke="rgba(30,16,60,0.85)" stroke-width="14">${words[variant % 2]}</text></svg>`
}

const DIRS = {
  plate: 'assets/l1-plate',
  pattern: 'assets/l1-pattern',
  arttext: 'assets/l1-arttext',
  bg: 'assets/l2-bg',
  product: 'assets/l2-product',
  model_image: 'assets/l2-model',
  model_video: 'assets/l2-model',
}

async function emit(kind, id, name, svg, extraMeta = {}) {
  const dir = path.join(DATA_DIR, DIRS[kind])
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.png`)
  await sharp(Buffer.from(svg)).png().toFile(file)
  const rel = `/files/${DIRS[kind]}/${id}.png`
  addAsset({
    id,
    level: ['plate', 'pattern', 'arttext'].includes(kind) ? 1 : 2,
    kind,
    name,
    file: rel,
    createdAt: Date.now(),
    ...extraMeta,
  })
  return id
}

export async function generatePlaceholders({ products = 3, models = 3 } = {}) {
  const made = []
  // L1 底版 ×3
  const plateNames = ['紫曜底版', '红金底版', '冰雪蓝底版']
  for (let i = 0; i < 3; i++) {
    await emit('plate', `l1-plate-${i + 1}`, plateNames[i], plateSvg(i))
    made.push(`l1-plate-${i + 1}`)
  }
  // L1 花纹 ×3
  const patternNames = ['波点花纹', '斜向光纹', '金色粒子']
  for (let i = 0; i < 3; i++) {
    await emit('pattern', `l1-pattern-${i + 1}`, patternNames[i], patternSvg(i), { tileable: true })
    made.push(`l1-pattern-${i + 1}`)
  }
  // L1 艺术字效 ×2
  for (let i = 0; i < 2; i++) {
    await emit('arttext', `l1-arttext-${i + 1}`, `字效：${i === 0 ? '双11狂欢' : '限时直降'}`, arttextSvg(i))
    made.push(`l1-arttext-${i + 1}`)
  }
  // L2 商品 ×3 / 模特 ×3（沿用原 SVG 生成器内容）
  for (let i = 0; i < products; i++) {
    await emit('product', `prod-p${i + 1}`, `占位商品 ${i + 1}`, productSvg(i))
    made.push(`prod-p${i + 1}`)
  }
  for (let i = 0; i < models; i++) {
    await emit('model_image', `model-p${i + 1}`, `占位模特 ${i + 1}`, modelSvg(i))
    made.push(`model-p${i + 1}`)
  }
  // L2 演示合成背景：plate-1 + 波点(soft-light) + 粒子(screen)
  const plateBuf = fs.readFileSync(path.join(DATA_DIR, DIRS.plate, 'l1-plate-1.png'))
  const pat1 = fs.readFileSync(path.join(DATA_DIR, DIRS.pattern, 'l1-pattern-1.png'))
  const pat2 = fs.readFileSync(path.join(DATA_DIR, DIRS.pattern, 'l1-pattern-3.png'))
  const bgBuf = await composeBackground({
    plate: plateBuf,
    patterns: [
      { buffer: pat1, blend: 'soft-light', opacity: 0.9, fit: 'tile' },
      { buffer: pat2, blend: 'screen', opacity: 0.8, fit: 'tile' },
    ],
  })
  const bgDir = path.join(DATA_DIR, DIRS.bg)
  fs.mkdirSync(bgDir, { recursive: true })
  fs.writeFileSync(path.join(bgDir, 'l2-bg-demo.png'), bgBuf)
  addAsset({ id: 'l2-bg-demo', level: 2, kind: 'bg', name: '演示合成背景（L1组合）', file: `/files/${DIRS.bg}/l2-bg-demo.png`, createdAt: Date.now(), source: 'l1-compose' })
  made.push('l2-bg-demo')
  return made
}

/* ---- 旧版 SVG 生成器（保持原样） ---- */

function productSvg(variant) {
  const palettes = [
    { body: '#7c6fd9', cap: '#2a2160', label: '#efeaff' },
    { body: '#d94f6c', cap: '#5a0d14', label: '#ffeef1' },
    { body: '#3f6ea8', cap: '#1d3a66', label: '#eaf3ff' },
  ]
  const c = palettes[variant % palettes.length]
  const shapes = [
    `<rect x="150" y="120" width="100" height="260" rx="18" fill="${c.body}"/>
     <rect x="175" y="80" width="50" height="50" rx="8" fill="${c.cap}"/>
     <rect x="165" y="200" width="70" height="90" rx="6" fill="${c.label}"/>`,
    `<rect x="120" y="200" width="160" height="140" rx="26" fill="${c.body}"/>
     <ellipse cx="200" cy="200" rx="80" ry="22" fill="${c.cap}"/>
     <rect x="150" y="245" width="100" height="60" rx="6" fill="${c.label}"/>`,
    `<rect x="110" y="160" width="180" height="180" rx="12" fill="${c.body}"/>
     <rect x="110" y="235" width="180" height="30" fill="${c.cap}"/>
     <rect x="185" y="160" width="30" height="180" fill="${c.cap}"/>`,
  ]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">${shapes[variant % shapes.length]}</svg>`
}

function modelSvg(variant) {
  const dresses = [
    ['#4130a1', '#a897d1'],
    ['#a1192b', '#ff9d8a'],
    ['#1d3a66', '#9cc3f0'],
  ]
  const [d1, d2] = dresses[variant % dresses.length]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="700">
  <defs>
    <linearGradient id="dress" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${d2}"/><stop offset="1" stop-color="${d1}"/>
    </linearGradient>
    <radialGradient id="hair" cx="0.5" cy="0.35" r="0.6">
      <stop offset="0" stop-color="#5b4636"/><stop offset="1" stop-color="#2e2318"/>
    </radialGradient>
  </defs>
  <ellipse cx="300" cy="676" rx="150" ry="20" fill="rgba(0,0,0,0.18)"/>
  <circle cx="300" cy="120" r="58" fill="url(#hair)"/>
  <circle cx="300" cy="132" r="44" fill="#f3d3b8"/>
  <path d="M252 196 Q300 176 348 196 L372 400 Q300 428 228 400 Z" fill="url(#dress)"/>
  <rect x="262" y="400" width="30" height="240" rx="12" fill="url(#dress)"/>
  <rect x="308" y="400" width="30" height="240" rx="12" fill="url(#dress)"/>
  <rect x="222" y="212" width="30" height="150" rx="14" fill="#f3d3b8"/>
  <rect x="348" y="212" width="30" height="150" rx="14" fill="#f3d3b8"/>
</svg>`
}
