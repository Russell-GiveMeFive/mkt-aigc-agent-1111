/**
 * 严格版式规范 v2 —— 对齐 01.jpg 京东官方素材结构（可整体覆盖）
 *
 * 参考结构（720×1440）：
 *   [0-128]    京东红门头带：品牌口号 + 预留吉祥物位
 *   [140-212]  节日 logo 行：活动名 + 档期
 *   [230-440]  大字标题（1-2 行，accent 色，关键字醒目）
 *   [352-500]  价格圆形角标（叠在标题右下，参考图同款）
 *   [470-1130] 模特主视觉（透明底 contain，静区）
 *   [930-1230] 商品图（前置，白色辉光垫底适配白底商品图）
 *   [1246-1300] 商品名白色胶囊
 *   [1324-1392] CTA 胶囊 + 促销标签
 * 底部自动 scrim 渐变保证文字可读。
 */
export const CANVAS = { width: 720, height: 1440 }

export const DEFAULT_LAYOUT = {
  canvas: CANVAS,
  zones: {
    header: { x: 0, y: 0, w: 720, h: 128 },
    mascot: { x: 560, y: 8, w: 130, h: 112, optional: true },
    festival: { x: 0, y: 144, w: 720, h: 72 },
    headline: { x: 40, y: 236, w: 640, h: 200 },
    badge: { x: 534, y: 462, d: 152 },
    model: { x: 80, y: 470, w: 560, h: 660, fit: 'contain' },
    product: { x: 210, y: 930, w: 300, h: 300 },
    productPill: { x: 110, y: 1246, w: 500, h: 54 },
    cta: { x: 44, y: 1324, w: 222, h: 68 },
    promo: { x: 292, y: 1324, w: 384, h: 68 },
  },
  style: {
    // 门头带（京东品牌红，一般不随风格变）
    headerBg1: '#e1251b',
    headerBg2: '#c81623',
    headerColor: '#ffffff',
    headerSlogan: '京东11.11\n又便宜又好',
    // 节日行 / 标题 accent（随风格变）
    festivalText: '京东双11 · 10.14-11.11',
    accent: '#6a3aa8',
    headlineColor: '#6a3aa8',
    // 价格角标
    badgeBg1: '#ff8fae',
    badgeBg2: '#ff5b8a',
    badgeColor: '#ffffff',
    // 商品
    productMode: 'glow', // glow | card | none
    productPillBg: '#ffffff',
    productPillColor: '#3a2d55',
    // 底部
    ctaBg: '#1a1440',
    ctaColor: '#ffe28a',
    promoBg: 'rgba(26,20,64,0.55)',
    promoColor: '#ffffff',
  },
}

export function resolveLayout(override) {
  if (!override) return DEFAULT_LAYOUT
  return {
    ...DEFAULT_LAYOUT,
    ...override,
    zones: { ...DEFAULT_LAYOUT.zones, ...(override.zones || {}) },
    style: { ...DEFAULT_LAYOUT.style, ...(override.style || {}) },
  }
}
