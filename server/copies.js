import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, effective } from './config.js'
import { chatText } from './minimax.js'

/**
 * Level2 文案资产：用户输入的替换文案（槽位制）
 * slots: { headline, productName, sub, price, oldPrice, cta, promo }
 * AI 润色仅生成候选，不覆盖用户输入。
 */

const COPIES_FILE = path.join(DATA_DIR, 'copies.json')

function load() {
  try {
    return JSON.parse(fs.readFileSync(COPIES_FILE, 'utf8'))
  } catch {
    return []
  }
}

function save(list) {
  fs.writeFileSync(COPIES_FILE, JSON.stringify(list, null, 2))
}

export function listCopies() {
  return load().sort((a, b) => b.createdAt - a.createdAt)
}

export function getCopy(id) {
  return load().find((x) => x.id === id)
}

export function createCopy({ name, slots = {} }) {
  const item = {
    id: `cpy-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name: name || '未命名文案',
    slots: normalizeSlots(slots),
    createdAt: Date.now(),
  }
  const list = load()
  list.push(item)
  save(list)
  return item
}

export function updateCopy(id, patch) {
  const list = load()
  const item = list.find((x) => x.id === id)
  if (!item) return null
  if (patch.name) item.name = patch.name
  if (patch.slots) item.slots = normalizeSlots({ ...item.slots, ...patch.slots })
  save(list)
  return item
}

export function deleteCopy(id) {
  save(load().filter((x) => x.id !== id))
}

function normalizeSlots(s) {
  const str = (v) => (v == null ? '' : String(v))
  return {
    headline: str(s.headline),
    productName: str(s.productName),
    sub: str(s.sub),
    price: str(s.price),
    oldPrice: str(s.oldPrice),
    cta: str(s.cta || '立即抢购'),
    promo: str(s.promo),
  }
}

const POLISH_SYSTEM = `你是京东双11投流文案优化师。基于给定文案槽位，输出更抓转化的一版。只输出 JSON（不要其他文字）：
{"headline": "≤22字，可用\\n分两行", "sub": "≤16字副标", "cta": "≤6字行动号召", "promo": "≤12字促销标签"}
保持商品名与价格数字不变。`

/** AI 润色：返回润色后的槽位（不落库，作为候选返回） */
export async function polishCopy(id) {
  const item = getCopy(id)
  if (!item) throw new Error('文案不存在')
  const cfg = effective()
  if (cfg.mock || !cfg.apiKey) {
    // MOCK：轻量改写规则
    const s = { ...item.slots }
    if (s.headline && !s.headline.includes('\n')) {
      const cut = Math.min(6, Math.ceil(s.headline.length / 2))
      s.headline = `${s.headline.slice(0, cut)}\n${s.headline.slice(cut)}`
    }
    s.promo = s.promo || '双11狂欢价'
    s.cta = '马上抢>'
    return { slots: s, source: 'mock-polish' }
  }
  const raw = await chatText([
    { role: 'system', content: POLISH_SYSTEM },
    { role: 'user', content: `原文案：${JSON.stringify(item.slots)}` },
  ])
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('润色结果解析失败')
  const polished = JSON.parse(m[0])
  return { slots: normalizeSlots({ ...item.slots, ...polished }), source: 'minimax-m3' }
}
