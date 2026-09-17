import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import {
  DATA_DIR, ASSETS_DIR, OUTPUTS_DIR,
  getSettings, updateSettings, publicSettings, effective,
} from './config.js'
import { STYLES } from './styles.js'
import { DEFAULT_LAYOUT } from './layout.js'
import { generatePlaceholders } from './placeholders.js'
import { generateCopy } from './copywriter.js'
import { chatText } from './minimax.js'
import { listTasks, getTask, createPipelineTask, createBatchTask, cancelTask, batchProgress, getStats, onTaskChange, updateTask } from './queue.js'
import { listAssets, addAsset, removeAsset, assetFilePath, LEVELS } from './assets.js'
import { composeBackground } from './bgcompose.js'
import { listCopies, getCopy, createCopy, updateCopy, deleteCopy, polishCopy } from './copies.js'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 }, defParamCharset: 'utf8' })
const ASSET_KINDS = [...LEVELS[1], ...LEVELS[2]].map((x) => x.kind)

/* ---------- /v1 开放接口：webhook 回调 ---------- */
const webhookSent = new Set()
onTaskChange((task) => {
  if (task.kind !== 'pipeline' || !['done', 'failed'].includes(task.status)) return
  const url = task.meta?.webhook
  if (!url || webhookSent.has(task.id)) return
  webhookSent.add(task.id)
  const payload = {
    event: task.status === 'done' ? 'job.completed' : 'job.failed',
    jobId: task.id,
    usable: task.results?.usable ?? null,
    qcScore: task.results?.qcScore ?? null,
    poster: task.results?.poster || null,
    video: task.results?.video || null,
    error: task.error || null,
  }
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {})
})

function loadRegistry() {
  // 兼容别名：指向三层素材注册表
  return listAssets()
}

