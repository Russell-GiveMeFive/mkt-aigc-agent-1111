import { effective } from './config.js'

/**
 * MiniMax API 客户端（按官方文档对齐）
 * - M3 文本/视觉: POST {base}/anthropic/v1/messages   (Anthropic 兼容 Messages API)
 *   · 鉴权 Authorization: Bearer <key>（或 x-api-key）
 *   · thinking: {type:'disabled'|'adaptive'}
 *   · 响应 content[] 为内容块数组，取 type==='text' 拼接
 * - 生图:  POST {base}/v1/image_generation             (image-01, base64)
 * - 视频:  POST {base}/v2/video_generation             (MiniMax-H3, content 多模态数组)
 *          GET  {base}/v2/query/video_generation/{task_id}
 *          · 创建响应 {task_id}；查询响应 {task:{status, content:{url}, error}}
 *          · status ∈ queued|running|succeeded|failed|cancelled
 *          · i2va: image_url + role=first_frame；r2va: reference_image/reference_video（与首尾帧互斥）
 */

async function mmFetch(url, options = {}) {
  const { apiKey } = effective()
  if (!apiKey) throw new Error('未配置 MiniMax API Key，请到「设置」页填写')
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`MiniMax 响应解析失败(HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
  // 三代错误结构：v1 base_resp / Messages+Video v2 {type:'error',error:{type,message}}
  const v1code = body?.base_resp?.status_code ?? 0
  const err = body?.error
  if (res.status === 401 || v1code === 1004 || err?.type === 'authorized_error' || err?.type === 'authentication_error') {
    throw new Error(`MiniMax 鉴权失败，请检查「设置」里的 API Key${err?.message ? `: ${err.message}` : ''}`)
  }
  if (res.status === 402 || v1code === 1008 || err?.type === 'insufficient_balance_error') {
    throw new Error(`MiniMax 余额不足${err?.message ? `: ${err.message}` : ''}`)
  }
  if (err?.message) throw new Error(`MiniMax API 错误(HTTP ${res.status}, ${err.type || 'error'}): ${err.message}`)
  if (!res.ok || (v1code && v1code !== 0)) {
    throw new Error(`MiniMax API 错误(HTTP ${res.status}, code ${v1code}): ${body?.base_resp?.status_msg || text.slice(0, 200)}`)
  }
  return body
}

/* ---------- M3 · Anthropic 兼容 Messages API ---------- */

/** OpenAI 风格 messages → {system, messages} */
function toAnthropicMessages(messages) {
  let system
  const out = []
  for (const m of messages || []) {
    if (m.role === 'system') {
      system = system ? `${system}\n\n${typeof m.content === 'string' ? m.content : ''}` : m.content
      continue
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })
  }
  return { system, messages: out }
}

/** Messages API 调用：返回 text 内容块拼接结果 */
async function messagesCall({ system, messages, maxTokens = 4096, temperature, thinking = 'disabled' }) {
  const { baseUrl, textModel } = effective()
  const body = {
    model: textModel || 'MiniMax-M3',
    max_tokens: Math.min(Math.max(maxTokens, 1), 524288),
    messages,
    thinking: { type: thinking },
  }
  if (system) body.system = system
  if (temperature != null) body.temperature = temperature
  const resp = await mmFetch(`${baseUrl}/anthropic/v1/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  const blocks = resp?.content || []
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('')
  if (!text && resp?.stop_reason === 'max_tokens') throw new Error('M3 输出被 max_tokens 截断，请调大 maxTokens')
  return text
}

/** 文案生成（保持旧签名）：OpenAI 风格 messages → 模型文本 */
export async function chatText(messages, { maxTokens = 2048, temperature, thinking = 'disabled' } = {}) {
  const { system, messages: msgs } = toAnthropicMessages(messages)
  return messagesCall({ system, messages: msgs, maxTokens, temperature, thinking })
}

