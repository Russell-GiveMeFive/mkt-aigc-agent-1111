import { ask, parseJsonLoose } from './agent/driver.js'
import { COPY_SYSTEM } from './agent/prompts.js'
import { enabledSkillsText, enabledSkillIds } from './skills.js'
import { effective } from './config.js'

/**
 * 文案生成：走 pi Agent 层（ask → pi-ai 主路 / minimax 直连兜底），M3 产出结构化 JSON
 * 注入 copy scope 技能；无 Key / 失败时回退 mock 文案
 * copy = { headline, sub, price, oldPrice, cta, promo, videoPrompt }
 */

function mockCopy({ productName, promo, price, styleName, shorten }) {
  const name = (productName || '精选好物').replace(/^prod-|^model-/, '').slice(0, 8) || '精选好物'
  const promoText = promo || '双11抢先购'
  const line2 = shorten ? `${name} 好价` : `${name} 心动好价`
  return {
    headline: `${promoText.slice(0, 6)}\n${line2}`,
    productName: name,
    sub: `${styleName}限定礼遇`,
    price: price || '¥299',
    oldPrice: price ? String(Math.round(parseFloat(String(price).replace(/[^0-9.]/g, '')) * 1.5) || 499) : '499',
    cta: '立即抢购',
    promo: `${promoText} 立减进行中`.slice(0, 12),
    videoPrompt:
      '画面中心的商品向镜头方向缓缓递出靠近并轻微旋转，模特与背景轻微视差跟随，顶部门头带、节日行与大字标题保持完全静止，整体氛围光缓慢流动',
    source: 'mock',
  }
}

function buildUserText({ productName, category, sellingPoints, promo, price, styleName, shorten }) {
  const skills = enabledSkillsText('copy')
  return [
    `商品: ${productName}`,
    `类目: ${category || '美妆个护'}`,
    `卖点: ${(sellingPoints || []).join('、') || '品质好货'}`,
    `活动: ${promo || '双11大促'}`,
    `到手价: ${price || '¥299'}`,
    `背景风格: ${styleName}`,
    shorten ? '要求：缩短主标题（headline 第一行 ≤8 字，保留核心卖点/情绪）。' : null,
    skills ? `附加技能/规范（必须遵守）：\n${skills}` : null,
  ].filter(Boolean).join('\n')
}

export async function generateCopy(input) {
  const { mock } = effective()
  if (mock) return mockCopy(input)
  try {
    const text = await ask({
      system: COPY_SYSTEM,
      text: buildUserText(input),
      maxTokens: 800,
      thinking: 'disabled',
      log: { biz: 'l3copy', taskId: input.taskId, stage: 'copy', skillIds: enabledSkillIds('copy'), skillChars: (enabledSkillsText('copy') || '').length },
    })
    const parsed = parseJsonLoose(text)
    if (!parsed || !parsed.headline) throw new Error('文案 JSON 解析失败')
    return { ...parsed, source: 'pi-agent' }
  } catch (e) {
    const fallback = mockCopy(input)
    fallback.source = `mock(${e.message.slice(0, 60)})`
    return fallback
  }
}
