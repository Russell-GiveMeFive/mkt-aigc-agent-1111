import fs from 'node:fs'
import sharp from 'sharp'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { DATA_DIR, OUTPUTS_DIR, ASSETS_DIR, effective } from './config.js'
import { getStyle } from './styles.js'
import { renderMockBackground, composePoster } from './compositor.js'
import { generateCopy } from './copywriter.js'
import { generateImage, createVideoTask, createVideoTaskReference, createVideoTaskModelRef, queryVideoTask } from './minimax.js'
import { askWithSkills } from './agent/driver.js'
import { skillCatalog } from './skills.js'
import { logEvent } from './agentlog.js'
import { judgePoster, planFromDefects } from './agent/qcAgent.js'
import { resolveLayout } from './layout.js'
import { composeBackground } from './bgcompose.js'
import { getCopy } from './copies.js'
import { getAsset, assetFilePath, assetPath } from './assets.js'
import * as storage from './storage.js'
import { upsertIndex } from './bucketIndex.js'

/**
 * 任务引擎：pipeline 任务（背景→合成→视频）+ batch 父任务（商品×模特矩阵展开）
 * 内存执行 + data/tasks.json 持久化；并发受 settings.concurrency 限制。
 */

const TASKS_FILE = path.join(DATA_DIR, 'tasks.json')
const REGISTRY_FILE = path.join(DATA_DIR, 'assets.json')

function assetName(id) {
  try {
    const reg = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'))
    return reg.find((x) => x.id === id)?.name || ''
  } catch {
    return ''
  }
}
let tasks = []
try {
  tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'))
} catch {
  tasks = []
}
// 重启恢复：已提交 H3（有 videoTaskId）的任务继续轮询取片；未提交的标记可重新提交
for (const t of tasks) {
  if ((t.status === 'running' || t.status === 'queued') && t.results?.videoTaskId) {
    t.status = 'running'
    setTimeout(() => { enqueue(() => resumeVideoTask(t)) }, 200) // 延迟到模块求值完毕（避开 running TDZ）
  } else if (t.status === 'running' || t.status === 'queued') {
    t.status = 'failed'
    t.error = '服务重启导致中断（H3 未提交），可重新提交'
  }
}

let persistTimer = null
function persist() {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2))
  }, 200)
}

const listeners = new Set()
export function onTaskChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function notify(task) {
  for (const fn of listeners) fn(task)
}

export function listTasks(filter = {}) {
  let out = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
  if (filter.kind) out = out.filter((t) => t.kind === filter.kind)
  if (filter.status) out = out.filter((t) => t.status === filter.status)
  if (filter.parentId) out = out.filter((t) => t.parentId === filter.parentId)
  return out
}

export function getTask(id) {
  return tasks.find((t) => t.id === id)
}

export function cancelTask(id) {
  const t = getTask(id)
  if (!t) return null
  if (t.status === 'queued') {
    t.status = 'canceled'
    notify(t)
    persist()
  }
  return t
}

function newTask(init) {
  const t = {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    status: 'queued',
    stages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...init,
  }
  tasks.push(t)
  persist()
  return t
}

export function updateTask(id, patch) {
  const t = getTask(id)
  if (!t) return
  Object.assign(t, patch, { updatedAt: Date.now() })
  persist()
  notify(t)
}

function setStage(task, key, status, extra = {}) {
  let s = task.stages.find((x) => x.key === key)
  if (!s) {
    s = { key, status: 'pending', ...extra }
    task.stages.push(s)
  }
  Object.assign(s, { status, ...extra })
  // 运行日志：每个业务任务（task.id）每个阶段的状态流转全部记录
  logEvent({ biz: BIZ_BY_STAGE[key] || task.kind || 'task', taskId: task.id, traceId: task.id, stage: key, status: status === 'failed' ? 'error' : status, note: extra?.note })
  updateTask(task.id, {})
}

const BIZ_BY_STAGE = { copy: 'l3copy', bg: 'l3bg', compose: 'l3compose', qc: 'l3qc', repair: 'l3qc', video: 'l4video' }

/* ---------- Stage 实现 ---------- */

const MOTION_DIRECTOR_SYSTEM = `你是营销视频运动导演。根据视频技能规范（通过 load_skill 加载）与海报信息，产出一个提交给 MiniMax H3 图生视频模型的运动提示词。

硬性规则（源自 source-only 原则）：
- 只允许海报已有像素产生运动：相机呼吸（0.4%~1.2% 缓推）、≤6px 漂移、光影流动、商品微动（bob/旋转≤0.6°）、标题亮度呼吸；不得发明海报上不存在的元素、人物、文字或特效。
- 运动必须克制（restrained），避免重影/双边缘；末帧必须是完整构图并定格。
- 输出 JSON：{"videoPrompt": "一句中文运动描述（≤80字，给 H3 的 text 提示词）", "motionPlan": "动效要点，≤60字"}`

