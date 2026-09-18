import { complete, registerBuiltInApiProviders, Type } from '@mariozechner/pi-ai'
import { effective } from '../config.js'
import { chatText, chatVisionText } from '../minimax.js'
import { logEvent, newTrace } from '../agentlog.js'
import { skillTextByKey } from '../skills.js'

// pi-ai 的 provider 注册表需要显式初始化；api 名是 'anthropic-messages'（不是 'anthropic'）
registerBuiltInApiProviders()

/**
 * pi Agent 统一模型驱动（所有 LLM 调用的唯一入口）
 * - 主路：pi-ai（anthropic 协议）→ POST {baseUrl}/anthropic/v1/messages（MiniMax Messages API）
 *   pi-ai 的 anthropic provider 用 Anthropic SDK：{baseUrl}/v1/messages + x-api-key 头，与 MiniMax 兼容
 * - 兜底：pi-ai 调用异常时直连 minimax.chatText / chatVisionText（同一 Messages API）
 * - ask()      纯文本：文案生成 / L2 HTML 生成
 * - askVision() 视觉：QC 裁判
 * MOCK 模式下由上层（copywriter/llmCompose/qcAgent）本地规则代替，不会走到这里。
 */

function buildModel(cfg, reasoning = false) {
  return {
    id: cfg.qcModel || 'MiniMax-M3',
    name: cfg.qcModel || 'MiniMax-M3',
    api: 'anthropic-messages',
    provider: { id: 'minimax', name: 'MiniMax' },
    baseUrl: `${(cfg.baseUrl || 'https://api.minimax.cn').replace(/\/$/, '')}/anthropic`,
    reasoning,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

/** 纯文本补全：system + 用户文本 → 模型文本（thinking: disabled|adaptive，adaptive 传给兜底通道）
 * opts.log: { biz, taskId, stage, skillIds, skillChars } —— 写入运行日志（traceId 自动生成） */
const TRACE_HEADER_KEYS = ['trace-id', 'minimax-request-id', 'x-minimax-trace-id', 'x-trace-id', 'x-request-id', 'request-id', 'x-msh-trace-id', 'cf-ray']
function pickTraceHeaders(headers) {
  if (!headers) return null
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    const lk = String(k).toLowerCase()
    if (TRACE_HEADER_KEYS.includes(lk)) out[lk] = v
  }
  return Object.keys(out).length ? out : null
}

export async function ask({ system, text, maxTokens = 2048, temperature, thinking = 'disabled', log = {} }) {
  const cfg = effective()
  if (!cfg.apiKey) throw new Error('未配置 API Key（Agent 调用需要）')
  const traceId = log.traceId || newTrace()
  const t0 = Date.now()
  const baseLog = { biz: log.biz || 'driver', taskId: log.taskId, stage: log.stage, traceId, model: cfg.qcModel || 'MiniMax-M3', promptChars: (system || '').length + (text || '').length, skillIds: log.skillIds, skillChars: log.skillChars }
  if (!cfg.apiKey) { /* unreachable */ }
  try {
    const message = await complete(
      buildModel(cfg, thinking === 'adaptive'),
      {
        systemPrompt: system,
        messages: [{ role: 'user', content: String(text || ''), timestamp: Date.now() }],
      },
      { apiKey: cfg.apiKey, maxTokens: Math.max(maxTokens, 1024), temperature },
    )
    const out = (message?.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('')
    if (out) {
      logEvent({ ...baseLog, responseId: message?.id, latencyMs: Date.now() - t0, outChars: out.length, usage: message?.usage, status: 'ok' })
      return out
    }
    throw new Error('pi-ai 返回空文本')
  } catch (e) {
    // 兜底：直连 Messages API（同一协议，绕过 SDK 行为差异；thinking 参数在此生效）
    logEvent({ ...baseLog, status: 'fallback', error: e.message?.slice(0, 200), latencyMs: Date.now() - t0 })
    const t1 = Date.now()
    try {
      const out = await chatText(
        [
          { role: 'system', content: system },
          { role: 'user', content: String(text || '') },
        ],
        { maxTokens: Math.max(maxTokens, 1024), temperature, thinking },
      )
      logEvent({ ...baseLog, stage: baseLog.stage ? `${baseLog.stage}(fallback)` : 'fallback', latencyMs: Date.now() - t1, outChars: (out || '').length, status: out ? 'ok' : 'empty' })
      return out
    } catch (e2) {
      logEvent({ ...baseLog, status: 'error', error: e2.message?.slice(0, 200), latencyMs: Date.now() - t1 })
      throw e2
    }
  }
}

/** 视觉问答：system + 文本 + 可选图片(base64) → 模型文本 */
export async function askVision({ system, text, imageBase64, mimeType = 'image/png', maxTokens = 1024, temperature = 0.2, log = {} }) {
  const cfg = effective()
  if (!cfg.apiKey) throw new Error('未配置 API Key（Agent 视觉调用需要）')
  const traceId = log.traceId || newTrace()
  const t0 = Date.now()
  const baseLog = { biz: log.biz || 'driver', taskId: log.taskId, stage: log.stage || 'vision', traceId, model: cfg.qcModel || 'MiniMax-M3', promptChars: (system || '').length + (text || '').length, skillIds: log.skillIds, skillChars: log.skillChars }
  try {
    const content = [{ type: 'text', text }]
    if (imageBase64) content.push({ type: 'image', data: imageBase64, mimeType })
    const message = await complete(
      buildModel(cfg),
      {
        systemPrompt: system,
        messages: [{ role: 'user', content, timestamp: Date.now() }],
      },
      { apiKey: cfg.apiKey, maxTokens: Math.max(maxTokens, 1024), temperature },
    )
    const out = (message?.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('')
    if (out) {
      logEvent({ ...baseLog, responseId: message?.id, latencyMs: Date.now() - t0, outChars: out.length, usage: message?.usage, status: 'ok' })
      return out
    }
    throw new Error('pi-ai 返回空文本')
  } catch (e) {
    // 兜底：直连 Messages API（同一协议，绕过 SDK 行为差异）
    logEvent({ ...baseLog, status: 'fallback', error: e.message?.slice(0, 200), latencyMs: Date.now() - t0 })
    const t1 = Date.now()
    try {
      const out = await chatVisionText({ system, text, imageBase64, mimeType, maxTokens: Math.max(maxTokens, 1024), temperature })
      logEvent({ ...baseLog, stage: `${baseLog.stage}(fallback)`, latencyMs: Date.now() - t1, outChars: (out || '').length, status: out ? 'ok' : 'empty' })
      return out
    } catch (e2) {
      logEvent({ ...baseLog, status: 'error', error: e2.message?.slice(0, 200), latencyMs: Date.now() - t1 })
      throw e2
    }
  }
}

/** 从模型输出中稳健解析 JSON 对象 */
export function parseJsonLoose(text) {
  if (!text) return null
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}

/**
 * function-call 式技能调用：模型通过 load_skill 工具按需拉取技能全文
 * - 首轮只给技能目录（编号 + 名称 + 160 字简介），不塞全文（省 token、模型自己挑相关的）
 * - 模型调 load_skill(S3) → 本地读 md 全文作为 toolResult 回传 → 继续生成
 * - 最多 3 次工具调用；pi 主路失败降级为调用方自行处理
 * 返回 { text, skillsLoaded: ['S1', ...], rounds }
 */
export async function askWithSkills({ system, text, catalog = [], maxTokens = 32768, thinking = 'disabled', log = {}, images = [] }) {
  const cfg = effective()
  if (!cfg.apiKey) throw new Error('未配置 API Key（Agent 调用需要）')
  const traceId = log.traceId || newTrace()
  const t0 = Date.now()
  const baseLog = { biz: log.biz || 'driver', taskId: log.taskId, stage: log.stage, traceId, model: cfg.qcModel || 'MiniMax-M3', skillCount: catalog.length }
  const loadSkill = {
    name: 'load_skill',
    description: '读取一个已安装技能的完整规范全文。生成任何内容之前必须先调用本工具加载 1~3 个与任务最相关的技能；编号必须原样传入。',
    parameters: Type.Object({
      key: Type.String({ description: '技能目录中的编号，如 S1、S3' }),
    }),
  }
  const catalogText = catalog.length
    ? catalog.map((c) => `${c.key}: ${c.name}（${c.chars} 字）— ${c.desc}`).join('\n')
    : '（当前无已启用技能——本次任务不提供 load_skill 工具，直接开始生成）'
  const fullText = `${text}\n\n可用技能目录（先用 load_skill 工具加载其中 1~3 个与本次任务最相关的技能全文，再开始生成）：\n${catalogText || '（无）'}`
  // images: dataURL 数组 → anthropic 多模态 content blocks（图随首条 user 消息附加）
  const userContent = images.length
    ? [
        ...images.slice(0, 6).map((dataUrl) => {
          const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl) || []
          return { type: 'image', data: m[2] || '', mimeType: m[1] || 'image/png' } // pi-ai ImageContent：裸 base64 + mimeType
        }),
        { type: 'text', text: fullText },
      ]
    : fullText
  const messages = [{ role: 'user', content: userContent, timestamp: Date.now() }]
  const loaded = []
  let nudged = false
  try {
    let rounds = 0
    for (rounds = 1; rounds <= 4; rounds++) {
      let m3Trace = null
      const message = await complete(
        buildModel(cfg, thinking === 'adaptive'),
        { systemPrompt: system, messages, tools: catalog.length ? [loadSkill] : [] }, // 全部技能停用 → 不注册 load_skill 工具
        { apiKey: cfg.apiKey, maxTokens, temperature: log.temperature, onResponse: (r) => { m3Trace = r?.headers || null } },
      )
      const calls = (message?.content || []).filter((c) => c.type === 'toolCall')
      const toolUse = message?.stopReason === 'toolUse' && calls.length > 0
      // function calling 可见化：每轮是否带工具调用、注册了几个工具、调了几个
      logEvent({ ...baseLog, stage: `${log.stage || 'agent'}·round`, round: rounds, toolUse, toolCalls: calls.length, toolsRegistered: catalog.length ? 1 : 0, m3Trace: pickTraceHeaders(m3Trace), status: 'ok', note: `round=${rounds} ${toolUse ? `function calling → ${calls.map((c) => c.name || 'load_skill').join('+')}` : '直接出文（本轮无工具调用）'}` })
      if (message?.stopReason !== 'toolUse' || !calls.length) {
        // 强制技能：首轮就想直接出文且一个技能都没加载 → 追加提醒再给一次机会
        if (!loaded.length && !nudged && catalog.length) {
          nudged = true
          messages.push({ role: 'assistant', content: message?.content || [], api: message?.api, provider: message?.provider, model: message?.model, usage: message?.usage, stopReason: message?.stopReason, timestamp: message?.timestamp || Date.now() })
          messages.push({ role: 'user', content: '请先调用 load_skill 工具加载目录中 1~3 个最相关的技能全文（不要跳过），然后再生成。', timestamp: Date.now() })
          continue
        }
        const out = (message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
        logEvent({ ...baseLog, responseId: message?.responseId || message?.id, m3Trace: pickTraceHeaders(m3Trace), latencyMs: Date.now() - t0, outChars: out.length, status: 'ok', note: `skillsLoaded=${loaded.join(',') || '无'} rounds=${rounds}` })
        return { text: out, skillsLoaded: loaded, rounds, responseId: message?.responseId || message?.id }
      }
      // 回传 assistant 原始消息（含 toolCall），再逐个执行工具
      messages.push({ ...message, timestamp: message.timestamp || Date.now() })
      for (const call of calls) {
        const key = call.arguments?.key
        const body = skillTextByKey(key, log.scope || 'all')
        if (body) loaded.push(key) // 只有真实取到全文才计入 skillsLoaded（停用/不存在的 key 不污染记录）
        logEvent({ ...baseLog, stage: `${log.stage || 'agent'}·load_skill`, m3Trace: pickTraceHeaders(m3Trace), status: body ? 'ok' : 'error', note: `${key}(${body ? body.length + '字' : '未找到——可能已停用或不在目录'})` })
        messages.push({
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: 'text', text: body || `未找到技能 ${key}，请改用目录中的编号。` }],
          isError: !body,
          timestamp: Date.now(),
        })
      }
    }
    throw new Error('工具循环超出轮次')
  } catch (e) {
    logEvent({ ...baseLog, status: 'error', error: e.message?.slice(0, 200), latencyMs: Date.now() - t0, note: `skillsLoaded=${loaded.join(',') || '无'}` })
    throw e
  }
}
