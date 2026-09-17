/**
 * 背景风格库 —— 每个风格 = image-01 prompt 模板 + mock 渲染参数
 * 风格 1 严格对齐参考图 01.jpg / 02.mp4 的程序化分析结论：
 * 紫罗兰 #4130a1 → 淡薰衣草 #d8cde8 渐变、氛围辉光、顶部安静、下部流动光带
 */
export const STYLES = [
  {
    id: 'violet-dream',
    name: '紫曜梦境',
    desc: '对齐参考素材：紫色氛围光、流动光带、梦幻大促（参考视频同款紫调）',
    ref: '01.jpg / 02.mp4',
    prompt:
      'Vertical e-commerce festival scene background, 720x1440, dreamy violet and soft pink atmosphere, deep royal purple accents fading into soft lavender and rosy tones, elegant boutique interior feeling, soft bokeh glow orbs, premium campaign lighting, clean upper-mid area reserved for a model, no text, no people, no product, cinematic soft focus, 8k',
    layoutStyle: {
      accent: '#6a3aa8',
      headlineColor: '#6a3aa8',
      badgeBg1: '#ff8fae',
      badgeBg2: '#ff5b8a',
    },
    mock: {
      top: '#2a2160', mid: '#4130a1', bottom: '#d8cde8',
      glow: ['#a897d1', '#7c6fd9', '#e6ddff'], ribbon: '#8a7be0',
    },
  },
  {
    id: 'red-gold',
    name: '红金大促',
    desc: '双11经典红金，热烈促销氛围',
    prompt:
      'Vertical e-commerce Double-11 festival scene background, deep crimson red gradient with golden light rays, floating golden particles and silk ribbon bokeh, luxury shopping festival atmosphere, clean center area, no text, no people, no product, cinematic, 8k',
    layoutStyle: {
      accent: '#d3281c',
      headlineColor: '#c81623',
      badgeBg1: '#ffb45c',
      badgeBg2: '#ff9d3c',
    },
    mock: {
      top: '#5a0d14', mid: '#a1192b', bottom: '#ff5b4a',
      glow: ['#ffd27a', '#ff9d5c', '#ffe9b8'], ribbon: '#ffb45c',
    },
  },
  {
    id: 'snow-cool',
    name: '雪境清冷',
    desc: '冬季清冷蓝白，高级感美妆护肤',
    prompt:
      'Vertical winter e-commerce scene background, icy blue-white gradient, frosted silk texture, gentle snow bokeh, cool premium skincare aesthetic, clean center, no text, no people, no product, soft studio light, 8k',
    layoutStyle: {
      accent: '#2b5f9e',
      headlineColor: '#2b5f9e',
      badgeBg1: '#7fb3e8',
      badgeBg2: '#5b8fd9',
    },
    mock: {
      top: '#1d3a66', mid: '#3f6ea8', bottom: '#dbeeff',
      glow: ['#ffffff', '#bcd9ff', '#e8f4ff'], ribbon: '#9cc3f0',
    },
  },
  {
    id: 'warm-silk',
    name: '暖光丝绒',
    desc: '香槟金暖光丝绒，轻奢品质向',
    prompt:
      'Vertical luxury e-commerce scene background, champagne gold and warm ivory silk drapery, soft glowing haze, elegant premium beauty campaign, clean center, no text, no people, no product, cinematic soft light, 8k',
    layoutStyle: {
      accent: '#a5722a',
      headlineColor: '#8f5f1e',
      badgeBg1: '#e3b877',
      badgeBg2: '#d19a4a',
    },
    mock: {
      top: '#4a3418', mid: '#9c7434', bottom: '#f5e3c2',
      glow: ['#ffe9b0', '#ffd68a', '#fff6df'], ribbon: '#e3b877',
    },
  },
]

export function getStyle(id) {
  return STYLES.find((s) => s.id === id) || STYLES[0]
}