const MOTION_DIRECTOR_MODEL_SYSTEM = `你是营销视频提示词导演（有模特模式）。会话已附加两张图：
- 图1 = 模特参考图：人物身份、五官、发型、服装、身体比例、初始姿势与合理动作范围的唯一权威。
- 图2 = 商品营销海报：商品、包装文字、标题、Logo、背景、装饰、色彩、构图与画幅的权威。

先通过 load_skill 加载目录中与「有模特商品视频提示词」最相关的技能（若有指定编号则必须加载指定技能）并严格遵循其输出契约，然后产出可直接提交 MiniMax H3 multi-reference 图生视频的创建提示词。

硬性要求：
- 人物从第一帧起自然整合进海报场景（不得中途出现），完成一次连续、鲜活、符合原姿势的带货表演：看向观众、表情变化、身体或重心参与、手臂展示；商品向镜头递近形成 hero close-up。
- 背景烟雾/光影/花瓣/粒子分层定向流动；相框、建筑、桌面、Logo 等固定结构不得缩放或移动。
- 标题可短促错峰上浮、数字脉冲、高光扫过；不得改字、换字体、变形或持续抖动。
- 人物脸部、服装、四肢与比例全程稳定；负面约束必须写入：油腻皮肤、塑料感、AI 脸、五官漂移、额外手指、穿模、商品瞬移、整图缩放、镜头推拉。

只输出 JSON：{"videoPrompt": "完整 H3 multi-reference 提示词（中文，含 5 秒时间线、动作原型、人物表演、商品 hero moment、背景流动、标题动效、参考图职责、负面约束）", "motionPlan": "要点，≤80字"}`

const FALLBACK_VIDEOPROMPT = '画面中心的商品向镜头方向缓缓递出靠近并轻微旋转，模特与背景轻微视差跟随，顶部门头带、节日行与大字标题保持完全静止，整体氛围光缓慢流动'

/** L2 背景来源解析：bucket(v2 fileId) / library(旧注册表) / l1compose / aigc */
async function stageBackground(task, { bgSource, styleId, retry = 0, repairAction }) {
  setStage(task, 'bg', 'running', retry ? { note: `修复重跑(第${retry}轮): ${repairAction || ''}` } : {})
  const cfg = effective()
  const outDir = path.join(OUTPUTS_DIR, task.id)
  fs.mkdirSync(outDir, { recursive: true })
  const bgFile = path.join(outDir, 'bg.png')

  if (task.v2?.bgFileId) {
    // v2：L2 桶中的合成背景
    const buf = await storage.get('l2', task.v2.bgFileId)
    if (!buf) throw new Error(`L2 背景不存在: ${task.v2.bgFileId}`)
    fs.writeFileSync(bgFile, buf)
    task.results.bgSource = 'l2-bucket'
    task.results.styleName = '平台合成背景'
    task.results.bg = `/files/outputs/${task.id}/bg.png`
    setStage(task, 'bg', 'done')
    return
  }
  const src = bgSource?.type ? bgSource : { type: 'aigc', styleId: styleId || 'violet-dream' }
  task.results.bgSource = src.type

  if (src.type === 'library') {
    // 直接使用 L2 合成背景图
    const file = assetFilePath(src.bgId)
    if (!file || !fs.existsSync(file)) throw new Error(`L2 背景素材不存在: ${src.bgId}`)
    fs.copyFileSync(file, bgFile)
    task.results.styleName = getAsset(src.bgId)?.name || '库选背景'
  } else if (src.type === 'l1compose') {
    // L1 组合：底版 + 花纹/字效层
    const plateFile = assetFilePath(src.plateId)
    if (!plateFile || !fs.existsSync(plateFile)) throw new Error(`L1 底版素材不存在: ${src.plateId}`)
    const patterns = []
    for (const p of src.patterns || []) {
      const pf = assetFilePath(p.assetId)
      if (!pf || !fs.existsSync(pf)) throw new Error(`L1 素材不存在: ${p.assetId}`)
      patterns.push({ buffer: fs.readFileSync(pf), blend: p.blend, opacity: p.opacity, fit: p.fit })
    }
    const buf = await composeBackground({ plate: fs.readFileSync(plateFile), patterns })
    fs.writeFileSync(bgFile, buf)
    task.results.styleName = `L1组合(${(src.patterns || []).length}层)`
  } else {
    // AIGC：image-01 / mock
    const style = getStyle(src.styleId || styleId || 'violet-dream')
    if (cfg.mock) {
      const buf = await renderMockBackground(style, 720, 1440, hash(task.productId + style.id) + retry * 97)
      fs.writeFileSync(bgFile, buf)
    } else {
      let prompt = style.prompt.replace(/720x1440,?\s*/i, '')
      if (repairAction) prompt += `\nAdditional requirements: ${repairAction}`
      const bufs = await generateImage({ prompt, aspectRatio: '9:16' })
      if (!bufs.length) throw new Error('生图 API 未返回图片')
      fs.writeFileSync(bgFile, bufs[0])
    }
    task.results.styleName = style.name
  }
  task.results.bg = `/files/outputs/${task.id}/bg.png`
  setStage(task, 'bg', 'done')
}

