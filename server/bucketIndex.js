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
