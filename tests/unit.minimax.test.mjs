/**
 * MiniMax 协议单元测试 —— stub 全局 fetch，验证请求构造 / 响应解析 / 错误处理
 * 运行：node --test tests/
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { getSettings, updateSettings } from '../server/config.js'
import * as mm from '../server/minimax.js'

let originalSettings
let realFetch
const calls = []

before(() => {
  originalSettings = JSON.parse(JSON.stringify(getSettings()))
  updateSettings({ apiKey: 'test-key', baseUrl: 'https://api.minimax.cn', mock: false })
  realFetch = global.fetch
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts: JSON.parse(JSON.stringify(opts)) })
    const u = String(url)
    if (u.includes('/anthropic/v1/messages')) {
      const body = JSON.parse(opts.body)
      if (body.model === 'FAIL_401') return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
      if (body.model === 'FAIL_402') return json(402, { base_resp: { status_code: 1008, status_msg: 'insufficient balance' } })
      if (body.model === 'FAIL_500') return json(500, 'server exploded')
      return json(200, {
        id: 'msg_1',
        content: [
          { type: 'thinking', thinking: 'internal reasoning…' },
          { type: 'text', text: '你好' },
          { type: 'text', text: '，世界' },
        ],
        usage: { output_tokens: 42 },
      })
    }
    if (u.includes('/v2/video_generation') && opts.method === 'POST') return json(200, { task_id: 'vid_123' })
    if (u.includes('/v2/query/video_generation/RUNNING')) return json(200, { task: { status: 'running' } })
    if (u.includes('/v2/query/video_generation/FAILED')) return json(200, { task: { status: 'failed', error: { code: 'generation_failed', message: 'content filtered' } } })
    if (u.includes('/v2/query/video_generation/')) return json(200, { task: { status: 'succeeded', content: { url: 'https://cdn.example.com/out.mp4' } } })
    if (u.includes('/v1/image_generation')) {
      return json(200, { data: { image_base64: [Buffer.from('img').toString('base64')] }, base_resp: { status_code: 0 } })
    }
    return json(404, {})
  }
})

after(() => {
  global.fetch = realFetch
  updateSettings(originalSettings)
})

const json = (status, body) => ({
  ok: status < 400,
  status,
  headers: { get: () => 'application/json' },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
})

test('chatText：走 Anthropic 兼容 Messages API，system 提取，content 拼接（过滤 thinking 块）', async () => {
  calls.length = 0
  const out = await mm.chatText(
    [
      { role: 'system', content: '你是文案助手' },
      { role: 'user', content: '写句口号' },
    ],
    { maxTokens: 4096, temperature: 0.7 }
  )
  assert.equal(out, '你好，世界')
  const c = calls[0]
  assert.match(c.url, /^https:\/\/api\.minimax\.cn\/anthropic\/v1\/messages$/)
  assert.equal(c.opts.headers.Authorization, 'Bearer test-key')
  const body = JSON.parse(c.opts.body)
  assert.equal(body.model, 'MiniMax-M3')
  assert.equal(body.system, '你是文案助手')
  assert.deepEqual(body.messages, [{ role: 'user', content: '写句口号' }])
  assert.equal(body.max_tokens, 4096)
})

test('chatVisionText：图片转 base64 内容块', async () => {
  calls.length = 0
  const b64 = Buffer.from('pngdata').toString('base64')
  const out = await mm.chatVisionText({ system: '裁判', text: '打分', imageBase64: b64, mimeType: 'image/png' })
  assert.equal(out, '你好，世界')
  const content = JSON.parse(calls[0].opts.body).messages[0].content
  assert.ok(Array.isArray(content))
  assert.equal(content[0].type, 'text')
  assert.equal(content[0].text, '打分')
  assert.equal(content[1].type, 'image')
  assert.equal(content[1].source.type, 'base64')
  assert.equal(content[1].source.media_type, 'image/png')
  assert.equal(content[1].source.data, b64)
})

test('createVideoTask v2：prompt 校验 + resolution/duration/ratio 必填 + 返回 task_id', async () => {
  calls.length = 0
  await assert.rejects(() => mm.createVideoTask({ prompt: '  ' }), /非空/)
  const taskId = await mm.createVideoTask({ prompt: '模特递商品', firstFrameUrl: 'data:image/png;base64,QUJD', duration: 5 })
  assert.equal(taskId, 'vid_123')
  const body = JSON.parse(calls[0].opts.body)
  assert.equal(body.model, 'MiniMax-H3')
  assert.equal(body.duration, 5)
  assert.equal(body.resolution, '768P')
  assert.equal(body.ratio, 'adaptive')
  assert.equal(body.content[0].type, 'text')
  assert.equal(body.content[1].role, 'first_frame')
})

test('createVideoTaskReference：reference_image + reference_video（与首尾帧互斥语义）', async () => {
  calls.length = 0
  const taskId = await mm.createVideoTaskReference({ prompt: '参考视频换商品', posterUrl: 'https://x/p.png', referenceVideoUrl: 'https://x/v.mp4' })
  assert.equal(taskId, 'vid_123')
  const body = JSON.parse(calls[0].opts.body)
  assert.equal(body.content[1].role, 'reference_image')
  assert.equal(body.content[2].role, 'reference_video')
  assert.ok(!body.content.some((c) => c.role === 'first_frame' || c.role === 'last_frame'))
})

test('queryVideoTask v2：解析 task.status / content.url / task.error', async () => {
  calls.length = 0
  assert.equal((await mm.queryVideoTask('RUNNING')).status, 'running')
  const done = await mm.queryVideoTask('OK')
  assert.equal(done.status, 'succeeded')
  assert.equal(done.videoUrl, 'https://cdn.example.com/out.mp4')
  const failed = await mm.queryVideoTask('FAILED')
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /content filtered/)
})

test('鉴权失败 401 → 友好报错提示检查 API Key', async () => {
  updateSettings({ textModel: 'FAIL_401' })
  try {
    await assert.rejects(() => mm.chatText([{ role: 'user', content: 'x' }]), /API Key/)
  } finally {
    updateSettings({ textModel: originalSettings.textModel || 'MiniMax-M3' })
  }
})

test('余额不足 402 → 提示余额', async () => {
  updateSettings({ textModel: 'FAIL_402' })
  try {
    await assert.rejects(() => mm.chatText([{ role: 'user', content: 'x' }]), /余额/)
  } finally {
    updateSettings({ textModel: originalSettings.textModel || 'MiniMax-M3' })
  }
})

test('服务端 500 → 带状态码抛出', async () => {
  updateSettings({ textModel: 'FAIL_500' })
  try {
    await assert.rejects(() => mm.chatText([{ role: 'user', content: 'x' }]), /HTTP 500/)
  } finally {
    updateSettings({ textModel: originalSettings.textModel || 'MiniMax-M3' })
  }
})

test('image-01 生图：解析 image_base64 为 Buffer 数组', async () => {
  calls.length = 0
  const bufs = await mm.generateImage({ prompt: '红色渐变底版', width: 720, height: 1440 })
  assert.equal(bufs.length, 1)
  assert.equal(bufs[0].toString(), 'img')
  const body = JSON.parse(calls[0].opts.body)
  assert.equal(body.response_format, 'base64')
  assert.equal(body.aspect_ratio, '9:16')
})

// ===== pi Agent 层：预置提示词 + 统一驱动 =====
const { COPY_SYSTEM, HTML_SYSTEM, QC_SYSTEM, PROMPTS } = await import('../server/agent/prompts.js')
const { ask, parseJsonLoose } = await import('../server/agent/driver.js')

test('预置系统提示词：三套齐全且含关键约束', () => {
  assert.match(COPY_SYSTEM, /只输出 JSON/)
  assert.match(COPY_SYSTEM, /videoPrompt/)
  assert.match(HTML_SYSTEM, /720px/)
  assert.match(HTML_SYSTEM, /绝对定位/)
  assert.match(HTML_SYSTEM, /<!DOCTYPE html>/)
  assert.match(QC_SYSTEM, /"pass"/)
  assert.match(QC_SYSTEM, /score>=85/)
  assert.equal(Object.keys(PROMPTS).length, 3)
})

test('agent/driver.ask：走统一通道返回文本（pi 主路或直连兜底同结果）', async () => {
  const before = calls.length // fetch 桩已在 before() 全局安装，直接计数
  const out = await ask({ system: '你是回声机', text: '你好，世界', maxTokens: 64 })
  assert.ok(typeof out === 'string' && out.length > 0)
  assert.ok(calls.length > before, 'ask 发出了 HTTP 调用')
  const last = calls[calls.length - 1]
  const body = JSON.parse(last.opts.body)
  assert.equal(body.model, 'MiniMax-M3')
  assert.ok(body.messages.some((m) => m.role === 'user'))
})

test('parseJsonLoose：从混排文本中稳健抠出 JSON', () => {
  assert.deepEqual(parseJsonLoose('前言\n{"pass":true,"score":90}\n后记'), { pass: true, score: 90 })
  assert.equal(parseJsonLoose('完全没有 JSON'), null)
  assert.equal(parseJsonLoose(''), null)
})