async function stageCompose(task, { productId, modelId, copy, layoutOverride }) {
  setStage(task, 'compose', 'running')
  const outDir = path.join(OUTPUTS_DIR, task.id)
  const bgFile = path.join(outDir, 'bg.png')
  const posterFile = path.join(outDir, 'poster.png')
  const productFile = productId ? await resolveFileBuffer('l1', productId, 'product') : null
  const modelAsset = modelId ? getAsset(modelId) : null
  let modelFile = modelId ? await resolveFileBuffer('l1', modelId, 'model') : null
  if (modelAsset?.kind === 'model_video') {
    modelFile = null // 模特视频不参与静态合成
    task.results.modelMode = 'video'
  }

  // 风格自带的版式配色（accent/badge 等）合并进 layout，任务 options.layout 可再覆盖
  const style = getStyle(task.styleId)
  const mergedLayout = {
    style: { ...(style.layoutStyle || {}), ...(layoutOverride?.style || {}) },
    zones: layoutOverride?.zones,
  }
  if (!copy.productName) copy.productName = String(task.meta?.productName || '').replace(/^prod-|^model-/, '') || copy.headline

  const poster = await composePoster({
    background: fs.readFileSync(bgFile),
    product: productFile || null,
    model: modelFile || null,
    copy,
    layoutOverride: mergedLayout,
  })
  fs.writeFileSync(posterFile, poster)
  task.results.poster = `/files/outputs/${task.id}/poster.png`
  // v2：海报落 L3 桶（并登记索引，供分页列表查询）
  try {
    const put3 = await storage.put('l3', `${storage.newFileId('l3')}.png`, poster, 'image/png')
    task.results.l3FileId = put3.fileId
    task.results.l3Url = put3.url
    upsertIndex('l3', { fileId: put3.fileId, url: put3.url, name: task.meta?.name || 'L3 海报', createdAt: Date.now(), jobId: task.id })
  } catch {}
  setStage(task, 'compose', 'done')
}

/** v2 fileId 优先读桶，回退旧注册表路径 */
async function resolveFileBuffer(bucket, id, legacyType) {
  if (/^(product|model|plate|pattern|arttext|watermark|labelstyle)_/.test(id) || (bucket === 'l1' && !id.startsWith('prod-') && !id.startsWith('model-'))) {
    const buf = await storage.get(bucket, id)
    if (buf) return buf
  }
  const legacy = assetPath(legacyType, id)
  return legacy && fs.existsSync(legacy) ? fs.readFileSync(legacy) : null
}