export function buildRouter() {
  const r = express.Router()

  r.get('/health', (_req, res) => res.json({ ok: true, mock: effective().mock }))

  /* ---- 可用率统计 ---- */
  r.get('/stats', (_req, res) => res.json(getStats()))

  /* ---- 设置 ---- */
  r.get('/settings', (_req, res) => {
    res.json({ ...publicSettings(), layout: getSettings().layout || DEFAULT_LAYOUT, defaults: DEFAULT_LAYOUT })
  })
  r.put('/settings', (req, res) => {
    const allow = ['apiKey', 'baseUrl', 'textModel', 'imageModel', 'videoModel', 'videoResolution', 'mock', 'concurrency', 'layout', 'qcModel', 'maxRepairRounds', 'apiKeys']
    const patch = {}
    for (const k of allow) if (req.body[k] !== undefined) patch[k] = req.body[k]
    const s = updateSettings(patch)
    res.json({ ...publicSettings(), layout: s.layout || DEFAULT_LAYOUT })
  })
  r.post('/settings/test', async (_req, res) => {
    try {
      const reply = await chatText([{ role: 'user', content: '回复ok' }], { maxTokens: 8 })
      res.json({ ok: true, reply: reply.slice(0, 40) })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  })

  /* ---- 风格库 ---- */
  r.get('/styles', (_req, res) => res.json(STYLES))

  /* ---- 素材库（三层）---- */
  r.get('/assets', (req, res) => {
    res.json(listAssets({ level: req.query.level, kind: req.query.kind }))
  })
  r.post('/assets/placeholders', async (req, res) => {
    await generatePlaceholders(req.body || {})
    res.json(listAssets())
  })
  r.post('/assets/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '缺少文件' })
    const kind = req.body.kind
    if (!ASSET_KINDS.includes(kind)) return res.status(400).json({ error: `kind 必须是: ${ASSET_KINDS.join('/')}` })
    const isVideo = kind === 'model_video'
    if (isVideo && !/^video\//.test(req.file.mimetype)) return res.status(400).json({ error: 'model_video 需要视频文件(mp4)' })
    if (!isVideo && !/^image\//.test(req.file.mimetype)) return res.status(400).json({ error: '需要图片文件' })
    const dirInfo = [...LEVELS[1], ...LEVELS[2]].find((x) => x.kind === kind)
    const id = `${kind}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    const dir = path.join(DATA_DIR, dirInfo.dir)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${id}.${isVideo ? 'mp4' : 'png'}`)

    if (isVideo) {
      fs.writeFileSync(file, req.file.buffer)
    } else if (kind === 'product') {
      await sharp(req.file.buffer).resize(800, 800, { fit: 'contain', background: '#ffffff' }).png().toFile(file)
    } else if (kind === 'model_image' || kind === 'arttext') {
      await sharp(req.file.buffer).resize(1440, 1440, { fit: 'inside' }).png().toFile(file) // 保留透明
    } else if (kind === 'bg' || kind === 'plate') {
      await sharp(req.file.buffer).resize(1440, 2880, { fit: 'inside' }).png().toFile(file)
    } else {
      await sharp(req.file.buffer).resize(1024, 1024, { fit: 'inside' }).png().toFile(file) // pattern
    }
    const item = addAsset({
      id,
      level: dirInfo.dir.startsWith('l1') ? 1 : 2,
      kind,
      name: req.body.name || req.file.originalname,
      file: `/files/${dirInfo.dir}/${id}.${isVideo ? 'mp4' : 'png'}`,
      createdAt: Date.now(),
    })
    res.json({ id: item.id, kind: item.kind, level: item.level, name: item.name, file: item.file })
  })
  r.delete('/assets/:id', (req, res) => {
    removeAsset(req.params.id)
    res.json({ ok: true })
  })
  /* L1 → L2 背景合成器 */
  r.post('/compose-bg', async (req, res) => {
    const { plateId, patterns = [], name } = req.body || {}
    if (!plateId) return res.status(400).json({ error: '缺少 plateId（L1 底版）' })
    const plateFile = assetFilePath(plateId)
    if (!plateFile) return res.status(400).json({ error: '底版不存在' })
    try {
      const layers = []
      for (const p of patterns) {
        const pf = assetFilePath(p.assetId)
        if (!pf) return res.status(400).json({ error: `花纹素材不存在: ${p.assetId}` })
        layers.push({ buffer: fs.readFileSync(pf), blend: p.blend, opacity: p.opacity, fit: p.fit })
      }
      const buf = await composeBackground({ plate: fs.readFileSync(plateFile), patterns: layers })
      const id = `bg-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
      const dir = path.join(DATA_DIR, 'assets/l2-bg')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${id}.png`), buf)
      const item = addAsset({
        id, level: 2, kind: 'bg',
        name: name || `合成背景 ${new Date().toLocaleDateString('zh-CN')}`,
        file: `/files/assets/l2-bg/${id}.png`,
        createdAt: Date.now(), source: 'l1-compose',
      })
      res.json({ id: item.id, name: item.name, file: item.file })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  /* ---- L2 文案库 ---- */
  r.get('/copies', (_req, res) => res.json(listCopies()))
  r.post('/copies', (req, res) => res.json(createCopy(req.body || {})))
  r.put('/copies/:id', (req, res) => {
    const item = updateCopy(req.params.id, req.body || {})
    if (!item) return res.status(404).json({ error: '文案不存在' })
    res.json(item)
  })
  r.delete('/copies/:id', (req, res) => {
    deleteCopy(req.params.id)
    res.json({ ok: true })
  })
  r.post('/copies/:id/polish', async (req, res) => {
    try {
      res.json(await polishCopy(req.params.id))
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  /* ---- 文案预览 ---- */
  r.post('/copy', async (req, res) => {
    res.json(await generateCopy(req.body || {}))
  })

  /* ---- 任务 ---- */
  r.post('/tasks', (req, res) => {
    const { productId, modelId, styleId, bgSource, copyId, options } = req.body || {}
    if (!productId) return res.status(400).json({ error: '缺少 productId' })
    const task = createPipelineTask({ productId, modelId, styleId, bgSource, copyId, options })
    res.json(task)
  })
  r.post('/batch', (req, res) => {
    const { productIds, modelIds, styleId, bgSource, copyId, options } = req.body || {}
    if (!Array.isArray(productIds) || !productIds.length) return res.status(400).json({ error: '缺少 productIds' })
    const parent = createBatchTask({ productIds, modelIds: modelIds?.length ? modelIds : [null], styleId, bgSource, copyId, options })
    res.json(parent)
  })
  r.get('/tasks', (req, res) => {
    const out = listTasks(req.query).map((t) => {
      if (t.kind === 'batch') return { ...t, progress: batchProgress(t.id) }
      return t
    })
    res.json(out)
  })
  r.get('/tasks/:id', (req, res) => {
    const t = getTask(req.params.id)
    if (!t) return res.status(404).json({ error: '任务不存在' })
    if (t.kind === 'batch') return res.json({ ...t, progress: batchProgress(t.id) })
    res.json(t)
  })
  r.post('/tasks/:id/cancel', (req, res) => {
    res.json(cancelTask(req.params.id) || { error: '任务不存在' })
  })
  r.delete('/tasks/:id', (req, res) => {
    const t = getTask(req.params.id)
    if (t) {
      cancelTask(t.id)
      t.status = t.status === 'running' ? 'failed' : t.status
      saveRegistrySafeDelete(t)
    }
    res.json({ ok: true })
  })

  /* ---- 结果画廊 ---- */
  r.get('/gallery', (_req, res) => {
    const items = listTasks({ kind: 'pipeline' })
      .filter((t) => t.status === 'done' && t.results?.poster)
      .map((t) => ({
        id: t.id,
        productId: t.productId,
        modelId: t.modelId,
        styleId: t.styleId,
        styleName: t.results.styleName,
        copy: t.results.copy,
        poster: t.results.poster,
        video: t.results.video || null,
        createdAt: t.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
    res.json(items)
  })

  /* ---- /v1 对外开放接口（X-API-Key 鉴权）—— 由 index.js 挂载在根路径 /v1 ---- */
  return r
}

export function buildV1Router() {
  const v1 = express.Router()
  v1.use((req, res, next) => {
    const keys = getSettings().apiKeys || []
    if (!keys.length) return next() // 未配置 = 鉴权关闭（开发模式）
    const key = req.header('X-API-Key')
    if (!key || !keys.includes(key)) return res.status(401).json({ error: '无效 X-API-Key' })
    next()
  })
  v1.get('/health', (_req, res) => res.json({ ok: true, service: 'jd-aigc-agent', stats: getStats() }))
  v1.post('/jobs', (req, res) => {
    const { productId, modelId, styleId, promo, price, generateVideo = false, webhookUrl, layout, copyId, bgSource } = req.body || {}
    if (!productId) return res.status(400).json({ error: 'productId 必填' })
    const task = createPipelineTask({
      productId,
      modelId,
      styleId,
      bgSource,
      copyId,
      options: { promo, price, generateVideo, layout },
      meta: { webhook: webhookUrl, source: 'api' },
    })
    res.status(202).json({ jobId: task.id, status: 'queued', poll: `/v1/jobs/${task.id}` })
  })
  v1.get('/jobs/:id', (req, res) => {
    const t = getTask(req.params.id)
    if (!t || t.kind !== 'pipeline') return res.status(404).json({ error: 'job 不存在' })
    res.json({
      jobId: t.id,
      status: t.status,
      stages: t.stages,
      qc: t.qc || [],
      usable: t.results?.usable ?? null,
      qcScore: t.results?.qcScore ?? null,
      copy: t.results?.copy || null,
      posterUrl: t.results?.poster || null,
      videoUrl: t.results?.video || null,
      error: t.error || null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })
  })
  v1.post('/jobs/batch', (req, res) => {
    const { productIds, modelIds, styleId, promo, price, generateVideo = false, webhookUrl, copyId, bgSource } = req.body || {}
    if (!Array.isArray(productIds) || !productIds.length) return res.status(400).json({ error: 'productIds 必填' })
    const parent = createBatchTask({
      productIds,
      modelIds: modelIds?.length ? modelIds : [null],
      styleId,
      bgSource,
      copyId,
      options: { promo, price, generateVideo },
    })
    if (webhookUrl) {
      // 父批次回调：注册到最后一个子任务上近似实现（子任务各自回调更精确）
      const children = listTasks({ parentId: parent.id })
      if (children.length) updateTaskMeta(children[children.length - 1].id, webhookUrl)
    }
    res.status(202).json({ batchId: parent.id, total: parent.total, poll: `/v1/jobs?batchId=${parent.id}` })
  })
  v1.get('/jobs', (req, res) => {
    const q = { kind: 'pipeline' }
    if (req.query.parentId) q.parentId = req.query.parentId
    res.json(listTasks(q).map((t) => ({ jobId: t.id, status: t.status, usable: t.results?.usable ?? null, qcScore: t.results?.qcScore ?? null, posterUrl: t.results?.poster || null })))
  })
  return v1
}

function updateTaskMeta(id, webhook) {
  const t = getTask(id)
  if (!t) return
  updateTask(id, { meta: { ...t.meta, webhook } })
}

function saveRegistrySafeDelete(t) {
  // 预留：清理输出目录
  try {
    fs.rmSync(path.join(OUTPUTS_DIR, t.id), { recursive: true, force: true })
  } catch {}
}
