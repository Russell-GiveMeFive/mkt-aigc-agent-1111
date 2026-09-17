import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DATA_DIR } from './config.js'

/**
 * AIGC 业务运行日志（JSONL 落盘，按天分文件）
 * 每条记录：{ ts, biz, taskId, stage, status, traceId, responseId, model,
 *            latencyMs, promptChars, outChars, skillIds, skillChars, error, note }
 * - biz:      业务域 l2compose / l3copy / l3bg / l3compose / l3qc / l4video / driver
 * - taskId:   业务任务号（queue job id / compose 名），串联同一任务的全部调用
 * - traceId:  本服务生成的调用链 id（一次 LLM 请求一条）
 * - responseId: 模型返回的 id（MiniMax Messages 响应 id），用于对账服务端日志
 */
const LOG_DIR = path.join(DATA_DIR, 'logs')

export function newTrace() {
  return 'tr_' + crypto.randomUUID().replaceAll('-', '').slice(0, 16)
}

export function logEvent(e = {}) {
  const row = { ts: Date.now(), status: 'ok', ...e }
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    const day = new Date(row.ts).toISOString().slice(0, 10)
    fs.appendFileSync(path.join(LOG_DIR, `agent-${day}.jsonl`), JSON.stringify(row) + '\n')
  } catch {}
  try {
    console.log(`[agent] ${row.biz || '-'} ${row.taskId || '-'} ${row.stage || '-'} ${row.status}${row.latencyMs != null ? ` ${row.latencyMs}ms` : ''}${row.error ? ` ERR:${String(row.error).slice(0, 100)}` : ''}`)
  } catch {}
  return row
}

/** 查询日志：读最近两天的 JSONL，倒序，支持 taskId/biz/status 过滤 */
export function queryLogs({ taskId, biz, status, limit = 200 } = {}) {
  const out = []
  const days = [0, 1].map((d) => {
    const t = new Date(Date.now() - d * 86400000)
    return `agent-${t.toISOString().slice(0, 10)}.jsonl`
  })
  for (const f of days) {
    const p = path.join(LOG_DIR, f)
    if (!fs.existsSync(p)) continue
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (taskId && row.taskId !== taskId) continue
        if (biz && row.biz !== biz) continue
        if (status && row.status !== status) continue
        out.push(row)
      } catch {}
    }
  }
  out.sort((a, b) => b.ts - a.ts)
  return { items: out.slice(0, Math.min(limit, 1000)), total: out.length }
}

/** 读某任务的全部日志（任务详情页/排查用） */
export function taskLogs(taskId) {
  return queryLogs({ taskId, limit: 1000 }).items
}