async function stageVideo(task, { copy }) {
  setStage(task, 'video', 'running')
  const cfg = effective()
  if (!task.options?.generateVideo) {
    setStage(task, 'video', 'skipped')
    return
  }
  const outDir = path.join(OUTPUTS_DIR, task.id)
  const videoFile = path.join(outDir, 'video.mp4')
  const modelAsset = task.modelId ? getAsset(task.modelId) : null
  const modelVideoFileId = task.v2?.modelVideoFileId
  const isModelVideo = !!modelVideoFileId || modelAsset?.kind === 'model_video'

  if (cfg.mock) {
      // mock 视频：以商品区(360,1080)为锚点的缓推缩放 + 亮度呼吸，模拟「商品递出」动效
      await mockVideo(path.join(outDir, 'poster.png'), videoFile)
      if (isModelVideo) task.results.videoNote = 'mock：模特视频参考未模拟（LIVE 走 H3 Reference 模式）'
  } else {
    const b64 = fs.readFileSync(path.join(outDir, 'poster.png')).toString('base64')
    let taskId
    const vo = task.v2?.videoOpts || {}
    const vParams = { aspectRatio: vo.aspectRatio || '3:4', resolution: vo.resolution || '2K', duration: vo.duration || 5 }
    // motion-agent：M3 以 load_skill(function calling) 读取视频技能 → 产出运动提示词
    // 有模特（task.v2.modelFileId）→ 双图多模态（模特参考 + 海报）+ 点名 h3-live-model 技能 → H3 multi-reference 提示词
    let userMotion = copy.videoPrompt || ''
    const modelFileId = task.v2?.modelFileId || ''
    let modelImgB64 = ''
    if (modelFileId) {
      const mb = await storage.get('l1', modelFileId)
      if (mb) modelImgB64 = mb.toString('base64')
      else logEvent({ biz: 'l4video', taskId: task.id, traceId: task.id, stage: 'motion-agent', status: 'warn', note: `绑定的模特图读取失败: ${modelFileId}（回退无模特流程）` })
    }
    try {
      // 技能目录 = 启用中的 video 相关技能（skillCatalog 过滤 enabled；GUI 停用即时生效，全部停用则零调用）
      const cat = skillCatalog('video')
      const isModelImage = !!modelImgB64
      const mk = isModelImage ? cat.find((c) => /h3-live-model/i.test(c.name || '')) : null
      if (cat.length) {
        const mr = await askWithSkills({
          system: isModelImage ? MOTION_DIRECTOR_MODEL_SYSTEM : MOTION_DIRECTOR_SYSTEM,
          text: isModelImage
            ? `已附加两张图：图1=模特参考图（${modelFileId}），图2=商品营销海报。用户补充描述：${userMotion || '（未填，按技能默认表演语言）'}。比例 ${vParams.aspectRatio}，分辨率 ${vParams.resolution}，时长 ${vParams.duration}s。${mk ? `请优先 load_skill 加载 ${mk.key}（${(mk.name || '').split('·')[0].trim()}）并严格遵循其输出契约。` : ''}请输出 JSON。`
            : `竖版营销海报（画幅即视频画幅）。用户运动描述：${userMotion || '（未填，按技能默认动效语言）'}。比例 ${vParams.aspectRatio}，分辨率 ${vParams.resolution}，时长 ${vParams.duration}s。请输出 JSON。`,
          catalog: cat,
          images: isModelImage ? [`data:image/png;base64,${modelImgB64}`, `data:image/png;base64,${b64}`] : [],
          maxTokens: isModelImage ? 4096 : 2048,
          thinking: 'adaptive',
          log: { biz: 'l4video', taskId: task.id, traceId: task.id, stage: 'motion-agent' },
        })
        const jm = (mr.text || '').match(/\{[\s\S]*\}/)
        if (jm) {
          const pj = JSON.parse(jm[0])
          if (pj.videoPrompt) userMotion = pj.videoPrompt
          if (pj.motionPlan) task.results.motionPlan = pj.motionPlan
        } else if (mr.text && mr.text.trim()) {
          userMotion = mr.text.trim().slice(0, 600)
        }
        task.results.motionAgent = true
        task.results.motionMode = isModelImage ? 'model-ref' : 'poster-only'
        logEvent({ biz: 'l4video', taskId: task.id, traceId: task.id, stage: 'motion-agent-done', status: 'ok', note: `运动提示词已由 skill 驱动生成（mode=${task.results.motionMode}，skillsLoaded=${(mr.skillsLoaded || []).join(',') || '无'}）：${String(userMotion).slice(0, 70)}` })
      }
    } catch (e) {
      logEvent({ biz: 'l4video', taskId: task.id, traceId: task.id, stage: 'motion-agent-done', status: 'warn', note: `motion-agent 失败回退用户描述：${String(e.message).slice(0, 120)}` })
    }
    if (modelImgB64) {
      // 模特图绑定 → 双图参考模式（海报 + 模特参考，H3 multi-reference）
      taskId = await createVideoTaskModelRef({
        prompt: userMotion || copy.videoPrompt || FALLBACK_VIDEOPROMPT, // motion-agent skill 产出优先，输入框原文仅回退
        posterUrl: `data:image/png;base64,${b64}`,
        modelImageUrl: `data:image/png;base64,${modelImgB64}`,
        ...vParams,
      })
    } else if (isModelVideo) {
      // 模特是视频 → H3 Reference 模式（参考视频驱动人物动效 + 海报参考图保版式）
      const mvB64 = modelVideoFileId
        ? (await storage.get('l1', modelVideoFileId))?.toString('base64')
        : fs.readFileSync(assetFilePath(task.modelId)).toString('base64')
      taskId = await createVideoTaskReference({
        prompt: userMotion || copy.videoPrompt || FALLBACK_VIDEOPROMPT, // motion-agent skill 产出优先，输入框原文仅回退
        posterUrl: `data:image/png;base64,${b64}`,
        referenceVideoUrl: `data:video/mp4;base64,${mvB64}`,
        ...vParams,
      })
    } else {
      taskId = await createVideoTask({
        prompt: userMotion || copy.videoPrompt || FALLBACK_VIDEOPROMPT, // motion-agent skill 产出优先，输入框原文仅回退
        firstFrameUrl: `data:image/png;base64,${b64}`,
        ...vParams,
      })
    }
    logEvent({ biz: 'l4video', taskId: task.id, traceId: task.id, stage: 'h3-submit', status: 'ok', note: `H3 taskId=${taskId} ratio=${vParams.aspectRatio} res=${vParams.resolution} dur=${vParams.duration}s mode=${modelImgB64 ? 'model_ref' : isModelVideo ? 'reference' : 'first_frame'}` })
    task.results.videoTaskId = taskId
    task.results.finalPrompt = userMotion || copy.videoPrompt || FALLBACK_VIDEOPROMPT
    await pollH3UntilDone(task, taskId, videoFile)
  }
  await finalizeVideo(task, videoFile)
}

