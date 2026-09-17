import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, ASSETS_DIR } from './config.js'

/**
 * 三层素材资产模型
 *  L1 基础素材（用户上传）：pattern 花纹 / arttext 艺术字字效 / plate 背景底版图
 *  L2 合成素材（用户上传/输入）：bg 合成背景图 / product 商品 / model_image 模特图 / model_video 模特视频
 *  L3 最终素材：outputs 里的 L3 海报（可"收藏入库"复用）
 * 旧版注册表（type: product|model）自动迁移为 L2。
 */

const REGISTRY_FILE = path.join(DATA_DIR, 'assets.json')

export const LEVELS = {
  1: [
    { kind: 'pattern', label: '花纹', accept: 'image/*', dir: 'l1-pattern' },
    { kind: 'arttext', label: '艺术字字效', accept: 'image/*', dir: 'l1-arttext' },
    { kind: 'plate', label: '背景底版图', accept: 'image/*', dir: 'l1-plate' },
  ],
  2: [
    { kind: 'bg', label: '合成背景图', accept: 'image/*', dir: 'l2-bg' },
    { kind: 'product', label: '商品', accept: 'image/*', dir: 'l2-product' },
    { kind: 'model_image', label: '模特图', accept: 'image/*', dir: 'l2-model' },
    { kind: 'model_video', label: '模特视频', accept: 'video/*', dir: 'l2-model' },
  ],
}

function loadRegistry() {
  try {
    const list = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'))
    // 旧版迁移：type:product/model → level 2
    return list.map((x) => {
      if (!x.level) {
        x.level = 2
        x.kind = x.type === 'model' ? 'model_image' : 'product'
      }
      return x
    })
  } catch {
    return []
  }
}

function saveRegistry(list) {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(list, null, 2))
}

export function listAssets(filter = {}) {
  let out = loadRegistry().sort((a, b) => b.createdAt - a.createdAt)
  if (filter.level) out = out.filter((x) => String(x.level) === String(filter.level))
  if (filter.kind) out = out.filter((x) => x.kind === filter.kind)
  return out
}

export function getAsset(id) {
  return loadRegistry().find((x) => x.id === id)
}

export function assetFilePath(id) {
  const item = getAsset(id)
  if (!item?.file) return null
  return path.join(DATA_DIR, item.file.replace('/files/', ''))
}

export function addAsset(item) {
  const reg = loadRegistry()
  // 按 id upsert：重复生成占位素材不产生重复条目
  const idx = item.id ? reg.findIndex((x) => x.id === item.id) : -1
  if (idx >= 0) reg[idx] = { ...reg[idx], ...item }
  else reg.push(item)
  saveRegistry(reg)
  return item
}

export function removeAsset(id) {
  const item = getAsset(id)
  if (item?.file) {
    const p = path.join(DATA_DIR, item.file.replace('/files/', ''))
    try {
      fs.unlinkSync(p)
    } catch {}
  }
  saveRegistry(loadRegistry().filter((x) => x.id !== id))
}

export function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

export function dirForKind(kind) {
  for (const list of Object.values(LEVELS)) {
    const found = list.find((x) => x.kind === kind)
    if (found) return found.dir
  }
  return 'misc'
}

/** 兼容旧接口：按 id 取商品图/模特图文件路径 */
export function assetPath(type, id) {
  const item = getAsset(id)
  if (item?.file) return path.join(DATA_DIR, item.file.replace('/files/', ''))
  return path.join(ASSETS_DIR, type, `${path.basename(id)}.png`)
}
