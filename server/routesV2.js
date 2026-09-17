import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import * as storage from './storage.js'
import { composeHtml, composeTemplateHtml } from './llmCompose.js'
import { screenshotHtml, screenshotHtmlSafe, inlineImages, hasBrowser, fallbackBackground } from './renderer.js'
import { createJob, createJobBatch, createVideoJob, getTask, listTasks, flatSafeVideo } from './queue.js'
import { getSettings, updateSettings, publicSettings, effective, DATA_DIR } from './config.js'
import { L2_TEMPLATES } from './agent/prompts.js'
import { queryLogs, logEvent, newTrace } from './agentlog.js'

/** multipart 文件名智能修复：
 * busboy 对裸 UTF-8 文件名按 latin1 解码 → 中文乱码；undici(filename*=utf-8'') 则已正确解码。
 * 判据：仅当名字含 latin1 高位字符(\u0080-\u00ff)时尝试 latin1→utf8 还原，
 * 且还原结果必须不含控制字符/\uFFFD（正确解码的中文名被二次转换时必产生控制字符，以此拦截）。
 * 「·」(U+00B7) 等同区真实字符在 roundtrip 中码位不变，不受影响。 */
export function fixFileName(name) {
  if (!name || !/[\u0080-\u00ff]/.test(name)) return name
  let restored
  try { restored = Buffer.from(name, 'latin1').toString('utf8') } catch { return name }
  if (restored === name) return name
  if (/[\u0000-\u001f\u007f\ufffd]/.test(restored)) return name // 还原结果劣化 → 保持原值
  return restored
}
import { listSkills, addSkill, removeSkill, setSkillEnabled, setSkillScope, getSkillContent, skillPath } from './skills.js'
import { DEFAULT_BUCKETS_META } from './bucketsMeta.js'
import { loadMeta, getIndex, upsertIndex, removeIndex, paginate, syncBucketIndex } from './bucketIndex.js'

/**
 * /v2 —— 三层素材模型开放接口（全部支持批量衍生）
 *   L1 基础素材     上传(category)/列表/删除(+批量)
 *   L2 平台合成素材 自然语言合成背景(LLM→HTML→截图) / 生产管线标记 / 删除(+批量)
 *   L3 商家最终海报 管线生成 / 再加工(换商品图) / 列表 / 删除(+批量)
 *   L4 视频合成     海报→5s视频 / 列表 / 删除(+批量)
 *   设置            四桶独立存储配置
 *   技能            上传给 pi Agent 调用
 */

// defParamCharset: 'utf8' —— busboy 默认按 latin1 解码 multipart 文件名，中文文件名会乱码；
// 显式 utf8 后浏览器(raw UTF-8)/undici(filename*=utf-8'')/python 三类客户端全部正确
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 }, defParamCharset: 'utf8' })

export const L1_CATEGORIES = [
  { key: 'plate', label: '底版图', accept: 'image/*' },
  { key: 'pattern', label: '花纹', accept: 'image/*' },
  { key: 'arttext', label: '艺术字字体样式', accept: 'image/*' },
  { key: 'product', label: '商品图', accept: 'image/*' },
  { key: 'model', label: '模特图', accept: 'image/*,video/mp4' },
  { key: 'watermark', label: '水印', accept: 'image/*' },
  { key: 'labelstyle', label: '标签样式', accept: 'image/*' },
]

/* ---------- 桶元数据（列表零 OSS 请求；对账走 /v2/buckets/:bucket/sync） ---------- */
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
/** 元数据驱动列表：按创建时间倒序，过滤，排除 HTML 存档 */
function metaList(bucket, { category, pipeline } = {}) {
  let items = loadMeta(bucket).filter((m) => !(bucket === 'l2' && String(m.fileId).endsWith('.html')))
  if (category) items = items.filter((x) => x.category === category)
  if (pipeline != null && pipeline !== '') items = items.filter((x) => x.pipeline === (pipeline === '1' || pipeline === 'true'))
  return items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}
async function deleteFromBucket(bucket, fileIds) {
  const out = []
  for (const fileId of fileIds) {
    const indexed = !!getIndex(bucket, fileId)
    const exists = await storage.exists(bucket, fileId)
    if (!indexed && !exists) {
      // 索引与文件都没有才是真 404
      out.push({ fileId, deleted: false, error: '资源不存在' })
      continue
    }
    if (exists) await storage.remove(bucket, fileId)
    // 文件已不在但索引残留（孤儿）→ 允许通过删除接口清理索引
    removeIndex(bucket, [fileId])
    out.push({ fileId, deleted: true, orphan: indexed && !exists })
  }
  return out
}