/** 轮询 H3 任务直到成功/失败（最长 8 分钟），成功则下载到 videoFile */
async function pollH3UntilDone(task, taskId, videoFile) {
  const deadline = Date.now() + 8 * 60 * 1000
  let lastPollStatus = ''
  while (Date.now() < deadline) {
    await sleep(4000)
    const q = await queryVideoTask(taskId)
    if (q.status === 'succeeded' || q.status === 'Success' || q.status === 'success' || q.videoUrl) {
      await downloadTo(q.videoUrl, videoFile)
      break
    }
    if (q.status === 'failed' || q.status === 'Failed' || q.status === 'cancelled') {
      throw new Error(`H3 生成失败${q.error ? `(${q.error})` : ''}: ${JSON.stringify(q.raw).slice(0, 200)}`)
    }
    // 状态无变化不打日志（避免 4s 一条的轮询垃圾）
    if (q.status !== lastPollStatus) {
      lastPollStatus = q.status
      setStage(task, 'video', 'running', { note: `H3 状态: ${q.status}` })
    }
  }
  if (!fs.existsSync(videoFile)) throw new Error('H3 视频轮询超时(8min)')
}

/** 视频落 L4 桶（文件名用 H3 taskId 便于对账），完成后置 done */
async function finalizeVideo(task, videoFile) {
  task.results.video = `/files/outputs/${task.id}/video.mp4`
  setStage(task, 'video', 'done', { note: 'H3 视频生成完成' })
  try {
    const l4Name = task.results.videoTaskId ? `l4_${task.results.videoTaskId}.mp4` : `${storage.newFileId('l4')}.mp4`
    const put4 = await storage.put('l4', l4Name, fs.readFileSync(videoFile), 'video/mp4')
    task.results.l4FileId = put4.fileId
    task.results.l4Url = put4.url
    upsertIndex('l4', { fileId: put4.fileId, url: put4.url, name: task.meta?.name || 'L4 视频', createdAt: Date.now(), jobId: task.id, h3TaskId: task.results.videoTaskId })
    logEvent({ biz: 'l4video', taskId: task.id, traceId: task.id, stage: 'l4-bucket', status: 'ok', note: `H3 taskId 命名: ${put4.fileId}` })
  } catch {}
  setStage(task, 'video', 'done')
}

/** 重启恢复：不再重提交 H3，直接继续轮询既有 videoTaskId 直到完成落桶 */
async function resumeVideoTask(task) {
  try {
    updateTask(task.id, { status: 'running' })
    setStage(task, 'video', 'running', { note: `服务重启恢复：继续轮询 H3 ${task.results.videoTaskId}` })
    logEvent({ biz: 'l4video', taskId: task.id, traceId: task.id, stage: 'resume', status: 'ok', note: `重启恢复：继续轮询 H3 ${task.results.videoTaskId}` })
    const videoFile = path.join(OUTPUTS_DIR, task.id, 'video.mp4')
    await pollH3UntilDone(task, task.results.videoTaskId, videoFile)
    await finalizeVideo(task, videoFile)
    updateTask(task.id, { status: 'done' })
  } catch (e) {
    updateTask(task.id, { status: 'failed', error: e.message })
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function hash(s) {
  let h = 0
  for (const c of String(s)) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0
  return Math.abs(h)
}

async function downloadTo(url, file) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`视频下载失败 HTTP ${res.status}`)
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
}

