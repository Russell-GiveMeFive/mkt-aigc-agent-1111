import sharp from 'sharp'
import { askVision, parseJsonLoose } from './driver.js'
import { effective } from '../config.js'
import { enabledSkillsText, enabledSkillIds } from '../skills.js'
import { QC_SYSTEM } from './prompts.js'

/**
 * QC Judge Agent —— 京东素材规范视觉裁判（pi Agent 层 · askVision）
 * 输入：海报 PNG + 版式规范 + 文案 + qc scope 技能；输出：严格 JSON verdict
 *   { pass, score(0-100), defects:[{code,severity,note}], repairPlan:{stage,action}, source }
 * MOCK 模式：本地启发式规则（区域对比度/要素存在性），可先闭环全流程。
 */

// 注意：`export { X as Y }` 不会创建局部绑定 Y，必须显式声明别名供模块内使用
export const QC_SYSTEM_PROMPT = QC_SYSTEM

const DEFECT_CODES = {
  LOW_CONTRAST_HEADLINE: '标题区对比度不足',
  PRODUCT_MISSING: '商品缺失或过小',
  CTA_MISSING: 'CTA 缺失',
  RESOLUTION_MISMATCH: '尺寸不符合 720×1440',
}

/** MOCK 启发式裁判：采样关键区域做存在性/对比度检查 */
async function mockJudge(posterBuffer, layout) {
  const { canvas, zones } = layout
  const defects = []

  const meta = await sharp(posterBuffer).metadata()
  if (meta.width !== canvas.width || meta.height !== canvas.height) {
    defects.push({ code: 'RESOLUTION_MISMATCH', severity: 'high', note: `${meta.width}×${meta.height} ≠ ${canvas.width}×${canvas.height}` })
  }

  // 标题区：要求存在高对比像素（白描边/accent 字色）
  const hz = zones.headline
  const headStat = await sharp(posterBuffer).extract({ left: hz.x, top: hz.y, width: hz.w, height: Math.min(hz.h, 100) }).png().toBuffer().then((b) => sharp(b).stats())
  const headContrast = headStat.channels[0].stdev
  if (headContrast < 18) defects.push({ code: 'LOW_CONTRAST_HEADLINE', severity: 'high', note: `标题区标准差 ${headContrast.toFixed(1)} 过低` })

  // 商品区：全区域须有纹理，且正中心必须存在商品内容（缺失时中心是均匀辉光）
  const pz = zones.product
  const prodStat = await sharp(posterBuffer).extract({ left: pz.x, top: pz.y, width: pz.w, height: pz.h }).png().toBuffer().then((b) => sharp(b).stats())
  const prodStd = prodStat.channels.reduce((a, c) => a + c.stdev, 0) / 3
  const cw = 80
  const cx = pz.x + Math.max(0, Math.floor(pz.w / 2 - cw / 2))
  const cy = pz.y + Math.max(0, Math.floor(pz.h / 2 - cw / 2))
  const centerStat = await sharp(posterBuffer).extract({ left: cx, top: cy, width: cw, height: cw }).png().toBuffer().then((b) => sharp(b).stats())
  const centerStd = centerStat.channels.reduce((a, c) => a + c.stdev, 0) / 3
  if (prodStd < 10 || centerStd < 8) {
    defects.push({ code: 'PRODUCT_MISSING', severity: 'high', note: `商品内容缺失（区域σ=${prodStd.toFixed(1)}, 中心σ=${centerStd.toFixed(1)}）` })
  }

  // CTA 区：要求深色胶囊存在
  const cz = zones.cta
  const ctaStat = await sharp(posterBuffer).extract({ left: cz.x, top: cz.y, width: cz.w, height: cz.h }).png().toBuffer().then((b) => sharp(b).stats())
  const ctaMean = ctaStat.channels.reduce((a, c) => a + c.mean, 0) / 3
  if (ctaMean > 150) defects.push({ code: 'CTA_MISSING', severity: 'medium', note: 'CTA 区域未见深色胶囊' })

  const score = Math.max(60, 100 - defects.length * 15)
  const pass = score >= 85 && !defects.some((d) => d.severity === 'high')
  return {
    pass,
    score,
    defects,
    repairPlan: defects.length ? planFromDefects(defects) : { stage: null, action: null },
    source: 'mock-heuristic',
  }
}

export function planFromDefects(defects) {
  for (const d of defects) {
    switch (d.code) {
      case 'RESOLUTION_MISMATCH':
        return { stage: 'compose', action: '按 720×1440 重排画布重新合成' }
      case 'LOW_CONTRAST_HEADLINE':
        return { stage: 'compose', action: '加深底部 scrim 并加粗标题白描边后重新合成' }
      case 'PRODUCT_MISSING':
        return { stage: 'compose', action: '放大商品区并增强辉光垫底后重新合成' }
      case 'CTA_MISSING':
        return { stage: 'compose', action: '提高 CTA 胶囊不透明度重新合成' }
      case 'BG_MISMATCH':
      case 'STYLE_DRIFT':
        return { stage: 'bg', action: '收紧风格关键词重新生成背景' }
      case 'COPY_OVERFLOW':
        return { stage: 'copy', action: '缩短主标题后重新生成文案' }
    }
  }
  return { stage: 'compose', action: '整体重新合成' }
}

/** 裁判入口（log.taskId: queue job id） */
export async function judgePoster({ posterBuffer, layout, copy, log = {} }) {
  const cfg = effective()
  if (cfg.mock || !cfg.apiKey) return mockJudge(posterBuffer, layout)

  const imageBase64 = posterBuffer.toString('base64')
  const skills = enabledSkillsText('qc')
  const text = [
    '检查这张京东双11投流海报。',
    `文案内容：标题「${String(copy.headline).replace(/\n/g, ' / ')}」，到手价 ¥${copy.price}，CTA「${copy.cta}」，促销「${copy.promo}」。`,
    `版式规范 JSON：${JSON.stringify({ canvas: layout.canvas, zones: layout.zones })}`,
    skills ? `附加技能/规范（必须遵守）：\n${skills}` : null,
    '请按系统清单逐项检查并输出 JSON verdict。',
  ].filter(Boolean).join('\n')

  try {
    const raw = await askVision({
      system: QC_SYSTEM_PROMPT, text, imageBase64, maxTokens: 4096,
      log: { biz: 'l3qc', taskId: log.taskId, stage: 'qc-judge', skillIds: enabledSkillIds('qc'), skillChars: skills.length },
    })
    const verdict = parseJsonLoose(raw)
    if (!verdict || typeof verdict.pass !== 'boolean') {
      return { pass: false, score: 0, defects: [{ code: 'JUDGE_PARSE_ERROR', severity: 'medium', note: raw.slice(0, 120) }], repairPlan: { stage: null, action: null }, source: 'pi-vision(解析失败)' }
    }
    for (const d of verdict.defects || []) d.code = d.code || 'UNKNOWN'
    if (!verdict.repairPlan) verdict.repairPlan = planFromDefects(verdict.defects || [])
    verdict.source = 'pi-vision'
    return verdict
  } catch (e) {
    return { pass: false, score: 0, defects: [{ code: 'JUDGE_ERROR', severity: 'medium', note: e.message.slice(0, 120) }], repairPlan: { stage: null, action: null }, source: 'pi-vision(调用失败)' }
  }
}

export { DEFECT_CODES }
