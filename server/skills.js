import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.js'

/**
 * 技能库：用户上传的 skill 文档（.md/.txt），运行时注入 pi Agent 上下文
 * 存 data/skills/，元数据 data/skills/meta.json（enabled 开关）
 */

const DIR = path.join(DATA_DIR, 'skills')

function metaFile() {
  return path.join(DIR, 'meta.json')
}

function loadMeta() {
  try {
    return JSON.parse(fs.readFileSync(metaFile(), 'utf8'))
  } catch {
    return []
  }
}

function saveMeta(list) {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(metaFile(), JSON.stringify(list, null, 2))
}

export function listSkills() {
  const meta = loadMeta()
  return meta.sort((a, b) => b.createdAt - a.createdAt)
}

const SCOPES = ['all', 'html', 'copy', 'qc']

/** scope 归一化：'html,copy' / ['html'] / 非法值 → 数组；空 → ['all'] */
export function normalizeScope(scope) {
  const raw = Array.isArray(scope) ? scope : String(scope || 'all').split(',')
  const out = raw.map((x) => String(x).trim().toLowerCase()).filter((x) => SCOPES.includes(x))
  return out.length ? out : ['all']
}

function scopeMatches(entry, scope) {
  const s = entry.scope || ['all']
  if (scope === 'all') return true // 查询 all = 注入全部技能
  return s.includes('all') || s.includes(scope)
}

export function addSkill({ id, name, filename, size, scope }) {
  const list = loadMeta()
  if (!list.some((x) => x.id === id)) {
    list.push({ id, name, filename, size, scope: normalizeScope(scope), enabled: true, createdAt: Date.now() })
    saveMeta(list)
  }
  return list.find((x) => x.id === id)
}

export function removeSkill(id) {
  const f = path.join(DIR, id)
  if (fs.existsSync(f)) fs.unlinkSync(f)
  saveMeta(loadMeta().filter((x) => x.id !== id))
}

export function setSkillEnabled(id, enabled) {
  const list = loadMeta()
  const item = list.find((x) => x.id === id)
  if (item) {
    item.enabled = !!enabled
    saveMeta(list)
  }
  return item
}

export function setSkillScope(id, scope) {
  const list = loadMeta()
  const item = list.find((x) => x.id === id)
  if (item) {
    item.scope = normalizeScope(scope)
    saveMeta(list)
  }
  return item
}

export function skillPath(id) {
  return path.join(DIR, path.basename(id))
}

/** 技能文档全文（预览用） */
export function getSkillContent(id) {
  const f = skillPath(id)
  if (!fs.existsSync(f)) return null
  return fs.readFileSync(f, 'utf8')
}

/** 拼接启用技能的文本（按 scope 路由注入对应 Agent 上下文：html / copy / qc） */
/** 注入文本：按启用顺序装填，总量上限 40000 字符（防止 16 个技能全开把 prompt 撑爆） */
export function enabledSkillsText(scope = 'all') {
  if (!fs.existsSync(DIR)) return ''
  const TOTAL_CAP = 40000
  const parts = []
  let total = 0
  for (const m of loadMeta().filter((x) => x.enabled && scopeMatches(x, scope))) {
    const f = path.join(DIR, m.id)
    if (!fs.existsSync(f)) continue
    const remain = TOTAL_CAP - total
    if (remain <= 500) break
    const chunk = fs.readFileSync(f, 'utf8').slice(0, remain)
    parts.push(`### 技能：${m.name}\n${chunk}`)
    total += chunk.length
  }
  return parts.join('\n\n')
}

/** 供日志记录：本次注入了哪些技能 */
export function enabledSkillIds(scope = 'all') {
  return loadMeta().filter((x) => x.enabled && scopeMatches(x, scope)).map((x) => x.id)
}

/** ===== function-call 模式：技能目录 + 按需读取 ===== */
const SKILL_SUMMARY_CHARS = 160

/** 技能目录：S1/S2… 编号 + 名称 + 简介（md 前 160 字，供模型决定是否加载全文） */
export function skillCatalog(scope = 'all') {
  // 编号固定按创建时间正序：新上传技能不改变已有 S 编号（模型引用的编号必须稳定）
  const items = loadMeta().filter((x) => x.enabled && scopeMatches(x, scope)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
  return items.map((m, i) => {
    const f = path.join(DIR, m.id)
    let desc = ''
    let chars = 0
    try {
      const body = fs.readFileSync(f, 'utf8')
      chars = body.length
      desc = body.replace(/[#*`>\-\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SKILL_SUMMARY_CHARS)
    } catch {}
    return { key: `S${i + 1}`, id: m.id, name: m.name, chars, desc }
  })
}

/** 按 S1/S2 编号读取技能全文（load_skill 工具的后端） */
export function skillTextByKey(key, scope = 'all') {
  const cat = skillCatalog(scope)
  const k = String(key || '').trim()
  const ku = k.toUpperCase()
  const hit =
    cat.find((c) => c.key === ku) ||
    cat.find((c) => c.id === k || c.id.toUpperCase() === ku) ||
    cat.find((c) => c.name.toUpperCase() === ku) ||
    cat.find((c) => ku.length >= 4 && c.name.toUpperCase().includes(ku)) ||
    cat.find((c) => ku.length >= 4 && c.id.toUpperCase().includes(ku))
  if (!hit) return null
  try {
    const fname = hit.id.includes('.') ? hit.id : hit.id + '.md'
    return fs.readFileSync(path.join(DIR, fname), 'utf8')
  } catch {
    return null
  }
}
