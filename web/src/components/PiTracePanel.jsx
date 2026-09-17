import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'

export default function PiTracePanel({ busy, biz = 'l2compose', title = 'pi 调用记录', subtitle = 'agent · live' }) {
  const [logs, setLogs] = useState([])
  const [open, setOpen] = useState(true)
  const timer = useRef(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const d = await api.logs({ biz, limit: 80 })
        if (alive) setLogs(d.items || [])
      } catch {}
    }
    load()
    timer.current = setInterval(load, busy ? 2000 : 5000)
    return () => { alive = false; clearInterval(timer.current) }
  }, [busy])

  // 按 traceId 分组（保持最新在前）
  const groups = []
  const byTrace = {}
  for (const r of logs) {
    const key = r.traceId || `solo-${r.id || r.ts}`
    if (!byTrace[key]) { byTrace[key] = { traceId: r.traceId, respId: r.responseId, skills: r.skillsLoaded, chars: r.skillChars, rounds: r.rounds, items: [] }; groups.push(byTrace[key]) }
    byTrace[key].items.push(r)
    if (r.responseId) byTrace[key].respId = r.responseId
    if (r.skillsLoaded) byTrace[key].skills = r.skillsLoaded
    if (r.rounds) byTrace[key].rounds = r.rounds
  }

  const fmtT = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}` }
  const dot = (st) => st === 'ok' ? '#54d98c' : st === 'warn' ? '#ffb454' : st === 'error' ? '#ff6b6b' : '#8b8fa3'
  const [expanded, setExpanded] = useState({}) // key → true 展开完整 JSON

  const m3TraceOf = (g) => {
    for (const r of g.items) { if (r.m3Trace && Object.keys(r.m3Trace).length) return r.m3Trace }
    return null
  }

  return (
    <div className="card" style={{ width: 350, flexShrink: 0, position: 'sticky', top: 14, maxHeight: 'calc(100vh - 28px)', display: 'flex', flexDirection: 'column' }}>
      <h3 style={{ marginBottom: 6 }}>{title} <span className="mono dim" style={{ fontSize: 10 }}>{subtitle}</span>
        <button className="chip" style={{ float: 'right', opacity: 0.7 }} onClick={() => setOpen(!open)}>{open ? '收起' : '展开'}</button>
      </h3>
      {open && (
        <div style={{ overflowY: 'auto', flex: 1, minHeight: 260, fontSize: 11.5, lineHeight: 1.5 }}>
          {!groups.length && <div className="dim" style={{ padding: 18, textAlign: 'center' }}>暂无调用 —— 合成一单后这里实时打印 load_skill / 渲染管线 / 兜底全链路</div>}
          {groups.map((g, gi) => {
            const gk = g.traceId || `solo-${gi}`
            const isOpen = !!expanded[gk]
            const m3t = m3TraceOf(g)
            const m3Key = m3t ? Object.entries(m3t).find(([k]) => /trace|request/.test(k)) : null
            return (
            <div key={gi} style={{ borderBottom: '1px solid rgba(255,255,255,0.07)', padding: '8px 2px' }}>
              <div className="mono" style={{ fontSize: 10, marginBottom: 4, cursor: 'pointer', color: '#9aa0b4' }} onClick={() => setExpanded((e) => ({ ...e, [gk]: !isOpen }))} title="点击展开/收起本条全部字段">
                本地trace {g.traceId ? g.traceId.slice(0, 14) : '—'} {g.respId && `· m3Id ${String(g.respId).slice(0, 14)}`}
                <span style={{ float: 'right', opacity: 0.6 }}>{isOpen ? '▾' : '▸'}</span>
              </div>
              {m3Key && <div style={{ marginBottom: 4 }}>
                <span className="mono" style={{ fontSize: 10, color: '#ffd479' }}>M3 {m3Key[0]}={m3Key[1]}</span>
              </div>}
              {(() => {
                const tr = g.items.filter((r) => r.toolUse).length
                const reg = g.items.some((r) => r.toolsRegistered === 0)
                return <div style={{ marginBottom: 4 }}>
                  {tr > 0 && <span className="mono" style={{ fontSize: 10, color: '#c792ea' }}>🔧 function calling ×{tr}轮</span>}
                  {tr > 0 && reg && <span className="mono" style={{ fontSize: 10, color: '#ffb454' }}> · 后续轮无工具</span>}
                  {tr === 0 && reg && <span className="mono dim" style={{ fontSize: 10 }}>（未发生 function calling）</span>}
                  {reg && <span className="mono" style={{ fontSize: 10, color: '#ff9b9b' }}> · tools=[] 全停用</span>}
                </div>
              })()}
              {g.skills && <div style={{ marginBottom: 4 }}>
                <span className="mono" style={{ fontSize: 10, color: '#7fd0ff' }}>skills {g.skills}</span>
                {g.chars ? <span className="mono dim" style={{ fontSize: 10 }}> · {g.chars}字</span> : null}
                {g.rounds ? <span className="mono dim" style={{ fontSize: 10 }}> · {g.rounds}轮</span> : null}
              </div>}
              {g.items.map((r, i) => {
                const rk = `${gk}-${i}`
                const rOpen = !!expanded[rk]
                return (
                <div key={i}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', padding: '1px 0', cursor: 'pointer' }} onClick={() => setExpanded((e) => ({ ...e, [rk]: !rOpen }))}>
                    <span className="mono dim" style={{ fontSize: 10, flexShrink: 0 }}>{fmtT(r.ts)}</span>
                    <span style={{ color: dot(r.status), flexShrink: 0 }}>●</span>
                    <span className="mono" style={{ fontSize: 10.5, flexShrink: 0, color: '#c9cbd6' }}>{r.stage}</span>
                    {r.toolUse && <span className="mono" style={{ fontSize: 9.5, flexShrink: 0, color: '#c792ea', border: '1px solid rgba(199,146,234,0.4)', borderRadius: 4, padding: '0 4px' }}>🔧 FC×{r.toolCalls}</span>}
                    {r.toolsRegistered === 0 && <span className="mono" style={{ fontSize: 9.5, flexShrink: 0, color: '#ff9b9b', border: '1px solid rgba(255,155,155,0.4)', borderRadius: 4, padding: '0 4px' }}>无工具</span>}
                    <span style={{ color: r.status === 'error' ? '#ff9b9b' : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.note || ''}</span>
                  </div>
                  {rOpen && (
                    <pre style={{ margin: '4px 0 6px 22px', padding: 8, background: 'rgba(255,255,255,0.05)', borderRadius: 6, fontSize: 10, overflowX: 'auto', maxHeight: 260, lineHeight: 1.45 }}>{JSON.stringify(r, null, 2)}</pre>
                  )}
                </div>
                )
              })}
              {isOpen && (
                <pre style={{ margin: '4px 0', padding: 8, background: 'rgba(255,255,255,0.05)', borderRadius: 6, fontSize: 10, overflowX: 'auto', maxHeight: 300, lineHeight: 1.45 }}>{JSON.stringify({ traceId: g.traceId, m3Id: g.respId, m3Trace: m3t, skillsLoaded: g.skills, skillChars: g.chars, rounds: g.rounds, events: g.items.length }, null, 2)}</pre>
              )}
            </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