function mockVideo(posterFile, outFile) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-y', '-loop', '1', '-i', posterFile,
      '-filter_complex',
      "zoompan=z='min(zoom+0.0006,1.08)':x='360*(1-1/zoom)':y='1080*(1-1/zoom)':d=125:s=720x1440:fps=25,eq=brightness='0.015*sin(2*PI*t/2.5)',format=yuv420p",
      '-t', '5', '-r', '25', '-c:v', 'libx264', '-movflags', '+faststart', outFile,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 失败: ${err.slice(-300)}`))))
  })
}

/**
 * flat-safe 动效渲染 v3（skill: poster-to-marketing-video 最新版）
 * 规范 v3：背景与相框/装饰边框完全锁定；标题绕自身几何中心原地呼吸（局部裁剪缩放 + 微升）；
 * 商品仅在提供透明图层/alpha mask 时才做呼吸——扁平海报（矩形裁剪会带入相框）保持商品静止；
 * 海报中已有烟雾时允许烟雾微流动（当前扁平输入无烟雾层，跳过）；背景仅明暗光影流动；末帧回原始构图
 */
export async function flatSafeVideo(posterFile, outFile, { duration = 5, fps = 25, titleBox, productAlphaLayer } = {}) {
  const meta = await sharp(posterFile).metadata()
  let W = Math.round(meta.width || 720)
  let H = Math.round(meta.height || 1440)
  W -= W % 2; H -= H % 2
  const frames = duration * fps
  const ev = (x) => Math.round(x / 2) * 2
  const hasProdLayer = !!productAlphaLayer // 透明商品图层（当前 L4 扁平输入无 → 商品静止，符合 v3）
  // 默认保守标题框（上部宽带）；skill 允许保守视觉估计并声明
  const tBox = titleBox || { x: Math.round(W * 0.15), y: Math.round(H * 0.10), w: ev(W * 0.70), h: ev(H * 0.24) }
  tBox.w = ev(tBox.w); tBox.h = ev(tBox.h)
  const fc = `1.0085+0.0085*sin(2*PI*time/2.4)` // 标题 1.000→1.017（100%~103% 区间内）
  const filter = [
    '[0:v]split=2[bg][t]',
    `[t]crop=${tBox.w}:${tBox.h}:${tBox.x}:${tBox.y},zoompan=z='${fc}':x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2':d=${frames}:s=${tBox.w}x${tBox.h}:fps=${fps}[tz]`,
    `[bg][tz]overlay=x=${tBox.x}:y=${tBox.y}-4*sin(2*PI*t/2.4):eof_action=pass[v1]`,
    `[v1]eq=brightness='0.010*sin(2*PI*t/2.5)':saturation='1.0+0.015*sin(2*PI*t/3)',format=yuv420p[v]`,
  ]
  if (hasProdLayer) throw new Error('商品透明图层呼吸暂未接入（需要 productAlphaLayer 输入）') // 规范：无图层不移动商品
  return new Promise((resolve, reject) => {
    const p2 = spawn('ffmpeg', [
      '-y', '-loop', '1', '-i', posterFile,
      '-filter_complex', filter.join(';'),
      '-map', '[v]',
      '-t', String(duration), '-r', String(fps),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', outFile,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p2.stderr.on('data', (d) => (err += d))
    p2.on('close', (code) => (code === 0 ? resolve({ width: W, height: H }) : reject(new Error(`ffmpeg 失败: ${err.slice(-300)}`))))
  })
}

/* ---------- Pipeline 执行 ---------- */

async function runPipeline(task) {
  const { productId, modelId, styleId, options = {} } = task
  const bgSource = task.bgSource
  task.results = task.results || {}
  try {
    updateTask(task.id, { status: 'running' })
    task.stages = [
      { key: 'copy', status: 'pending' },
      { key: 'bg', status: 'pending' },
      { key: 'compose', status: 'pending' },
      { key: 'qc', status: 'pending' },
      { key: 'video', status: options.generateVideo ? 'pending' : 'skipped' },
    ]
    task.qc = []

    // 1) 文案：v2 槽位直传 → 文案资产 → 自动生成
    setStage(task, 'copy', 'running')
    const style = styleId ? getStyle(styleId) : { name: '默认版式', layoutStyle: {} }
    const productMeta = task.meta?.productName || productId || ''
    let copy = null
    if (options.copySlots) {
      copy = {
        ...options.copySlots,
        productName: options.copySlots.productName || productMeta,
        videoPrompt: options.copySlots.videoPrompt || FALLBACK_VIDEOPROMPT,
        source: 'user-slots',
      }
    }
    if (!copy && options.copyId) {
      const c = getCopy(options.copyId)
      if (!c) throw new Error(`文案资产不存在: ${options.copyId}`)
      copy = {
        ...c.slots,
        productName: c.slots.productName || productMeta,
        videoPrompt: c.slots.videoPrompt || FALLBACK_VIDEOPROMPT,
        source: `user-copy:${c.name}`,
      }
    }
    if (!copy) {
      copy = await generateCopy({
        productName: productMeta,
        promo: options.promo,
        price: options.price,
        styleName: style.name,
        taskId: task.id,
      })
    }
    task.results.copy = copy
    setStage(task, 'copy', 'done', { note: copy.source })

    // 2) 背景（L2库选 / L1组合 / AIGC）
    await stageBackground(task, { bgSource, styleId, productId })

    // 3) 合成（合并风格版式 → 任务 options.layout → 修复补丁）
    const mergedLayout = {
      style: { ...(style.layoutStyle || {}), ...(options.layout?.style || {}) },
      zones: options.layout?.zones,
    }
    await stageCompose(task, { productId, modelId, copy, layoutOverride: mergedLayout })

    // 4) QC 裁判 + 修复环路（≤ settings.maxRepairRounds 轮）
    const bgIsAigc = !bgSource?.type || bgSource.type === 'aigc'
    const maxRounds = Math.max(0, effective().maxRepairRounds ?? 2)
    let verdict = await runQc(task, mergedLayout, copy)
    let rounds = 0
    while (!verdict.pass && rounds < maxRounds) {
      rounds++
      const plan = verdict.repairPlan?.stage ? verdict.repairPlan : planFromDefects(verdict.defects || [])
      if (!plan.stage) break
      setStage(task, 'qc', 'running', { note: `第${rounds}轮修复 → ${plan.stage}: ${plan.action || ''}` })
      if (plan.stage === 'bg' && bgIsAigc) {
        await stageBackground(task, { bgSource, styleId, productId, retry: rounds, repairAction: plan.action })
        await stageCompose(task, { productId, modelId, copy, layoutOverride: mergedLayout })
      } else if (plan.stage === 'bg') {
        // 背景来自用户素材，换背景无意义 → 落到 compose 修复
        const repairLayout = applyComposeRepair(mergedLayout, verdict.defects || [])
        await stageCompose(task, { productId, modelId, copy, layoutOverride: repairLayout })
      } else if (plan.stage === 'copy') {
        setStage(task, 'copy', 'running', { note: `修复重跑: ${plan.action || ''}` })
        if (options.copyId) {
          // 用户文案：只允许裁剪标题，不覆盖语义
          const c = getCopy(options.copyId)
          copy = { ...copy, headline: shortenHeadline(copy.headline), source: `user-copy:${c?.name || options.copyId}(自动缩短)` }
        } else {
          copy = await generateCopy({ productName: productMeta, promo: options.promo, price: options.price, styleName: style.name, shorten: true, taskId: task.id })
        }
        task.results.copy = copy
        setStage(task, 'copy', 'done')
        await stageCompose(task, { productId, modelId, copy, layoutOverride: mergedLayout })
      } else {
        const repairLayout = applyComposeRepair(mergedLayout, verdict.defects || [])
        await stageCompose(task, { productId, modelId, copy, layoutOverride: repairLayout })
      }
      verdict = await runQc(task, mergedLayout, copy, rounds)
    }
    task.results.usable = !!verdict.pass
    task.results.qcScore = verdict.score
    setStage(task, 'qc', verdict.pass ? 'done' : 'failed', {
      note: `${verdict.source || ''} ${verdict.score}分${verdict.pass ? ' · 通过' : ' · 未通过'}${rounds ? ` · ${rounds}轮修复` : ''}`,
    })

    // 5) 视频
    await stageVideo(task, { copy })

    updateTask(task.id, { status: 'done' })
  } catch (e) {
    updateTask(task.id, { status: 'failed', error: e.message })
  }
}

/** 用户文案标题自动缩短（修复环路用，不覆盖语义） */
function shortenHeadline(h) {
  const lines = String(h || '').split('\n')
  return lines.map((l) => (l.length > 8 ? l.slice(0, 8) : l)).join('\n')
}

async function runQc(task, mergedLayout, copy, round = 0) {
  setStage(task, 'qc', 'running', { note: round ? `修复后复检(第${round}轮)` : undefined })
  const outDir = path.join(OUTPUTS_DIR, task.id)
  const posterBuffer = fs.readFileSync(path.join(outDir, 'poster.png'))
  const verdict = await judgePoster({ posterBuffer, layout: resolveLayout(mergedLayout), copy, log: { taskId: task.id } })
  task.qc.push({ round, verdict, at: Date.now() })
  updateTask(task.id, {})
  return verdict
}

/** compose 修复补丁：按缺陷码映射版式参数 */
function applyComposeRepair(mergedLayout, defects) {
  const patch = { style: {}, zones: {} }
  for (const d of defects) {
    if (d.code === 'LOW_CONTRAST_HEADLINE') {
      patch.style.headlineStroke = 18
      patch.style.scrimColorEnd = 'rgba(10,6,30,0.9)'
    }
    if (d.code === 'PRODUCT_MISSING') {
      const pz = resolveLayout(mergedLayout).zones.product
      patch.zones.product = { ...pz, x: pz.x - 20, y: pz.y - 20, w: pz.w + 40, h: pz.h + 40 }
    }
    if (d.code === 'CTA_MISSING') {
      patch.style.promoBg = 'rgba(26,20,64,0.8)'
    }
  }
  if (!Object.keys(patch.style).length && !Object.keys(patch.zones).length) return mergedLayout
  return {
    style: { ...mergedLayout.style, ...patch.style },
    zones: { ...mergedLayout.zones, ...patch.zones },
  }
}

/* ---------- v2 任务入口（三层模型） ---------- */

/**
 * L3 海报生成任务：v2 的 bgFileId/productFileId/modelFileId 均为桶内 fileId
 * copySlots 为用户输入的文案槽位（L2 文案）
 */
export function createJob({ bgFileId, productFileId, modelFileId, modelVideoFileId, copySlots, copyId, generateVideo = false, reworkOf, meta }) {
  const task = newTask({
    kind: 'pipeline',
    v2: { bgFileId, productFileId, modelFileId, modelVideoFileId, reworkOf },
    productId: productFileId, // 兼容 runPipeline 内部引用
    modelId: modelFileId,
    styleId: null,
    options: { copySlots, copyId, generateVideo },
    meta: { ...(meta || {}) },
    results: {},
  })
  enqueue(() => runPipeline(task))
  return task
}

export function createJobBatch(items) {
  return items.map((item) => createJob(item))
}

/** L4 视频任务：基于已有 L3 海报直接生成视频（不重跑管线） */
export function createVideoJob({ l3FileId, prompt, modelVideoFileId, modelFileId, videoOpts }) {
  const task = newTask({
    kind: 'video',
    v2: { l3FileId, modelVideoFileId, modelFileId, videoOpts: videoOpts || {} },
    options: { generateVideo: true, copySlots: { videoPrompt: prompt } },
    results: {},
    stages: [{ key: 'video', status: 'pending' }],
  })
  enqueue(() => runVideoOnly(task))
  return task
}

async function runVideoOnly(task) {
  try {
    updateTask(task.id, { status: 'running' })
    const posterId = task.v2.l3FileId
    const posterBucket = String(posterId).startsWith('l2bg_') ? 'l2' : 'l3'
    const posterBuf = await storage.get(posterBucket, posterId)
    if (!posterBuf) throw new Error(`海报不存在(${posterBucket}): ${posterId}`)
    const outDir = path.join(OUTPUTS_DIR, task.id)
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'poster.png'), posterBuf)
    task.results.poster = `/files/outputs/${task.id}/poster.png`
    await stageVideo(task, { copy: { videoPrompt: task.options?.copySlots?.videoPrompt } })
    updateTask(task.id, { status: 'done' })
  } catch (e) {
    updateTask(task.id, { status: 'failed', error: e.message })
  }
}

