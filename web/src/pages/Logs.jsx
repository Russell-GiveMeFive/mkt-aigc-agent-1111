import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'

const BIZ = [
  ['', '全部业务'],
  ['l2compose', 'L2 背景合成'],
  ['l3copy', 'L3 文案'],
  ['l3bg', 'L3 背景'],
  ['l3compose', 'L3 合成'],
  ['l3qc', 'L3 QC'],
  ['l4video', 'L4 视频'],
  ['driver', '裸 Agent 调用'],
]

const STATUS_COLOR = { ok: 'var(--ok)', error: 'var(--err)', fallback: 'var(--warn)', empty: 'var(--warn)' }

export default function Logs() {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [taskId, setTaskId] = useState('')
  const [biz, setBiz] = useState('')
  const [onlyErr, setOnlyErr] = useState(false)
  const [expanded, setExpanded] = useState(null)
  const timer = useRef(null)

  const load = async () => {
    const d = await api.logs({ taskId: taskId || undefined, biz: biz || undefined, status: onlyErr ? 'error' : undefined, limit: 300 })
    setItems(d.items || [])
    setTotal(d.total || 0)
  }
  useEffect(() => { load() }, [taskId, biz, onlyErr])
  // 日志页常驻轻轮询（5s），有新日志自动出现
  useEffect(() => {
    clearInterval(timer.current)
    timer.current = setInterval(load, 5000)
    return () => clearInterval(timer.current)
  }, [taskId, biz, onlyErr])

  const fmt = (ts) => {
    const d = new Date(ts)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  }

  return (
    <div>
      <div className="card">
        <h3>运行日志 <span className="mono dim" style={{ fontSize: 10.5 }}>AGENT LOGS · 每次 LLM 调用一条（traceId + 响应 id + 技能注入）</span></h3>
        <div className="dim" style={{ fontSize: 12.5 }}>
          记录每个 AIGC 任务（task/jobId）的阶段流转与每一次 M3/H3 调用：traceId 本服务生成、responseId 是 MiniMax 响应 id（可对账服务端）、skillChars 是本次注入的技能字符量。JSONL 落盘 data/logs/。
        </div>
        <div className="rowFlex" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <input className="input" style={{ width: 240 }} placeholder="按 taskId/jobId 过滤…" value={taskId} onChange={(e) => setTaskId(e.target.value)} />
          <select className="input" style={{ width: 160 }} value={biz} onChange={(e) => setBiz(e.target.value)}>
            {BIZ.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button className={`btn sm ${onlyErr ? 'primary' : ''}`} onClick={() => setOnlyErr(!onlyErr)}>只看异常</button>
          <button className="btn sm" onClick={load}>↻ 刷新</button>
          <span className="dim mono" style={{ fontSize: 11, alignSelf: 'center' }}>{total} 条 · 5s 自动刷新</span>
        </div>
      </div>
      <div className="sectionGap" />
      <div className="card">
        {items.length === 0 ? (
          <div className="emptyState">暂无日志 · 跑一次合成/生成后这里会出现记录</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
              <thead>
                <tr style={{ color: 'var(--ink-faint)', textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
                  <th style={{ padding: '6px 8px' }}>时间</th>
                  <th style={{ padding: '6px 8px' }}>业务</th>
                  <th style={{ padding: '6px 8px' }}>taskId</th>
                  <th style={{ padding: '6px 8px' }}>阶段</th>
                  <th style={{ padding: '6px 8px' }}>状态</th>
                  <th style={{ padding: '6px 8px' }}>traceId / 响应id</th>
                  <th style={{ padding: '6px 8px' }}>耗时</th>
                  <th style={{ padding: '6px 8px' }}>技能</th>
                  <th style={{ padding: '6px 8px' }}>备注/错误</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r, i) => (
                  <React.Fragment key={i}>
                    <tr
                      style={{ borderBottom: '1px solid rgba(168,151,209,0.08)', cursor: 'pointer' }}
                      onClick={() => setExpanded(expanded === i ? null : i)}
                    >
                      <td className="mono" style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{fmt(r.ts)}</td>
                      <td style={{ padding: '6px 8px' }}>{r.biz}</td>
                      <td className="mono dim" style={{ padding: '6px 8px', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.taskId || '—'}</td>
                      <td style={{ padding: '6px 8px' }}>{r.stage || '—'}</td>
                      <td className="mono" style={{ padding: '6px 8px', color: STATUS_COLOR[r.status] || 'var(--ink-dim)' }}>{r.status}</td>
                      <td className="mono dim" style={{ padding: '6px 8px', fontSize: 10.5, maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.traceId || '—'}{r.responseId ? ` / ${r.responseId}` : ''}
                      </td>
                      <td className="mono" style={{ padding: '6px 8px' }}>{r.latencyMs != null ? `${(r.latencyMs / 1000).toFixed(1)}s` : '—'}</td>
                      <td className="mono dim" style={{ padding: '6px 8px' }}>{r.skillChars ? `${r.skillChars}字` : '—'}</td>
                      <td className="dim" style={{ padding: '6px 8px', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: r.status === 'error' ? 'var(--err)' : undefined }}>
                        {r.error || r.note || ''}
                      </td>
                    </tr>
                    {expanded === i && (
                      <tr>
                        <td colSpan={9} style={{ background: 'rgba(124,92,255,0.05)', padding: '10px 14px' }}>
                          <pre className="mono" style={{ fontSize: 10.5, whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(r, null, 2)}</pre>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
