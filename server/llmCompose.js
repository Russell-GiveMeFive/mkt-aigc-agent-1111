import { ask, askWithSkills } from './agent/driver.js'
import { newTrace } from './agentlog.js'
import { HTML_SYSTEM } from './agent/prompts.js'
import { enabledSkillsText, enabledSkillIds, skillCatalog } from './skills.js'
import { effective, DATA_DIR } from './config.js'
import { logEvent } from './agentlog.js'
import path from 'node:path'
import fs from 'node:fs'
import sharp from 'sharp'

/**
 * L2 背景合成 · 自然语言控制（走 pi Agent 层：ask → pi-ai 主路 / minimax 直连兜底）
 * L1 素材清单 + 用户自然语言 + html scope 技能 → M3 生成 720×1440 HTML（绝对定位精细控制）→ 渲染引擎截图
 * MOCK：无 Key 时用确定性规则模板拼装（同样产出 HTML，闭环不断）。
 */

/** MOCK 规则拼装：按 category 摆放 + instruction 里的透明度关键词 */
export function mockComposeHtml(items, instruction = '') {
  const opacityMatch = instruction.match(/(\d{1,3})\s*%/)
  const globalOpacity = opacityMatch ? Math.min(1, Number(opacityMatch[1]) / 100) : null
  const byCat = (c) => items.filter((i) => i.category === c)
  const abs = (url) => (url.startsWith('http') ? url : url)
  const layers = []

  const plates = byCat('plate')
  if (plates.length) {
    layers.push(`<img src="${abs(plates[0].url)}" style="position:absolute;inset:0;width:720px;height:1440px;object-fit:cover">`)
  } else {
    layers.push(`<div style="position:absolute;inset:0;background:linear-gradient(180deg,#4130a1,#8a76d8 55%,#d8cde8)"></div>`)
  }
  for (const p of byCat('pattern')) {
    const op = globalOpacity ?? 0.55
    layers.push(`<div style="position:absolute;inset:0;background-image:url('${abs(p.url)}');background-repeat:repeat;background-size:280px 280px;opacity:${op}"></div>`)
  }
  const arts = byCat('arttext')
  arts.forEach((a, i) => {
    const w = 520
    layers.push(`<img src="${abs(a.url)}" style="position:absolute;top:${180 + i * 200}px;left:${(720 - w) / 2}px;width:${w}px;opacity:${globalOpacity ?? 0.95}">`)
  })
  const labels = byCat('labelstyle')
  labels.forEach((l, i) => {
    layers.push(`<img src="${abs(l.url)}" style="position:absolute;top:0;left:0;width:720px;opacity:${globalOpacity ?? 0.9};z-index:30">`)
  })
  for (const w of byCat('watermark')) {
    layers.push(`<img src="${abs(w.url)}" style="position:absolute;right:36px;bottom:120px;width:140px;opacity:${globalOpacity ?? 0.3};z-index:40">`)
  }
  // 指令关键词的简单空间倾向
  if (/上部|顶部|上方/.test(instruction) && arts.length) {
    /* 已在顶部 */
  } else if (/下部|底部|下方/.test(instruction) && arts.length) {
    layers.push(`<style>img[src*="${arts[0].fileId}"]{top:1150px !important}</style>`)
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;width:720px;height:1440px;overflow:hidden;position:relative}img{display:block}</style></head><body>${layers.join('\n')}</body></html>`
}

/** 从指令提取结构化文字字段（「」标签式；任何标签缺失 → 该段不渲染） */
function parseFields(instruction = '') {
  const grab = (label) => {
    const m = instruction.match(new RegExp(`${label}「([^」]+)」`))
    return m ? m[1].trim() : null
  }
  const f = {
    brand: grab('门头'),
    date: grab('日期'),
    headline: grab('主标题'),
    sub: grab('副标题'),
    badges: (grab('卖点') || '').split('|').map((s) => s.trim()).filter(Boolean),
    price: grab('到手价'),
    oldPrice: grab('原价'),
    note: grab('底行'),
    color: (grab('主色') || '').trim() || '#e0417e',
    accent: (grab('辅助') || '').trim() || '#d9a441',
  }
  // 白名单里没填实际价格（模板占位 ¥____）不渲染价格段
  if (f.price && /_/.test(f.price)) f.price = null
  if (f.oldPrice && /_/.test(f.oldPrice)) f.oldPrice = null
  return f
}

/** 代码渲染文字层（系统级精确：字体/坐标/描边/胶囊全部受控，杜绝自创文案） */
function buildTextLayer(f, H = 1440) {
  const k = H / 1440
  const px = (v) => Math.round(v * k)
  if (!f || (!f.brand && !f.headline && !f.price)) return ''
  const font = `font-family:'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif`
  const parts = []
  if (f.brand) {
    parts.push(`<div style="position:absolute;top:0;left:0;width:720px;height:${px(150)}px;background:linear-gradient(180deg,${shade(f.color,-38)},${hexA(f.color,0.82)});z-index:91;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px">
      <div style="${font};font-size:${px(52)}px;font-weight:800;color:#fff;letter-spacing:${px(10)}px;text-shadow:0 2px 8px rgba(0,0,0,0.25)">${esc(f.brand)}</div>
      ${f.date ? `<div style="${font};font-size:${px(30)}px;font-weight:600;color:${f.accent};letter-spacing:${px(6)}px">${esc(f.date)}</div>` : ''}
    </div>`)
  }
  if (f.headline) {
    parts.push(`<div style="position:absolute;top:${px(196)}px;left:0;width:720px;z-index:91;background:linear-gradient(180deg,${hexA('#ffffff',0.66)},${hexA('#ffffff',0.30)});padding:${px(22)}px 0 ${px(26)}px;text-align:center">
      <div style="${font};font-size:${Math.round((f.headline.length > 5 ? 84 : 100) * k)}px;font-weight:900;line-height:1.12;color:#fff;letter-spacing:2px;text-shadow:0 0 2px ${f.color},0 0 6px ${f.color},0 3px 4px ${hexA(shade(f.color,-30),0.9)},0 6px 18px rgba(0,0,0,0.28);-webkit-text-stroke:2px ${hexA('#ffffff',0.85)}">${esc(f.headline)}</div>
      ${f.sub ? `<div style="display:inline-block;margin-top:${px(22)}px;padding:${px(14)}px ${px(58)}px;border-radius:999px;background:linear-gradient(135deg,${f.accent},${shade(f.accent,-16)});box-shadow:0 6px 16px ${hexA(shade(f.accent,-30),0.45)}"><span style="${font};font-size:${px(46)}px;font-weight:800;color:#fff;letter-spacing:${px(6)}px;text-shadow:0 1px 3px rgba(0,0,0,0.3)">${esc(f.sub)}</span></div>` : ''}
    </div>`)
  }
  if (f.badges?.length) {
    const pills = f.badges.slice(0, 4).map((b) => `<span style="${font};display:inline-block;padding:${px(16)}px ${px(34)}px;border-radius:999px;background:${hexA(shade(f.color,-18),0.88)};box-shadow:0 4px 10px rgba(0,0,0,0.18)"><span style="font-size:${px(30)}px;font-weight:700;color:#fff;letter-spacing:${px(3)}px">${esc(b)}</span></span>`).join('<span style="display:inline-block;width:' + px(22) + 'px"></span>')
    parts.push(`<div style="position:absolute;top:${px(1116)}px;left:0;width:720px;z-index:91;text-align:center">${pills}</div>`)
  }
  if (f.price) {
    parts.push(`<div style="position:absolute;top:${px(1246)}px;left:0;width:720px;height:${px(194)}px;background:linear-gradient(180deg,${f.color},${shade(f.color,-30)});z-index:91;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px">
      <div style="display:flex;align-items:baseline;gap:14px">
        <span style="${font};font-size:${px(44)}px;font-weight:800;color:#fff">到手价</span>
        <span style="${font};font-size:${px(42)}px;font-weight:900;color:${f.accent};text-shadow:0 2px 4px rgba(0,0,0,0.3)">¥</span>
        <span style="${font};font-size:${px(126)}px;font-weight:900;line-height:1;color:#fff;letter-spacing:${px(2)}px;text-shadow:0 4px 10px rgba(0,0,0,0.3)">${esc(String(f.price).replace(/[¥￥\s]/g, ''))}</span>
        ${f.oldPrice ? `<span style="${font};font-size:${px(36)}px;font-weight:600;color:${hexA('#ffffff',0.72)};text-decoration:line-through">${esc(String(f.oldPrice).replace(/[^\d.]/g, ''))}</span>` : ''}
      </div>
      ${f.note ? `<div style="${font};font-size:${px(28)}px;font-weight:600;color:${hexA('#ffffff',0.92)};letter-spacing:${px(4)}px">${esc(f.note)}</div>` : ''}
    </div>`)
  }
  return parts.length ? `<div style="position:absolute;inset:0;z-index:90;pointer-events:none">${parts.join('\n')}</div>` : ''
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function hexA(hex, a) {
  const m = String(hex).replace('#', '')
  const n = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  const r = parseInt(n.slice(0, 2), 16) || 0, g = parseInt(n.slice(2, 4), 16) || 0, b = parseInt(n.slice(4, 6), 16) || 0
  return `rgba(${r},${g},${b},${a})`
}
function shade(hex, pct) {
  const m = String(hex).replace('#', '')
  const n = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  const f = (i) => Math.max(0, Math.min(255, Math.round(parseInt(n.slice(i, i + 2), 16) * (1 + pct / 100))))
  return `#${[f(0), f(2), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** DOM 文本清洗：删除 M3 违规输出的可见文字（零文字模式兜底；跳过 CSS 内容） */
function stripStrayText(html) {
  let removed = 0
  const out = html.replace(/<style[\s\S]*?<\/style>/gi, (m) => m) // 保护 style
  const cleaned = out.replace(/>([^<>]+)</g, (mm, txt) => {
    if (txt.includes('{') || txt.includes('}') || !txt.trim()) return mm
    removed++
    return `>${txt.replace(/\S/g, '')}<`
  })
  return { html: cleaned.replace(/<style[\s\S]*?<\/style>/gi, (m) => m), removed }
}

/** 生成 L2 背景 HTML（log.taskId: 背景名/请求标识，写入运行日志） */
export async function composeHtml({ items, instruction, log = {} }) {
  const localTrace = log.traceId || newTrace() // 本地 trace：入口解析+LLM 各轮+渲染入库 同组
  const cfg = effective()
  if (cfg.mock || !cfg.apiKey) {
    return { html: mockComposeHtml(items, instruction), source: 'mock-template' }
  }
  const list = items.map((i) => `- fileId: ${i.fileId} | category: ${i.category} | name: ${i.name || ''} | URL: ${i.url}`).join('\n')
  const fields = parseFields(instruction)
  // 动态画幅：以底版图比例为准（html 宽高比与底版完全一致）
  let canvasH = 1440
  const plate0 = (items || []).find((i) => i.category === 'plate')
  if (plate0) {
    try {
      const meta = await sharp(path.join(DATA_DIR, 'buckets', 'l1', plate0.fileId)).metadata()
      if (meta?.width && meta?.height) canvasH = Math.max(600, Math.min(2600, Math.round(720 * meta.height / meta.width)))
    } catch {}
  }
  const visualOnly = `素材清单：\n${list}\n\n用户视觉指令：${instruction || '按素材类型合理铺满画布，风格统一'}\n\n（注意：你只输出视觉层，画面中严禁出现任何文字；底版图/艺术字/水印的位置由系统精确注入，你无需放置它们，你的输出若包含这三类素材的 <img> 会被系统替换）\n（明度铁律：整体保持中高调明亮——用 rgba(255,255,255,0.12~0.22) 的白色提亮罩（普通层）与明亮柔光斑提升光线感；严禁大面积低明度色块/深色罩压暗画面；商品后方光斑必须明亮（白色系 halo））${fields.brand || fields.headline || fields.price ? '\n（系统将在门头带/主标题区/卖点带/价格带叠文字，请按第 3 条给这些分区垫底色）' : '\n（本次系统不叠文字：不要画空门头带/空价格带色条，画面上下保持底版与氛围自然延展，水印图放画面右上角小幅放置）'}`
  const skillIds = enabledSkillIds('html')
  // 主路：function-call 式技能调用（模型按需 load_skill 拉取技能全文）
  let raw, meta
  try {
    const catalog = skillCatalog('html')
    const r = await askWithSkills({
      system: HTML_SYSTEM,
      text: visualOnly,
      catalog,
      maxTokens: 32768,
      thinking: 'adaptive',
      log: { biz: 'l2compose', taskId: log.taskId, traceId: localTrace, stage: 'compose-html', scope: 'html', skillCount: catalog.length },
    })
    raw = r.text
    meta = { tools: true, skillsLoaded: r.skillsLoaded, skillCount: (r.skillsLoaded || []).length, skillChars: 0 }
  } catch (e) {
    // 降级：pi 主路不可用时回退全量注入（与旧行为一致）
    const skills = enabledSkillsText('html')
    raw = await ask({
      system: HTML_SYSTEM,
      text: `${visualOnly}${skills ? `\n\n附加技能/规范（必须遵守）：\n${skills}` : ''}`,
      maxTokens: 32768,
      thinking: 'adaptive',
      log: { biz: 'l2compose', taskId: log.taskId, stage: 'compose-html', skillIds, skillChars: skills.length },
    })
    meta = { tools: false, skillCount: skillIds.length, skillChars: skills.length }
  }
  return await finalize(raw, items, fields, meta, canvasH, instruction, localTrace)
}

/** HTML 提取 + 违规文字清洗 + 底版强制垫底 + 系统文字层注入 */
async function finalize(raw, items, fields, extra = {}, H = 1440, instruction = '', traceId = null) {
  const m = raw.match(/<!DOCTYPE html[\s\S]*<\/html>/i) || raw.match(/<html[\s\S]*<\/html>/i)
  if (!m) throw new Error('LLM 未返回有效 HTML')
  let html = m[0]
  // 1) 清洗 M3 违规文字（零文字模式兜底）
  const stripped = stripStrayText(html)
  html = stripped.html
  // 2) 底版无条件强制垫底：删掉 M3 画的 plate img（位置/尺寸不可信），系统注入铺满 720×1440 的版本
  let plateForced = false
  const plates = (items || []).filter((i) => i.category === 'plate')
  if (plates.length) {
    const pid = plates[0].fileId
    const hadIt = html.includes(pid)
    if (hadIt) {
      // 删除 M3 对底版的引用（其尺寸/位置自由发挥导致黑边、错位）
      html = html.replace(new RegExp(`<img[^>]*${pid}[^>]*>`, 'gi'), '')
      html = html.replace(new RegExp(`<div[^>]*background[^>]*${pid}[^>]*>`, 'gi'), '')
    }
    const tag = `<img src="${plates[0].url}" style="position:absolute;top:0;left:0;width:720px;height:${H}px;z-index:5;object-fit:cover">`
    html = html.includes('<body')
      ? html.replace(/<body([^>]*)>/i, (mm, attrs) => `<body${attrs}>${tag}`)
      : `${tag}${html}`
    plateForced = true
  }
  const px = (v) => Math.round(v * H / 1440)
  // 2.5) 全屏背景层透明化：M3 常违规画不透明全屏色块盖住底版——把全屏 div 的背景清空（保留其子内容）
  html = html.replace(/<div\b[^>]*>/gi, (tag) => {
    if (!/position\s*:\s*absolute/i.test(tag)) return tag
    const fullW = /(width\s*:\s*(720px|100%))|(inset\s*:\s*0)/i.test(tag)
    const fullH = new RegExp(`(height\\s*:\\s*(100%|${H}px))|(bottom\\s*:\\s*0[^;]*)`, 'i').test(tag)
    if (!(fullW && fullH)) return tag
    return tag.replace(/(background(?:-image)?\s*:\s*)[^;\"']+/gi, '$1transparent')
  })
  // 2.8) 商品层级强制：M3 画的商品 img 统一 z-index:10（保证在底版之上）
  for (const pr of (items || []).filter((i) => i.category === 'product')) {
    html = html.replace(new RegExp(`(<img[^>]{0,400}${pr.fileId}[^>]{0,400}?)style="([^"]*)"(.*?)>`, 'gi'), (m, a, style, tail) => {
      const zRemoved = style.replace(/z-index\s*:\s*\d+\s*;?/gi, '')
      return `${a}style="${zRemoved};z-index:10"${tail}>`
    })
  }
  // 3) 艺术字/水印系统定位（代码级：顶端 20% 居中 / 右上角），删除 M3 的乱放版本
  const adj = parseAdjust(instruction)
  logEvent({ biz: 'l2compose', traceId, stage: 'adjust-parse', status: 'ok', note: `ai: strict=${adj.strict} pScale=${adj.productScale} aScale=${adj.artScale} shift=${JSON.stringify(adj.productShift)} anchor=${JSON.stringify(adj.productAnchor)}` })
  // 艺术字：系统定位（可见中心锚 20%H；与画布同比的素材按注册图层原位叠加）
  const arts = (items || []).filter((i) => i.category === 'arttext')
  for (const a of arts) html = html.replace(new RegExp(`<img[^>]*${a.fileId}[^>]*>`, 'gi'), '')
  const placed = await placeArtLayers(items, H, adj, 20)
  for (const tag of placed.tags) html = html.replace(/<\/body>/i, `${tag}</body>`)
  // 商品：有量化指令时系统重注入（先删 M3 摆放版，保证放大/位移精确生效）
  const prods = (items || []).filter((i) => i.category === 'product')
  const hasProdAdj = adj.productScale !== 1 || adj.productShift.x !== 0 || adj.productShift.y !== 0 || adj.productShiftPx.x !== 0 || adj.productShiftPx.y !== 0
  if (prods.length && hasProdAdj) {
    for (const pr of prods) html = html.replace(new RegExp(`<img[^>]*${pr.fileId}[^>]*>`, 'gi'), '')
    const hRatio = adj.strict ? 0.46 * adj.productScale : Math.min(0.85, 0.46 * adj.productScale)
    // alpha 可见内容中心锚（v2/v3 规范）：可见中心落在目标点，而不是整张透明画布
    const pbox = await probeVisibleBox(prods[0].fileId)
    const vcx = pbox ? ((pbox.l + pbox.r) / 2) / pbox.w : 0.5
    const vcy = pbox ? ((pbox.t + pbox.b) / 2) / pbox.h : 0.5
    const renderH = H * hRatio
    const renderW = renderH * (pbox ? pbox.w / pbox.h : 0.72)
    const px2L = 720 / (extra && extra.width ? extra.width : 1440) // 底版像素 → 逻辑像素
    // 目标：可见中心 = 画幅正中央 + 位移（默认基准为正中央；九宫格锚点覆盖时用锚点）
    let targetCx = 360 + (adj.productShift.x * 720) + adj.productShiftPx.x * px2L
    let targetCy = H * 0.5 + (adj.productShift.y * H) + adj.productShiftPx.y * px2L
    if (adj.productAnchor) {
      if (adj.productAnchor.top != null) targetCy = H * adj.productAnchor.top + H * (0.46 - hRatio) / 2 + (adj.productShift.y * H) + adj.productShiftPx.y * px2L
      if (adj.productAnchor.bottom != null) targetCy = H * (1 - adj.productAnchor.bottom) - H * hRatio + (adj.productShift.y * H) + adj.productShiftPx.y * px2L
    }
    let prodTop = targetCy - renderH * vcy
    let prodLeftN = targetCx - renderW * vcx
    if (!adj.strict) prodTop = Math.max(H * 0.05 - renderH * 0.2, Math.min(prodTop, H * 0.99 - renderH * vcy * 1.2))
    const tag = `<img src="${prods[0].url}" style="position:absolute;top:${Math.round(prodTop)}px;left:${Math.round(prodLeftN)}px;width:${Math.round(renderW)}px;height:auto;z-index:10;${adj.strict ? '' : 'max-width:96%;object-fit:contain;'}filter:drop-shadow(0 ${px(H / 1440)}px ${px(36 * H / 1440)}px rgba(120,80,90,0.28))">`
    html = html.replace(/<\/body>/i, `${tag}</body>`)
  }
  for (const w of (items || []).filter((i) => i.category === 'watermark')) {
    html = html.replace(new RegExp(`<img[^>]*${w.fileId}[^>]*>`, 'gi'), '')
    const wpx = Math.round(H / 1440 * 90 * adj.watermarkScale)
    const tag = `<img src="${w.url}" style="position:absolute;top:${Math.round(H * 0.02 + adj.watermarkShift.y * H)}px;right:${24 - Math.round(adj.watermarkShift.x * 720)}px;width:${wpx}px;height:auto;z-index:30;opacity:0.9">`
    html = html.replace(/<\/body>/i, `${tag}</body>`)
  }
  // 4) 系统文字层注入（代码渲染，100% 精确）
  const textLayer = buildTextLayer(fields, H)
  if (textLayer) html = html.replace(/<\/body>/i, `${textLayer}</body>`)
  return { html, source: 'minimax-m3', width: 720, height: H, plateForced, plateFileId: plates[0]?.fileId, strippedCount: stripped.removed, textLayer: !!textLayer, arttextCount: arts.length, ...extra }
}