/** 视觉问答：system + 文本 + 图片(base64 或 URL) → 模型文本 */
export async function chatVisionText({ system, text, imageBase64, imageUrl, mimeType = 'image/png', maxTokens = 2048, temperature = 0.2, thinking = 'disabled' }) {
  const content = [{ type: 'text', text }]
  if (imageUrl) {
    content.push({ type: 'image', source: { type: 'url', url: imageUrl } })
  } else if (imageBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } })
  }
  return messagesCall({
    system,
    messages: [{ role: 'user', content }],
    maxTokens,
    temperature,
    thinking,
  })
}

/* ---------- 生图（image-01） ---------- */

/** 生图：返回 png/jpeg Buffer 数组 */
export async function generateImage({ prompt, aspectRatio = '9:16', width = 720, height = 1440 }) {
  const { baseUrl, imageModel } = effective()
  const body = await mmFetch(`${baseUrl}/v1/image_generation`, {
    method: 'POST',
    body: JSON.stringify({
      model: imageModel,
      prompt,
      aspect_ratio: aspectRatio,
      response_format: 'base64',
      width,
      height,
    }),
  })
  const list = body?.data?.image_base64 || []
  return list.map((b64) => Buffer.from(b64, 'base64'))
}

/* ---------- H3 · 视频 v2 ---------- */

/** 提交 H3 图生视频任务（首帧 I2VA），返回 task_id */
export async function createVideoTask({ prompt, firstFrameUrl, duration = 5, aspectRatio, resolution }) {
  const { baseUrl, videoModel, videoResolution } = effective()
  if (!prompt || !prompt.trim()) throw new Error('H3 创建任务需要非空 text 提示词')
  const content = [
    { type: 'text', text: prompt },
    {
      type: 'image_url',
      image_url: { url: firstFrameUrl }, // 公网 URL / data:image/...;base64
      role: 'first_frame',
    },
  ]
  const body = await mmFetch(`${baseUrl}/v2/video_generation`, {
    method: 'POST',
    body: JSON.stringify({
      model: videoModel || 'MiniMax-H3',
      content,
      resolution: resolution || videoResolution || '768P',
      duration, // 必填：4~15 秒
      ratio: aspectRatio || 'adaptive', // 默认 adaptive（i2va 由首帧决定）；显式 3:4/9:16 等由前端传入
    }),
  })
  const taskId = body?.task_id ?? body?.id
  if (!taskId) throw new Error(`H3 未返回 task_id: ${JSON.stringify(body).slice(0, 200)}`)
  return taskId
}

/**
 * Reference 模式（r2va）：多模态参考生视频
 * posterUrl→reference_image（≤9张），referenceVideoUrl→reference_video（≤3段，单段2-15s）
 * 与首尾帧模式互斥（content 中不可同时出现 first_frame/last_frame）
 */
export async function createVideoTaskReference({ prompt, posterUrl, referenceVideoUrl, duration = 5, aspectRatio, resolution }) {
  const { baseUrl, videoModel, videoResolution } = effective()
  if (!prompt || !prompt.trim()) throw new Error('H3 创建任务需要非空 text 提示词')
  const content = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: posterUrl }, role: 'reference_image' },
    { type: 'video_url', video_url: { url: referenceVideoUrl }, role: 'reference_video' },
  ]
  const body = await mmFetch(`${baseUrl}/v2/video_generation`, {
    method: 'POST',
    body: JSON.stringify({
      model: videoModel || 'MiniMax-H3',
      content,
      resolution: resolution || videoResolution || '768P',
      duration,
      ratio: aspectRatio || 'adaptive',
    }),
  })
  const taskId = body?.task_id ?? body?.id
  if (!taskId) throw new Error(`H3(Reference) 未返回 task_id: ${JSON.stringify(body).slice(0, 200)}`)
  return taskId
}

/** 查询视频任务：返回 {status, videoUrl?, error?, raw}（v2: task.status / task.content.url） */
export async function queryVideoTask(taskId) {
  const { baseUrl } = effective()
  const body = await mmFetch(`${baseUrl}/v2/query/video_generation/${taskId}`)
  const task = body?.task || {}
  const status = task.status ?? body?.status ?? 'unknown'
  const videoUrl = task.content?.url || body?.file?.download_url || body?.file_url || body?.data?.video_url || null
  const error = task.error ? `${task.error.code || ''} ${task.error.message || ''}`.trim() : null
  return { status, videoUrl, error, raw: body }
}
