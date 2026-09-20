import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { DATA_DIR, getSettings } from './config.js'

/**
 * 四桶存储抽象（L1 基础素材 / L2 平台合成素材 / L3 商家最终海报 / L4 视频合成）
 * driver:
 *   local —— data/buckets/<bucket>/ 目录，经 /v2/files/<bucket>/<fileId> 代理访问
 *   oss   —— S3 兼容对象存储（阿里云 OSS / MinIO / AWS S3），经代理流式读取或 publicBaseUri 直链
 * 所有资源都有唯一 fileId；支持 put/get/delete/list。
 */

export const BUCKETS = ['l1', 'l2', 'l3', 'l4']

const localDir = (bucket) => path.join(DATA_DIR, 'buckets', bucket)

function bucketCfg(bucket) {
  const s = getSettings()
  const all = s.buckets || {}
  const cfg = { driver: 'local', ...all[bucket] }
  if (cfg.driver === 'oss') return normalizeOssCfg(cfg) // 所有 oss 读取路径统一走容错归一化
  return cfg
}

export function newFileId(prefix = 'f') {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
}

/** 表单容错：endpoint 自动补协议、bucket 剥离误填的域名后缀、region 从 endpoint 提取 */
export function normalizeOssCfg(cfg) {
  const c = { ...cfg }
  // ① endpoint 必须是完整 URL（SDK 内部 new URL()），裸域名自动补 https://
  if (c.endpoint && !/^https?:\/\//i.test(c.endpoint)) c.endpoint = `https://${c.endpoint}`
  // ② 用户常把「Bucket 域名」整串填进桶名（如 jd-level1.tos-cn-beijing.volces.com）→ 剥离成纯桶名
  if (c.bucket && /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(c.bucket) && /\.(com|net|cn|org|io)$/i.test(c.bucket)) {
    c.bucket = c.bucket.split('.')[0]
  }
  // ③ region 缺省时从 endpoint 提取（如 tos-s3-cn-beijing.volces.com → cn-beijing）
  if (!c.region && c.endpoint) {
    const m = String(c.endpoint).match(/((?:cn|ap|eu|us|sa|af|me)-[a-z]+-?\d*)/i)
    if (m) c.region = m[1]
  }
  return c
}

function s3Client(cfg) {
  const c = normalizeOssCfg(cfg)
  return new S3Client({
    region: c.region || 'oss-cn-beijing',
    endpoint: c.endpoint, // 例如 https://oss-cn-beijing.aliyuncs.com（自动补协议）
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
    forcePathStyle: !!c.forcePathStyle,
  })
}

/** 写入对象 → { fileId, url } */
export async function put(bucket, fileId, buffer, contentType = 'application/octet-stream') {
  const cfg = bucketCfg(bucket)
  if (cfg.driver === 'oss') {
    await s3Client(cfg).send(new PutObjectCommand({ Bucket: cfg.bucket, Key: fileId, Body: buffer, ContentType: contentType }))
    return { fileId, url: publicUrl(bucket, fileId, cfg), driver: 'oss' }
  }
  const dir = localDir(bucket)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, fileId), buffer)
  return { fileId, url: proxyUrl(bucket, fileId), driver: 'local' }
}

/** 读取对象 → Buffer（不存在返回 null） */
export async function get(bucket, fileId) {
  const cfg = bucketCfg(bucket)
  if (cfg.driver === 'oss') {
    try {
      const res = await s3Client(cfg).send(new GetObjectCommand({ Bucket: cfg.bucket, Key: fileId }))
      return Buffer.from(await res.Body.transformToByteArray())
    } catch (e) {
      if (e.name === 'NoSuchKey') return null
      throw e
    }
  }
  const file = path.join(localDir(bucket), path.basename(fileId))
  if (!fs.existsSync(file)) return null
  return fs.readFileSync(file)
}

export async function remove(bucket, fileId) {
  const cfg = bucketCfg(bucket)
  if (cfg.driver === 'oss') {
    await s3Client(cfg).send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: fileId }))
    return
  }
  const file = path.join(localDir(bucket), path.basename(fileId))
  if (fs.existsSync(file)) fs.unlinkSync(file)
}

export async function list(bucket, { prefix } = {}) {
  const cfg = bucketCfg(bucket)
  if (cfg.driver === 'oss') {
    // 全量列举（ListObjectsV2 单页上限 1000，循环翻页取全）
    const out = []
    let token
    do {
      const res = await s3Client(cfg).send(new ListObjectsV2Command({
        Bucket: cfg.bucket,
        ...(prefix ? { Prefix: prefix } : {}),
        ...(token ? { ContinuationToken: token } : {}),
      }))
      for (const o of res.Contents || []) {
        out.push({
          fileId: o.Key,
          url: publicUrl(bucket, o.Key, cfg),
          size: o.Size,
          lastModified: o.LastModified?.getTime?.() || null,
        })
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (token)
    return out
  }
  const dir = localDir(bucket)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => !prefix || f.startsWith(prefix))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f))
      return { fileId: f, url: proxyUrl(bucket, f), size: st.size, lastModified: st.mtimeMs }
    })
}

function proxyUrl(bucket, fileId) {
  return `/v2/files/${bucket}/${fileId}`
}

function publicUrl(bucket, fileId, cfg) {
  return cfg.publicBaseUri ? `${String(cfg.publicBaseUri).replace(/\/$/, '')}/${fileId}` : proxyUrl(bucket, fileId)
}

/** 判断 fileId 是否存在于桶中 */
export async function exists(bucket, fileId) {
  const cfg = bucketCfg(bucket)
  if (cfg.driver !== 'local') return !!(await get(bucket, fileId))
  return fs.existsSync(path.join(localDir(bucket), path.basename(fileId)))
}

export function contentTypeOf(fileId) {
  if (fileId.endsWith('.png')) return 'image/png'
  if (fileId.endsWith('.jpg') || fileId.endsWith('.jpeg')) return 'image/jpeg'
  if (fileId.endsWith('.webp')) return 'image/webp'
  if (fileId.endsWith('.svg')) return 'image/svg+xml'
  if (fileId.endsWith('.mp4')) return 'video/mp4'
  if (fileId.endsWith('.html')) return 'text/html; charset=utf-8'
  if (fileId.endsWith('.md')) return 'text/markdown; charset=utf-8'
  if (fileId.endsWith('.json')) return 'application/json'
  return 'application/octet-stream'
}
