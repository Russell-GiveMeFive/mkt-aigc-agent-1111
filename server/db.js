import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DATA_DIR } from './config.js'

/**
 * 素材库 SQLite 持久化（{DATA_DIR}/assets.db）
 * L1/L2/L3/L4 各层素材统一入库；首次启动自动从旧 buckets-meta/*.json 迁移
 */
const DB_FILE = path.join(DATA_DIR, 'assets.db')
fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new DatabaseSync(DB_FILE)

db.exec(`
  CREATE TABLE IF NOT EXISTS assets (
    fileId    TEXT PRIMARY KEY,
    bucket    TEXT NOT NULL,
    category  TEXT,
    name      TEXT,
    url       TEXT,
    size      INTEGER,
    pipeline  INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    meta      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_assets_bucket_created ON assets(bucket, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_assets_bucket_category ON assets(bucket, category, createdAt DESC);
`)

const qAll = db.prepare('SELECT * FROM assets WHERE bucket = ? ORDER BY createdAt DESC')
const qGet = db.prepare('SELECT * FROM assets WHERE bucket = ? AND fileId = ?')
const qUpsert = db.prepare(`
  INSERT INTO assets (fileId, bucket, category, name, url, size, pipeline, createdAt, meta)
  VALUES (@fileId, @bucket, @category, @name, @url, @size, @pipeline, @createdAt, @meta)
  ON CONFLICT(fileId) DO UPDATE SET
    category = COALESCE(excluded.category, assets.category),
    name = COALESCE(excluded.name, assets.name),
    url = COALESCE(excluded.url, assets.url),
    size = COALESCE(excluded.size, assets.size),
    pipeline = excluded.pipeline,
    createdAt = COALESCE(excluded.createdAt, assets.createdAt),
    meta = COALESCE(excluded.meta, assets.meta)
`)
const qDel = db.prepare('DELETE FROM assets WHERE bucket = ? AND fileId = ?')

/** 行 → 业务对象（与旧 JSON meta 同构） */
function rowToEntry(r) {
  let meta = {}
  try { meta = r.meta ? JSON.parse(r.meta) : {} } catch { /* 损坏行忽略 meta */ }
  return {
    fileId: r.fileId,
    url: r.url || `/v2/files/${r.bucket}/${r.fileId}`,
    category: r.category || null,
    name: r.name || r.fileId,
    pipeline: !!r.pipeline,
    size: r.size ?? null,
    createdAt: r.createdAt,
    ...meta,
  }
}

/** 旧 buckets-meta/*.json 一次性迁移（仅在表空且存在旧文件时） */
function migrateFromJson() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM assets').get().n
  if (count > 0) return
  const dir = path.join(DATA_DIR, 'buckets-meta')
  if (!fs.existsSync(dir)) return
  let migrated = 0
  for (const bucket of ['l1', 'l2', 'l3', 'l4']) {
    const file = path.join(dir, `${bucket}.json`)
    if (!fs.existsSync(file)) continue
    try {
      for (const m of JSON.parse(fs.readFileSync(file, 'utf8'))) {
        qUpsert.run({
          fileId: m.fileId, bucket, category: m.category ?? null, name: m.name ?? null,
          url: m.url ?? null, size: m.size ?? null, pipeline: m.pipeline ? 1 : 0,
          createdAt: m.createdAt ?? Date.now(), meta: JSON.stringify({ ...m, fileId: undefined, bucket: undefined, category: undefined, name: undefined, url: undefined, size: undefined, pipeline: undefined, createdAt: undefined }),
        })
        migrated++
      }
    } catch { /* 单桶损坏跳过 */ }
  }
  if (migrated) console.log(`[db] 已从 buckets-meta 迁移 ${migrated} 条素材索引 → SQLite`)
}

migrateFromJson()

/* ---------- 与原 bucketIndex 同构的接口 ---------- */

export function listAssets(bucket) {
  return qAll.all(bucket).map(rowToEntry)
}

export function getAsset(bucket, fileId) {
  const r = qGet.get(bucket, fileId)
  return r ? rowToEntry(r) : null
}

export function upsertAsset(bucket, entry) {
  const { fileId, category = null, name = null, url = null, size = null, pipeline = false, createdAt = Date.now(), ...rest } = entry
  qUpsert.run({
    fileId, bucket, category, name, url, size, pipeline: pipeline ? 1 : 0,
    createdAt, meta: JSON.stringify(rest),
  })
  return getAsset(bucket, fileId)
}

export function removeAssets(bucket, fileIds) {
  // node:sqlite 无事务助手，逐条删除（隐式单语句事务，量级足够）
  for (const id of fileIds) qDel.run(bucket, id)
}