/** 解析量化调整指令：商品图放大300% / 标题文字图缩小80% / 商品下移5% / 艺术字上移20px / 水印右移2% 等 */
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5, 两: 2 }
function cnNum(str) {
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str)
  if (CN_NUM[str]) return CN_NUM[str]
  const m = str.match(/^十([一二三四五六七八九])?$/) // 十一~十九
  if (m) return 10 + (m[1] ? CN_NUM[m[1]] : 0)
  return null
}

/** 解析量化调整 v2：宽覆盖「放大/缩小 X% / X倍 / 中文数字」「上/下/左/右移」「放到九宫格位置」；主语可省略（默认商品） */
export function parseAdjust(instruction = '') {
  const adj = {
    productScale: 1, artScale: 1, watermarkScale: 1,
    productShift: { x: 0, y: 0 }, artShift: { x: 0, y: 0 }, watermarkShift: { x: 0, y: 0 }, productShiftPx: { x: 0, y: 0 }, artShiftPx: { x: 0, y: 0 }, watermarkShiftPx: { x: 0, y: 0 },
    productAnchor: null, artAnchor: null, // 九宫格：'top|middle|bottom' + 'left|center|right'
    strict: false, // 严格参数模式（v2）：倍率不受上限/安全区约束，超画布由 overflow:hidden 裁切并报告
  }
  if (!instruction) return adj
  adj.strict = /固定为|最终倍率|严格执行|不得自动调整|scale\s*=|精确倍率/.test(String(instruction))
  const text = String(instruction)
  const T = '(商品(?:图|图吗|的图)?|标题(?:文字图|文字|图)?|艺术字|水印(?:图)?)'
  const NUM = '([\\d.]+|十[一二三四五六七八九]?|[一二三四五六七八九十两半])'
  // 缩放：放大/扩大/增大/缩小/减小 + N%（到/为 可选）或 N倍
  let lastTarget = 'product'
  for (const m of text.matchAll(new RegExp(T + '[^。；\\n]{0,40}?(放大到|放大|固定为|最终为|设为|设置为|定为|扩大|增大|缩小到|缩小|减小|缩放)[到为成]?[^0-9。；\\n,，]{0,12}' + NUM + '\\s*(%|倍)?', 'g'))) {
    let v = cnNum(m[3])
    if (v == null) continue
    // 否定守卫：「不得擅自将商品图缩小到200%」等否定句不是指令；坐标/位置语境不是倍率
    if (/不得|不要|禁止|不能|无需|避免/.test(m[1]) || /不得|禁止|不能/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue
    if (/坐标|位置|高度|宽度|距离|透明度/.test(m[0] || '')) continue
    const down = /缩小|减小/.test(m[2])
    // 「到/为」= 设值语义（最终倍率）；纯「放大/缩小」= 增减语义；「倍」恒为倍数
    const toForm = /到|为/.test(m[2]) || /固定为|最终为|设为|设置为|定为|scale\s*=/.test(m[0])
    let scale
    if (m[4] === '倍') scale = down ? 1 / v : v
    else if (toForm) scale = v / 100
    else scale = down ? Math.max(0.02, 1 - v / 100) : 1 + v / 100
    // 主语：显式 > 句内省略延续上一目标（如「标题缩小35%，最终缩放倍率为65%」两句同指标题）
    const target = /商品/.test(m[1]) ? 'product' : /标题|艺术字/.test(m[1]) ? 'art' : /水印/.test(m[1]) ? 'watermark' : lastTarget
    adj[target === 'product' ? 'productScale' : target === 'art' ? 'artScale' : 'watermarkScale'] = scale
    lastTarget = target
  }
  // scale=N 写法（v2 严格参数模式）：scale=5 → 5×；主语缺省视为商品
  for (const m of text.matchAll(/scale\s*=\s*([\d.]+)/gi)) {
    const v = parseFloat(m[1])
    if (!isFinite(v) || v <= 0) continue
    // 主语取 scale= 紧邻的前文（≤10 字内的最近主语），避免抓到段落标题；无则延续 lastTarget
    const before = text.slice(Math.max(0, m.index - 10), m.index)
    let target = null
    if (/艺术字|标题/.test(before)) target = 'art'
    else if (/水印/.test(before)) target = 'watermark'
    else if (/商品/.test(before)) target = 'product'
    if (!target) target = lastTarget === 'art' ? 'art' : lastTarget === 'watermark' ? 'watermark' : 'product'
    adj[target === 'product' ? 'productScale' : target === 'art' ? 'artScale' : 'watermarkScale'] = v
  }
  // 平移：上/下/左/右移 N（px/像素/%）
  for (const m of text.matchAll(new RegExp(T + '[^。；\\n]{0,40}?(上移|下移|左移|右移)[^0-9。；\\n,，]{0,4}' + NUM + '\\s*(px|像素|%)?', 'g'))) {
    const key = /商品/.test(m[1]) ? 'productShift' : /标题|艺术字/.test(m[1]) ? 'artShift' : 'watermarkShift'
    let v = cnNum(m[3])
    if (v == null) continue
    let unit = m[4] || '%'
    let r = unit === '%' ? v / 100 : v / 720
    const pKey = key + 'Px'
    const dir = { 上移: -1, 下移: 1, 左移: -1, 右移: 1 }[m[2]] || 0
    if (unit !== '%') {
      if (m[2] === '上移' || m[2] === '下移') adj[pKey].y += dir * v
      else adj[pKey].x += dir * v
    }
    if (m[2] === '上移') adj[key].y -= r
    if (m[2] === '下移') adj[key].y += r
    if (m[2] === '左移') adj[key].x -= r
    if (m[2] === '右移') adj[key].x += r
  }
  // 九宫格定位：放到/置于/放在 顶部/中部/底部 × 左侧/居中/右侧
  for (const m of text.matchAll(new RegExp(T + '[^。；\\n,，]{0,6}?(?:放到|置于|放在|移到)[^。；\\n,，]{0,6}?(顶部|顶端|上方|中部|中间|中央|居中|底部|底端|下方|左上|右上|左下|右下|左侧|右侧)', 'g'))) {
    const pos = m[2]
    const key = /商品/.test(m[1]) ? 'productAnchor' : /标题|艺术字/.test(m[1]) ? 'artAnchor' : null
    if (!key) continue
    adj[key] = {
      top: /顶部|顶端|上方|左上|右上/.test(pos) ? 0.06 : /底部|底端|下方|左下|右下/.test(pos) ? null : 0.30,
      bottom: /底部|底端|下方|左下|右下/.test(pos) ? 0.06 : null,
      left: /左上|左下|左侧/.test(pos) ? 0.12 : /右上|右下|右侧/.test(pos) ? 0.88 : 0.5,
    }
  }
  return adj
}

// ── 分层素材可见边界探测（封装自 layered-marketing-poster skill 的 probe_assets）
const probeCache = new Map()
async function probeVisibleBox(fileId) {
  if (probeCache.has(fileId)) return probeCache.get(fileId)
  let box = null
  try {
    const fp = path.join(DATA_DIR, 'buckets', 'l1', fileId)
    const { data, info } = await sharp(fp).raw().toBuffer({ resolveWithObject: true })
    if (info.channels === 4) {
      let l = info.width, t = info.height, r = 0, b = 0, found = false
      for (let y = 0; y < info.height; y++) {
        const row = y * info.width * 4
        for (let x = 0; x < info.width; x++) {
          if (data[row + x * 4 + 3] > 8) {
            if (!found) { found = true; l = r = x; t = b = y }
            if (x < l) l = x; if (x > r) r = x
            if (y < t) t = y; if (y > b) b = y
          }
        }
      }
      if (found) box = { l, t, r: r + 1, b: b + 1, w: info.width, h: info.height }
    }
  } catch {}
  probeCache.set(fileId, box)
  return box
}

// 裁掉透明边距的派生文件（不改原件），用于精确中心锚定
async function trimmedArtUrl(fileId) {
  const src = path.join(DATA_DIR, 'buckets', 'l1', fileId)
  const out = src.replace(/(\.png|\.jpg|\.jpeg|\.webp)$/i, '') + '.trim.png'
  try {
    if (!fs.existsSync(out)) {
      const box = await probeVisibleBox(fileId)
      if (box) {
        await sharp(src).extract({ left: box.l, top: box.t, width: box.r - box.l, height: box.b - box.t }).png().toFile(out)
      } else {
        await sharp(src).png().toFile(out)
      }
    }
    return `/v2/files/l1/${path.basename(out)}`
  } catch {
    return `/v2/files/l1/${fileId}`
  }
}

// 艺术字系统注入：注册图层（与画布同比 → 原位叠加）或可见中心锚（默认中心 y=20%H）
async function placeArtLayers(items, H, adj, zIdx = 20) {
  const arts = (items || []).filter((i) => i.category === 'arttext')
  const tags = []
  let bottom = 0
  for (let i = 0; i < arts.length; i++) {
    const a = arts[i]
    // 一律按 alpha 可见内容中心锚定（裁掉透明边距）：可见中心默认 y=20%H
    const url = await trimmedArtUrl(a.fileId)
    let tw = 0, th = 0
    try { const m = await sharp(path.join(DATA_DIR, 'buckets', 'l1', path.basename(url))).metadata(); tw = m.width; th = m.height } catch {}
    if (!tw || !th) { tags.push(`<img src="${a.url}" style="position:absolute;top:${Math.round(H * 0.2)}px;left:50%;transform:translateX(-50%);max-width:70%;z-index:${zIdx}">`); continue }
    const wPct = adj.strict ? 70 * adj.artScale : Math.min(92, 70 * adj.artScale)
    const renderW = wPct / 100 * 720
    const renderH = renderW * th / tw
    const cy = H * (0.20 + i * 0.12) + adj.artShift.y * H
    const cx = (adj.artAnchor ? adj.artAnchor.left : 0.5) * 720 + adj.artShift.x * 720
    const left = Math.round(cx - renderW / 2)
    const top = Math.round(Math.max(0, cy - renderH / 2))
    tags.push(`<img src="${url}" style="position:absolute;top:${top}px;left:${left}px;width:${Math.round(renderW)}px;height:auto;z-index:${zIdx}">`)
    bottom = Math.max(bottom, top + renderH)
  }
  return { tags, count: arts.length, bottom }
}

/** 样式合成（模板直出，不调用大模型）：底版 + 按官方大促海报规范的文字层/商品层
 * 参照样式：门头带(品牌+日期) → 主标题(艺术字或渐变大字) → 特大促销副标 → 大商品压底版焦点 → 商品名胶囊 → 底部活动说明 */
export async function composeTemplateHtml({ items, instruction, log = {} }) {
  const localTrace = log.traceId || newTrace()
  const fields = parseFields(instruction)
  const adj = parseAdjust(instruction)
  logEvent({ biz: 'l2compose', traceId: localTrace, stage: 'adjust-parse', status: 'ok', note: `template: strict=${adj.strict} pScale=${adj.productScale} aScale=${adj.artScale} shift=${JSON.stringify(adj.productShift)} anchor=${JSON.stringify(adj.productAnchor)}` })
  let H = 1440
  let plateW = 1440
  const plate0 = (items || []).find((i) => i.category === 'plate')
  let plateUrl = ''
  if (plate0) {
    plateUrl = plate0.url
    try {
      const meta = await sharp(path.join(DATA_DIR, 'buckets', 'l1', plate0.fileId)).metadata()
      if (meta?.width && meta?.height) {
        plateW = meta.width
        H = Math.max(600, Math.min(2600, Math.round(720 * meta.height / meta.width)))
      }
    } catch {}
  }
  const k = H / 1440
  const px = (v) => Math.round(v * k)
  const parts = []
  // 底版铺满
  if (plateUrl) parts.push(`<img src="${plateUrl}" style="position:absolute;top:0;left:0;width:720px;height:${H}px;object-fit:cover">`)
  // 顶部提亮薄纱（轻，不盖相框细节）
  parts.push(`<div style="position:absolute;top:0;left:0;width:720px;height:${px(300)}px;background:linear-gradient(180deg,rgba(255,255,255,0.28),rgba(255,255,255,0))"></div>`)
  // 门头带：品牌字 + 日期
  if (fields.brand) {
    parts.push(`<div style="position:absolute;top:${px(58)}px;left:0;width:720px;text-align:center">
      <div style="font-family:'PingFang SC','Microsoft YaHei',sans-serif;font-size:${px(46)}px;font-weight:900;letter-spacing:${px(8)}px;background:linear-gradient(135deg,#7b5cff,#b83b8e);-webkit-background-clip:text;background-clip:text;color:transparent">${esc(fields.brand)}</div>
      ${fields.date ? `<div style="margin-top:${px(10)}px;font-family:'PingFang SC',sans-serif;font-size:${px(26)}px;font-weight:700;letter-spacing:${px(10)}px;color:#9b6bb8">${esc(fields.date)}</div>` : ''}
    </div>`)
  }
  // 主标题：优先艺术字素材（系统定位 20%），否则渐变大字
  const arts = (items || []).filter((i) => i.category === 'arttext')
  let textTop = px(170)
  if (arts.length) {
    const placed = await placeArtLayers(items, H, adj, 20)
    for (const tag of placed.tags) parts.push(tag)
    textTop = Math.round((placed.bottom || px(300)) + px(60))
  } else if (fields.headline) {
    parts.push(`<div style="position:absolute;top:${textTop}px;left:0;width:720px;text-align:center;font-family:'PingFang SC',sans-serif;font-size:${px(72)}px;font-weight:900;letter-spacing:${px(6)}px;background:linear-gradient(135deg,#6a4bd8,#c04a9e);-webkit-background-clip:text;background-clip:text;color:transparent">${esc(fields.headline)}</div>`)
    textTop += px(100)
  }
  // 特大促销副标：前导数字（如「1元」「立减400」）玫红特大，其余深紫渐变大字
  if (fields.sub) {
    const mNum = fields.sub.match(/^([0-9]+元?|[一二三四五六七八九十]+元?)([\s\S]*)$/)
    if (mNum) {
      parts.push(`<div style="position:absolute;top:${textTop}px;left:0;width:720px;text-align:center;white-space:nowrap">
        <span style="font-family:'PingFang SC',sans-serif;font-size:${px(132)}px;font-weight:900;color:#e8296a;text-shadow:0 ${px(4)}px ${px(10)}px rgba(232,41,106,0.25);vertical-align:middle">${esc(mNum[1])}</span>
        <span style="font-family:'PingFang SC',sans-serif;font-size:${px(96)}px;font-weight:900;letter-spacing:${px(4)}px;background:linear-gradient(135deg,#5a3fd0,#a83a9a);-webkit-background-clip:text;background-clip:text;color:transparent;vertical-align:middle">${esc(mNum[2] || '')}</span>
      </div>`)
    } else {
      parts.push(`<div style="position:absolute;top:${textTop}px;left:0;width:720px;text-align:center;font-family:'PingFang SC',sans-serif;font-size:${px(88)}px;font-weight:900;letter-spacing:${px(6)}px;background:linear-gradient(135deg,#5a3fd0,#a83a9a);-webkit-background-clip:text;background-clip:text;color:transparent">${esc(fields.sub)}</div>`)
    }
    textTop += px(170)
  }
  // 商品：大图压底版视觉焦点（中央），强制 z10
  const prods = (items || []).filter((i) => i.category === 'product')
  if (prods.length) {
    // 放大/缩小时保持商品中心不变，底边不超 98% 画布（超出自动截断）
    const hRatio = adj.strict ? 0.46 * adj.productScale : Math.min(0.85, 0.46 * adj.productScale)
    // alpha 可见内容中心锚（v3 规范）+ 底版像素位移换算
    const pbox = await probeVisibleBox(prods[0].fileId)
    const vcx = pbox ? ((pbox.l + pbox.r) / 2) / pbox.w : 0.5
    const vcy = pbox ? ((pbox.t + pbox.b) / 2) / pbox.h : 0.5
    const renderH = H * hRatio
    const renderW = renderH * (pbox ? pbox.w / pbox.h : 0.72)
    const px2L = 720 / (plateW || 1440)
    let targetCx = 360 + (adj.productShift.x * 720) + adj.productShiftPx.x * px2L
    let targetCy = H * 0.5 + (adj.productShift.y * H) + adj.productShiftPx.y * px2L
    if (adj.productAnchor) {
      if (adj.productAnchor.top != null) targetCy = H * adj.productAnchor.top + H * (0.46 - hRatio) / 2 + (adj.productShift.y * H) + adj.productShiftPx.y * px2L
      if (adj.productAnchor.bottom != null) targetCy = H * (1 - adj.productAnchor.bottom) - H * hRatio + (adj.productShift.y * H) + adj.productShiftPx.y * px2L
    }
    const prodTop = targetCy - renderH * vcy
    const prodLeftN = targetCx - renderW * vcx
    parts.push(`<img src="${prods[0].url}" style="position:absolute;top:${Math.round(prodTop)}px;left:${Math.round(prodLeftN)}px;width:${Math.round(renderW)}px;height:auto;z-index:10;${adj.strict ? '' : 'max-width:96%;object-fit:contain;'}filter:drop-shadow(0 ${px(24)}px ${px(36)}px rgba(190,70,120,0.30))">`)
  }
  // 商品名胶囊（可选字段 product「」）
  const prodName = (instruction.match(/商品名「([^」]+)」/) || [])[1]
  if (prodName) {
    parts.push(`<div style="position:absolute;top:${Math.round(H * 0.72)}px;right:${px(40)}px;z-index:15;display:flex;align-items:center;background:rgba(255,255,255,0.92);border:${px(2)}px solid #f3c9d8;border-radius:${px(10)}px;padding:${px(12)}px ${px(22)}px;box-shadow:0 ${px(6)}px ${px(16)}px rgba(190,70,120,0.18)">
      <span style="width:${px(8)}px;height:${px(30)}px;background:#e8296a;border-radius:999px;margin-right:${px(14)}px"></span>
      <span style="font-family:'PingFang SC',sans-serif;font-size:${px(34)}px;font-weight:700;color:#7a4a5e;letter-spacing:${px(3)}px">${esc(prodName)}</span>
    </div>`)
  }
  // 底部活动说明
  if (fields.note) {
    parts.push(`<div style="position:absolute;top:${H - px(70)}px;left:0;width:720px;text-align:center;font-family:'PingFang SC',sans-serif;font-size:${px(26)}px;font-weight:600;color:#b98aa5;letter-spacing:${px(3)}px">${esc(fields.note)}</div>`)
  }
  // 水印右上
  for (const w of (items || []).filter((i) => i.category === 'watermark')) {
    const wpx = Math.round(px(90) * adj.watermarkScale)
    parts.push(`<img src="${w.url}" style="position:absolute;top:${px(24) + Math.round(adj.watermarkShift.y * H)}px;right:${px(24) - Math.round(adj.watermarkShift.x * 720)}px;width:${wpx}px;height:auto;z-index:30;opacity:0.9">`)
  }
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;width:720px;height:${H}px;overflow:hidden;position:relative">${parts.join('\n')}</body></html>`
  return { html, source: 'template-direct', width: 720, height: H, textLayer: false, plateForced: false }
}
