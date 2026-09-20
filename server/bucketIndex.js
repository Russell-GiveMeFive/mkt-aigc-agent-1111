import { listAssets, getAsset, upsertAsset, removeAssets } from './db.js'
import * as storage from './storage.js'

/**
 * 素材库索引（SQLite 持久化，见 db.js）
 * 列表接口以此为准 —— 读取零 OSS 请求；桶内容通过 syncBucketIndex 对账补录
 * 写入方：routesV2（L1/L2 上传与合成）、queue（L3 海报 / L4 视频落桶时登记）
 */

const L1_PREFIX_CATEGORY = {
  plate_: 'plate', pattern_: 'pattern', arttext_: 'arttext', product_: 'product',
  model_: 'model', watermark_: 'watermark', labelstyle_: 'labelstyle',
}
function guessCategory(fileId) {
  for (const [p, c] of Object.entries(L1_PREFIX_CATEGORY)) {
    if (fileId.startsWith(p)) return c
  }
  return null
}

/**
 * 桶内容对账：全量列举一次（OSS 自动循环翻页），
 * 把索引之外的对象补录进 SQLite（l1 按 fileId 前缀推断 category），HTML 存档跳过
 */
export async function syncBucketIndex(bucket) {
  const objects = await storage.list(bucket)
  const known = new Set(loadMeta(bucket).map((x) => x.fileId))
  let added = 0
  for (const o of objects) {
    if (String(o.fileId).endsWith('.html')) continue
    if (String(o.fileId).includes('.trim.')) continue // 处理中间产物，不是素材
    if (known.has(o.fileId)) continue
    upsertIndex(bucket, {
      fileId: o.fileId,
      url: o.url,
      name: o.fileId,
      category: bucket === 'l1' ? guessCategory(o.fileId) : null,
      size: o.size,
      createdAt: o.lastModified || Date.now(),
    })
    added++
  }
  return { ok: true, objects: objects.length, added }
}

/** driver 切到 oss 后的「有就是有」：以对象存储实际列举为准，索引里 OSS 不存在的条目剔除（本地磁盘文件保留，迁回+同步可恢复） */
export async function pruneBucketIndex(bucket) {
  const objects = await (await import('./storage.js')).list(bucket)
  const inOss = new Set(objects.map((o) => o.fileId))
  const rows = loadMeta(bucket)
  const missing = rows.map((r) => r.fileId).filter((fid) => !inOss.has(fid) || String(fid).includes('.trim.'))
  // 名字/自定义 meta 备份后再剔——切存储永不丢用户填的名称
  if (missing.length) {
    try {
      const fs = (await import('node:fs')).default
      const path = (await import('node:path')).default
      const DATA = (await import('./config.js')).DATA_DIR
      const bf = path.join(DATA, 'index-meta-backup.json')
      const bak = fs.existsSync(bf) ? JSON.parse(fs.readFileSync(bf, 'utf8')) : {}
      const bmap = bak[bucket] = bak[bucket] || {}
      for (const r of rows) if (missing.includes(r.fileId)) bmap[r.fileId] = { ...r, prunedAt: Date.now() }
      fs.mkdirSync(DATA, { recursive: true })
      fs.writeFileSync(bf, JSON.stringify(bak, null, 2))
    } catch {}
  }
  if (missing.length) removeIndex(bucket, missing)
  return { ok: true, kept: rows.length - missing.length, pruned: missing.length, missing }
}

export function loadMeta(bucket) {
  return listAssets(bucket)
}

export function getIndex(bucket, fileId) {
  return getAsset(bucket, fileId)
}

/** 按 fileId upsert 一条索引 */
export function upsertIndex(bucket, entry) {
  return upsertAsset(bucket, entry)
}

export function removeIndex(bucket, fileIds) {
  removeAssets(bucket, fileIds)
}

/**
 * 分页切分（列表接口统一出参）
 * q: { page, pageSize }；返回 { items, page, pageSize, total, pages, hasMore }
 */
export function paginate(items, q = {}) {
  const pageSize = Math.min(Math.max(parseInt(q.pageSize) || 24, 1), 200)
  const total = items.length
  const pages = Math.max(Math.ceil(total / pageSize), 1)
  const page = Math.min(Math.max(parseInt(q.page) || 1, 1), pages)
  return { items: items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total, pages, hasMore: page < pages }
}