function auth() {
  // 每次请求读取最新 keys：设置页改 apiKeys 立即生效（无需重启）
  return (req, res, next) => {
    const keys = getSettings().apiKeys || []
    if (!keys.length) return next()
    const key = req.header('X-API-Key')
    if (!key || !keys.includes(key)) return res.status(401).json({ error: '无效 X-API-Key' })
    next()
  }
}

export function buildV2Router() {
  const r = express.Router()
  r.use(auth())
  // API 一律禁缓存：删除/新增后前端刷新必须拿到最新数据（浏览器启发式缓存曾导致"删不掉"假象）
  r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })

  /* ---------- 通用：文件代理 ---------- */
  r.get('/files/:bucket/:fileId', async (req, res) => {
    const { bucket, fileId } = req.params
    if (!storage.BUCKETS.includes(bucket)) return res.status(400).json({ error: '桶名不合法' })
    const buf = await storage.get(bucket, fileId)
    if (!buf) return res.status(404).json({ error: '资源不存在' })
    res.setHeader('Content-Type', storage.contentTypeOf(fileId))
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.send(buf)
  })

  r.get('/meta', (_req, res) => {
    res.json({
      buckets: storage.BUCKETS,
      l1Categories: L1_CATEGORIES,
      renderer: hasBrowser() ? 'html-screenshot' : 'sharp-fallback',
      mock: effective().mock,
    })
  })

  /* ================= L1 基础素材 ================= */
  // 上传（多文件 = 批量），category: plate|pattern|arttext|product|model|watermark|labelstyle
  r.post('/l1/assets', upload.array('files', 30), async (req, res) => {
    const files = req.files || []
    if (!files.length) return res.status(400).json({ error: '缺少 files[]' })
    const category = req.body.category
    if (!L1_CATEGORIES.some((c) => c.key === category)) {
      return res.status(400).json({ error: `category 必须是: ${L1_CATEGORIES.map((c) => c.key).join('/')}` })
    }
    let names = []
    try {
      names = req.body.names ? JSON.parse(req.body.names) : []
    } catch {}
    const out = []
    for (const [i, f] of files.entries()) {
      const isVideo = category === 'model' && /^video\//.test(f.mimetype)
      const origName = fixFileName(f.originalname)
      if (!isVideo && !/^image\//.test(f.mimetype)) {
        out.push({ error: `文件 ${origName} 不是图片${category === 'model' ? '或 mp4 视频' : ''}` })
        continue
      }
      const ext = isVideo ? 'mp4' : (origName.match(/\.(png|jpe?g|webp|svg)$/i)?.[1] || 'png').toLowerCase()
      const fileId = storage.newFileId(category)
      const saved = await storage.put('l1', `${fileId}.${ext}`, f.buffer, isVideo ? 'video/mp4' : f.mimetype || 'image/png')
      const entry = upsertIndex('l1', {
        fileId: saved.fileId,
        url: saved.url,
        category,
        name: fixFileName(names[i]) || origName.replace(/\.[^.]+$/, ''),
        size: f.size,
        createdAt: Date.now(),
      })
      out.push(entry)
    }
    res.status(201).json({ items: out, total: out.length })
  })

  r.get('/l1/assets', async (req, res) => {
    res.json(paginate(metaList('l1', { category: req.query.category }), req.query))
  })

  r.delete('/l1/assets/:fileId', async (req, res) => {
    const items = await deleteFromBucket('l1', [req.params.fileId])
    if (!items[0].deleted) return res.status(404).json({ error: items[0].error || '资源不存在' })
    res.json({ items })
  })

  // 批量删除
  r.post('/l1/assets/delete', async (req, res) => {
    const { fileIds = [] } = req.body || {}
    if (!fileIds.length) return res.status(400).json({ error: 'fileIds 必填' })
    res.json({ items: await deleteFromBucket('l1', fileIds) })
  })

  /* ================= L2 平台合成素材 ================= */
  // 背景合成：选 L1 基础素材 + 自然语言 → LLM 生成 HTML → 截图 → 存 L2 桶
  async function composeBgOne({ itemIds = [], instruction = '', name, mode }) {
    const traceId = newTrace() // 本次合成一个 trace：解析→LLM 各轮→渲染→入库 同组
    if (!itemIds.length) throw new Error('itemIds 必填（选择 L1 基础素材）')
    const items = []
    for (const fileId of itemIds) {
      const buf = await storage.get('l1', fileId)
      if (!buf) throw new Error(`L1 素材不存在: ${fileId}`)
      const m = getIndex('l1', fileId) || {}
      items.push({ fileId, url: `/v2/files/l1/${fileId}`, category: m.category || 'plate', name: m.name })
    }
    const comp = mode === 'template'
      ? await composeTemplateHtml({ items, instruction, log: { taskId: name || `compose_${Date.now().toString(36)}`, traceId } })
      : await composeHtml({ items, instruction, log: { taskId: name || `compose_${Date.now().toString(36)}`, traceId } })
    const { html, width, height, plateForced, plateFileId, strippedCount, textLayer, source } = comp
    if (plateForced) logEvent({ biz: 'l2compose', traceId, stage: 'plate-forced', status: 'warn', note: `LLM 忽略了底版图，已系统强制垫底: ${plateFileId}` })
    if (strippedCount) logEvent({ biz: 'l2compose', traceId, stage: 'text-sanitized', status: 'warn', note: `清洗 LLM 违规文字节点 × ${strippedCount}（文字由系统代码渲染）` })
    if (textLayer) logEvent({ biz: 'l2compose', traceId, stage: 'text-layer', status: 'ok', note: '系统文字层已注入（门头/主标/卖点/价格）' })
    const fullHtml = html.includes('<!DOCTYPE') ? html : `<!DOCTYPE html><html><head><meta charset="utf-8"></head>${html}</html>`
    const withData = await inlineImages(fullHtml)
    let png
    let renderer = source
    if (hasBrowser()) {
      png = await screenshotHtmlSafe(withData, { width: comp.width || 720, height: comp.height || 1440 })
      renderer += png ? '+screenshot' : '+fallback'
    }
    if (!png) {
      png = await fallbackBackground()
      renderer = (renderer ? renderer + '+' : '') + 'fallback'
    }
    const fileId = storage.newFileId('l2bg')
    const saved = await storage.put('l2', `${fileId}.png`, png, 'image/png')
    // html 存档（便于微调重生成）
    await storage.put('l2', `${fileId}.html`, Buffer.from(withData, 'utf8'), 'text/html; charset=utf-8')
    const entry = upsertIndex('l2', {
      fileId: saved.fileId,
      url: saved.url,
      name: name || `合成背景 ${new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
      instruction,
      htmlFileId: `${fileId}.html`,
      source: renderer,
      pipeline: false,
      createdAt: Date.now(),
    })
    return { ...entry, html: fullHtml }
  }

  r.post('/l2/compose-bg', async (req, res) => {
    try {
      res.status(201).json(await composeBgOne(req.body || {}))
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  // 批量衍生：多组合成
  r.post('/l2/compose-bg/batch', async (req, res) => {
    const { jobs = [] } = req.body || {}
    if (!jobs.length) return res.status(400).json({ error: 'jobs 必填' })
    const results = []
    for (const job of jobs) {
      try {
        results.push(await composeBgOne(job))
      } catch (e) {
        results.push({ error: e.message })
      }
    }
    res.status(201).json({ items: results, total: results.length })
  })

  // 加入 / 退出生产管线（批量）
  r.post('/l2/pipeline', async (req, res) => {
    const { fileIds = [], enabled = true } = req.body || {}
    if (!fileIds.length) return res.status(400).json({ error: 'fileIds 必填' })
    const items = []
    for (const fileId of fileIds) {
      const m = getIndex('l2', fileId)
      if (!m) {
        items.push({ fileId, error: '不存在' })
        continue
      }
      items.push(upsertIndex('l2', { ...m, pipeline: !!enabled, pipelineAt: enabled ? Date.now() : null }))
    }
    res.json({ items })
  })

  r.get('/l2/assets', async (req, res) => {
    res.json(paginate(metaList('l2', { pipeline: req.query.pipeline }), req.query))
  })
  r.delete('/l2/assets/:fileId', async (req, res) => {
    const items = await deleteFromBucket('l2', [req.params.fileId])
    if (!items[0].deleted) return res.status(404).json({ error: items[0].error || '资源不存在' })
    res.json({ items })
  })
  r.post('/l2/assets/delete', async (req, res) => {
    const { fileIds = [] } = req.body || {}
    if (!fileIds.length) return res.status(400).json({ error: 'fileIds 必填' })
    res.json({ items: await deleteFromBucket('l2', fileIds) })
  })

  /* ================= L3 商家最终营销海报 ================= */
  // 生成：L2 管线背景 + L1 商品/模特 + 文案槽位 → 管线(合成+QC+修复) → L3 桶
  // 直通：L2 背景不经合成/QC，直接作为 L3 最终海报（不选商品/模特时用）
  r.post('/l3/direct', async (req, res) => {
    const { bgFileId, name } = req.body || {}
    if (!bgFileId) return res.status(400).json({ error: 'bgFileId 必填（L2 生产管线素材）' })
    const bgMeta = getIndex('l2', bgFileId)
    if (!bgMeta?.pipeline) return res.status(400).json({ error: '该 L2 素材未加入生产管线' })
    try {
      const buf = await storage.get('l2', bgFileId)
      const put = await storage.put('l3', `${storage.newFileId('l3')}.png`, buf, 'image/png')
      upsertIndex('l3', { fileId: put.fileId, url: put.url, name: name || bgMeta?.name || 'L3 海报（直通）', createdAt: Date.now(), source: 'direct' })
      logEvent({ biz: 'l3direct', stage: 'direct-save', status: 'ok', note: `${bgFileId} → ${put.fileId}（跳过合成/QC）` })
      res.json({ fileId: put.fileId, url: put.url })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  r.post('/l3/generate', async (req, res) => {
    const { bgFileId, productFileId, modelFileId, modelVideoFileId, copySlots, copyId, generateVideo = false, name } = req.body || {}
    if (!bgFileId) return res.status(400).json({ error: 'bgFileId 必填（L2 生产管线素材）' })
    const bgMeta = getIndex('l2', bgFileId)
    if (!bgMeta?.pipeline) return res.status(400).json({ error: '该 L2 素材未加入生产管线（先调 /v2/l2/pipeline）' })
    // productFileId 可选：不选 = 仅用 L2 背景重新排版合成（composePoster 支持 product=null）
    const task = createJob({
      bgFileId,
      productFileId,
      modelFileId,
      modelVideoFileId,
      copySlots,
      copyId,
      generateVideo,
      meta: { name: name || bgMeta?.name || 'L3 海报', source: 'v2' },
    })
    res.status(202).json({ jobId: task.id, status: task.status, poll: `/v2/l3/jobs/${task.id}` })
  })

  // 批量衍生
  r.post('/l3/generate/batch', async (req, res) => {
    const { items = [] } = req.body || {}
    if (!items.length) return res.status(400).json({ error: 'items 必填' })
    const jobs = createJobBatch(items)
    res.status(202).json({ items: jobs.map((t) => ({ jobId: t.id, poll: `/v2/l3/jobs/${t.id}` })), total: jobs.length })
  })

  // 再加工：对未走生产管线的成果换商品图重新合成
  r.post('/l3/rework', async (req, res) => {
    const { l3FileId, productFileId, generateVideo = false } = req.body || {}
    if (!l3FileId || !productFileId) return res.status(400).json({ error: 'l3FileId 与 productFileId 必填' })
    const origin = listTasks({ kind: 'pipeline' }).find((t) => t.results?.l3FileId === l3FileId)
    if (!origin) return res.status(400).json({ error: '该海报非本系统生成（无原始任务，无法再加工）' })
    const task = createJob({
      bgFileId: origin.v2?.bgFileId,
      productFileId, // 换商品
      modelFileId: origin.v2?.modelFileId,
      modelVideoFileId: origin.v2?.modelVideoFileId,
      copySlots: origin.results?.copy || undefined,
      generateVideo,
      meta: { name: `${origin.meta?.name || 'L3'} 再加工`, source: 'v2-rework', reworkOf: origin.id },
    })
    res.status(202).json({ jobId: task.id, status: task.status, poll: `/v2/l3/jobs/${task.id}` })
  })

  r.post('/l3/rework/batch', async (req, res) => {
    const { items = [] } = req.body || {}
    if (!items.length) return res.status(400).json({ error: 'items 必填' })
    const out = []
    for (const it of items) {
      try {
        const origin = listTasks({ kind: 'pipeline' }).find((t) => t.results?.l3FileId === it.l3FileId)
        if (!origin) throw new Error(`无原始任务: ${it.l3FileId}`)
        const task = createJob({
          bgFileId: origin.v2?.bgFileId,
          productFileId: it.productFileId,
          modelFileId: origin.v2?.modelFileId,
          copySlots: origin.results?.copy || undefined,
          generateVideo: !!it.generateVideo,
          meta: { name: `${origin.meta?.name || 'L3'} 再加工`, source: 'v2-rework' },
        })
        out.push({ jobId: task.id, poll: `/v2/l3/jobs/${task.id}` })
      } catch (e) {
        out.push({ error: e.message })
      }
    }
    res.status(202).json({ items: out, total: out.length })
  })

  r.get('/l3/jobs', (req, res) => {
    let list = listTasks({ kind: 'pipeline' })
    if (req.query.status) list = list.filter((t) => t.status === req.query.status)
    res.json(paginate(list.map(jobView), req.query))
  })
  r.get('/l3/jobs/:id', (req, res) => {
    const t = getTask(req.params.id)
    if (!t) return res.status(404).json({ error: '任务不存在' })
    res.json(jobView(t))
  })
  r.get('/l3/assets', async (req, res) => {
    const jobs = listTasks({ kind: 'pipeline' }).filter((t) => t.results?.l3FileId)
    const items = metaList('l3').map((it) => {
      const job = jobs.find((t) => t.results.l3FileId === it.fileId)
      return {
        ...it,
        jobId: job?.id || null,
        usable: job?.results?.usable ?? null,
        qcScore: job?.results?.qcScore ?? null,
        copy: job?.results?.copy ? { headline: job.results.copy.headline, price: job.results.copy.price } : null,
      }
    })
    res.json(paginate(items, req.query))
  })
  r.delete('/l3/assets/:fileId', async (req, res) => {
    const items = await deleteFromBucket('l3', [req.params.fileId])
    if (!items[0].deleted) return res.status(404).json({ error: items[0].error || '资源不存在' })
    res.json({ items })
  })
  r.post('/l3/assets/delete', async (req, res) => {
    const { fileIds = [] } = req.body || {}
    if (!fileIds.length) return res.status(400).json({ error: 'fileIds 必填' })
    res.json({ items: await deleteFromBucket('l3', fileIds) })
  })

  /* ================= L4 视频合成 ================= */
  // 选择 L3 海报 + 提示词 → 5s 视频（modelVideoFileId 可选：H3 Reference 模式）
  // 动效渲染（skill: poster-to-marketing-video flat-safe 模式）：海报 → ffmpeg 动效 MP4，无模特/确定性/秒出
  r.post('/l4/render', async (req, res) => {
    const { l3FileId, duration = 5 } = req.body || {}
    if (!l3FileId) return res.status(400).json({ error: 'l3FileId 必填（L3 海报）' })
    const l3Meta = getIndex('l3', l3FileId)
    if (!l3Meta) return res.status(404).json({ error: 'L3 海报不存在' })
    const t0 = Date.now()
    try {
      const posterBuf = await storage.get('l3', l3FileId)
      const tmp = path.join(DATA_DIR, 'tmp', `flat-${Date.now()}.png`)
      fs.mkdirSync(path.dirname(tmp), { recursive: true })
      fs.writeFileSync(tmp, posterBuf)
      const out = path.join(DATA_DIR, 'tmp', `flat-${Date.now()}.mp4`)
      const dims = await flatSafeVideo(tmp, out, { duration: Math.max(4, Math.min(15, parseInt(duration) || 5)) })
      const buf = fs.readFileSync(out)
      const put = await storage.put('l4', `${storage.newFileId('l4')}.mp4`, buf, 'video/mp4')
      fs.rmSync(tmp, { force: true }); fs.rmSync(out, { force: true })
      upsertIndex('l4', { fileId: put.fileId, url: put.url, name: (l3Meta.name || '海报') + ' · 动效', createdAt: Date.now(), source: 'flat-safe', duration: parseInt(duration) || 5, prompt: 'flat-safe 动效（skill: poster-to-marketing-video）' })
      logEvent({ biz: 'l4video', traceId: put.fileId, stage: 'flat-safe-render', status: 'ok', latencyMs: Date.now() - t0, note: `${l3FileId} → ${put.fileId} ${dims.width}x${dims.height} ${duration}s（保尺寸·中心呼吸·末帧定格）` })
      res.json({ fileId: put.fileId, url: put.url, ...dims })
    } catch (e) {
      logEvent({ biz: 'l4video', traceId: 'flat-' + Date.now().toString(36), stage: 'flat-safe-render', status: 'error', latencyMs: Date.now() - t0, note: String(e.message).slice(0, 200) })
      res.status(500).json({ error: e.message })
    }
  })

  r.post('/l4/generate', async (req, res) => {
    const { l3FileId, prompt = '', modelVideoFileId, videoOpts } = req.body || {}
    if (!l3FileId) return res.status(400).json({ error: 'l3FileId 必填（L3 海报）' })
    const task = createVideoJob({ l3FileId, prompt, modelVideoFileId, videoOpts })
    res.status(202).json({ jobId: task.id, status: task.status, poll: `/v2/l4/jobs/${task.id}` })
  })
  r.post('/l4/generate/batch', async (req, res) => {
    const { items = [] } = req.body || {}
    if (!items.length) return res.status(400).json({ error: 'items 必填' })
    const jobs = items.map((it) => createVideoJob(it))
    res.status(202).json({ items: jobs.map((t) => ({ jobId: t.id, poll: `/v2/l4/jobs/${t.id}` })), total: jobs.length })
  })
  r.get('/l4/jobs', (req, res) => {
    let list = listTasks({ kind: 'video' })
    if (req.query.status) list = list.filter((t) => t.status === req.query.status)
    res.json(paginate(list.map(jobView), req.query))
  })
  r.get('/l4/jobs/:id', (req, res) => {
    const t = getTask(req.params.id)
    if (!t) return res.status(404).json({ error: '任务不存在' })
    res.json(jobView(t))
  })
  r.get('/l4/assets', async (req, res) => {
    const jobs = listTasks({ kind: 'video' }).filter((t) => t.results?.l4FileId)
    const items = metaList('l4').map((it) => {
      const job = jobs.find((t) => t.results.l4FileId === it.fileId)
      return { ...it, jobId: job?.id || null, l3FileId: job?.v2?.l3FileId || null, prompt: job?.options?.copySlots?.videoPrompt || null }
    })
    res.json(paginate(items, req.query))
  })
  r.delete('/l4/assets/:fileId', async (req, res) => {
    const items = await deleteFromBucket('l4', [req.params.fileId])
    if (!items[0].deleted) return res.status(404).json({ error: items[0].error || '资源不存在' })
    res.json({ items })
  })
  r.post('/l4/assets/delete', async (req, res) => {
    const { fileIds = [] } = req.body || {}
    if (!fileIds.length) return res.status(400).json({ error: 'fileIds 必填' })
    res.json({ items: await deleteFromBucket('l4', fileIds) })
  })

  /* ================= 设置（四桶） ================= */
  // 预置提示词模板（L2 场景一键填充）
  r.get('/prompts', (_req, res) => res.json({ templates: L2_TEMPLATES }))

  // 运行日志查询（?taskId=&biz=&status=&limit=）
  r.get('/logs', (req, res) => {
    const { taskId, biz, status, limit } = req.query
    res.json(queryLogs({ taskId, biz, status, limit: limit ? Number(limit) : 200 }))
  })

  // ?reveal=1：GUI「点击显示」用，回传完整 Key（本地管理界面；默认永不回显）
  r.get('/settings', (req, res) => {
    const pub = { ...publicSettings(), buckets: getSettings().buckets }
    if (req.query.reveal === '1') pub.apiKey = getSettings().apiKey || ''
    res.json(pub)
  })
  r.put('/settings', (req, res) => {
    const patch = req.body || {}
    const allow = ['apiKey', 'baseUrl', 'textModel', 'videoModel', 'videoResolution', 'qcModel', 'maxRepairRounds', 'mock', 'concurrency', 'apiKeys', 'buckets']
    const clean = {}
    for (const k of allow) if (k in patch && patch[k] !== undefined) clean[k] = patch[k]
    if (clean.buckets) {
      // 增量合并：只更新提交的桶，未提交的桶保持原配置
      const merged = { ...getSettings().buckets }
      for (const b of storage.BUCKETS) {
        if (clean.buckets[b]) {
          merged[b] = { ...DEFAULT_BUCKETS_META, ...merged[b], ...clean.buckets[b] }
        }
      }
      clean.buckets = merged
    }
    updateSettings(clean)
    res.json({ ...publicSettings(), buckets: getSettings().buckets })
  })
  r.post('/buckets/:bucket/test', async (req, res) => {
    const { bucket } = req.params
    if (!storage.BUCKETS.includes(bucket)) return res.status(400).json({ error: '桶名不合法' })
    try {
      const items = await storage.list(bucket)
      res.json({ ok: true, driver: getSettings().buckets?.[bucket]?.driver || 'local', objects: items.length })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  // 桶内容对账：全量列举一次（OSS 循环翻页），把索引之外的对象补录进素材库
  r.post('/buckets/:bucket/sync', async (req, res) => {
    const { bucket } = req.params
    if (!storage.BUCKETS.includes(bucket)) return res.status(400).json({ error: '桶名不合法' })
    try {
      res.json(await syncBucketIndex(bucket))
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  /* ================= 技能（pi Agent） ================= */
  r.post('/skills', upload.array('files', 20), async (req, res) => {
    const files = req.files || []
    if (!files.length) return res.status(400).json({ error: '缺少 files[]' })
    const items = []
    for (const f of files) {
      const origName = fixFileName(f.originalname)
      if (!/\.(md|txt)$/i.test(origName)) {
        items.push({ error: `${origName} 仅支持 .md / .txt` })
        continue
      }
      const id = storage.newFileId('skill') + '.md'
      fs.mkdirSync(path.join(DATA_DIR, 'skills'), { recursive: true })
      fs.writeFileSync(skillPath(id), f.buffer)
      items.push(addSkill({ id, name: fixFileName(req.body.name) || origName.replace(/\.[^.]+$/, ''), filename: origName, size: f.size, scope: fixFileName(req.body.scope) }))
    }
    res.status(201).json({ items, total: items.length })
  })
  r.get('/skills', (_req, res) => res.json({ items: listSkills() }))
  r.post('/skills/:id/enabled', (req, res) => res.json(setSkillEnabled(req.params.id, !!req.body?.enabled)))
  r.post('/skills/:id/scope', (req, res) => res.json(setSkillScope(req.params.id, req.body?.scope)))
  // 技能文档全文预览
  r.get('/skills/:id/content', (req, res) => {
    const content = getSkillContent(req.params.id)
    if (content === null) return res.status(404).json({ error: '技能文件不存在' })
    res.json({ id: req.params.id, content })
  })
  r.delete('/skills/:id', (req, res) => {
    removeSkill(req.params.id)
    res.json({ ok: true })
  })

  // express 4 不捕获 async 抛错 —— 统一包装所有路由处理器，异常转 next(err)，避免请求挂死
  for (const layer of r.stack) {
    if (!layer.route) continue
    for (const l of layer.route.stack) {
      const h = l.handle
      if (typeof h === 'function' && h.length < 4) {
        l.handle = function (req, res, next) {
          const out = h.apply(this, arguments)
          if (out && typeof out.catch === 'function') out.catch(next)
          return out
        }
      }
    }
  }
  r.use((err, _req, res, _next) => {
    console.error('[v2]', err)
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message || '内部错误' })
  })

  return r
}

function jobView(t) {
  return {
    jobId: t.id,
    kind: t.kind,
    status: t.status,
    stages: t.stages,
    qc: t.qc || [],
    usable: t.results?.usable ?? null,
    qcScore: t.results?.qcScore ?? null,
    l3FileId: t.results?.l3FileId || null,
    l3Url: t.results?.l3Url || null,
    l4FileId: t.results?.l4FileId || null,
    l4Url: t.results?.l4Url || null,
    poster: t.results?.poster || null,
    video: t.results?.video || null,
    videoTaskId: t.results?.videoTaskId || null,
    videoOpts: t.v2?.videoOpts || null,
    copy: t.results?.copy || null,
    name: t.meta?.name || null,
    error: t.error || null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }
}