/* ---------- 队列 ---------- */

let running = 0
const waitQueue = []

function pump() {
  const c = effective().concurrency
  const limit = (!c || c <= 0) ? Infinity : Math.max(1, c) // 0/未设置 = 不限制
  while (running < limit && waitQueue.length) {
    const job = waitQueue.shift()
    running++
    job().finally(() => {
      running--
      pump()
    })
  }
}

function enqueue(job) {
  waitQueue.push(job)
  pump()
}

export function createPipelineTask({ productId, modelId, styleId, bgSource, copyId, options, meta }) {  const task = newTask({
    kind: 'pipeline',
    productId,
    modelId,
    styleId,
    bgSource,
    options: { copyId, ...options },
    meta: { productName: assetName(productId) || productId, modelName: modelId, ...meta },
    results: {},
  })
  enqueue(() => runPipeline(task))
  return task
}

/** 批量：商品×模特 全组合 */
export function createBatchTask({ productIds, modelIds, styleId, bgSource, copyId, options }) {
  const combos = []
  for (const p of productIds) for (const m of modelIds) combos.push({ productId: p, modelId: m })
  const parent = newTask({
    kind: 'batch',
    styleId,
    bgSource,
    options: { copyId, ...options },
    status: 'running',
    children: [],
    total: combos.length,
    results: {},
  })
  for (const c of combos) {
    const child = newTask({
      kind: 'pipeline',
      parentId: parent.id,
      productId: c.productId,
      modelId: c.modelId,
      styleId,
      bgSource,
      options: { copyId, ...options },
      meta: { productName: assetName(c.productId) || c.productId, modelName: c.modelId },
      results: {},
    })
    parent.children.push(child.id)
    enqueue(() => runPipeline(child))
  }
  notify(parent)
  return parent
}

/** 批量父任务进度聚合（查询时动态计算） */
export function batchProgress(parentId) {
  const children = listTasks({ parentId })
  const done = children.filter((t) => t.status === 'done').length
  const failed = children.filter((t) => t.status === 'failed').length
  return { total: children.length, done, failed, children }
}

/** 可用率统计（QC 口径，仅统计经过 QC 裁判的任务） */
export function getStats() {
  const list = tasks.filter((t) => t.kind === 'pipeline' && t.status === 'done' && t.qc?.length)
  const usable = list.filter((t) => t.results?.usable)
  const defectHist = {}
  for (const t of list) for (const r of t.qc || []) for (const d of r.verdict?.defects || []) defectHist[d.code] = (defectHist[d.code] || 0) + 1
  const scores = list.map((t) => t.results?.qcScore).filter((s) => typeof s === 'number')
  return {
    total: list.length,
    usable: usable.length,
    usableRate: list.length ? +((usable.length / list.length) * 100).toFixed(1) : 100,
    avgScore: scores.length ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null,
    repairs: list.reduce((a, t) => a + Math.max(0, (t.qc?.length || 1) - 1), 0),
    defectHist,
  }
}

setInterval(persist, 5000).unref?.()
