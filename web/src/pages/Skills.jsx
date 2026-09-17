import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'

const SCOPE_LABELS = { all: '全部（文案+HTML+QC）', html: 'HTML 生成（L2）', copy: '文案生成', qc: 'QC 裁判' }

export default function Skills() {
  const [items, setItems] = useState([])
  const [busy, setBusy] = useState(false)
  const [busyAll, setBusyAll] = useState(false)
  const [scope, setScope] = useState('all')
  const [preview, setPreview] = useState(null) // { name, scope, enabled, content }
  const [previewLoading, setPreviewLoading] = useState(false)
  const fileRef = useRef(null)

  const load = async () => setItems((await api.skills()).items || [])
  useEffect(() => { load() }, [])

  const upload = async (files) => {
    if (!files?.length) return
    setBusy(true)
    try {
      const r = await api.uploadSkills([...files], null, scope)
      const errs = r.items.filter((x) => x.error)
      if (errs.length) alert(errs.map((x) => x.error).join('\n'))
      await load()
    } catch (e) {
      alert(e.message)
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const setAll = async (enabled) => {
    setBusyAll(true)
    try {
      await Promise.all(items.map((x) => api.setSkillEnabled(x.id, enabled)))
      await load()
    } finally {
      setBusyAll(false)
    }
  }

  const openPreview = async (s) => {
    setPreviewLoading(true)
    try {
      const r = await api.getSkillContent(s.id)
      setPreview({ name: s.name, scope: s.scope, enabled: s.enabled, content: r.content || '' })
    } catch (e) {
      alert(e.message)
    } finally {
      setPreviewLoading(false)
    }
  }

  return (
    <div>
      <div className="card">
        <h3>技能 <span className="mono dim" style={{ fontSize: 10.5 }}>SKILLS · 注入 pi Agent</span></h3>
        <div className="dim" style={{ fontSize: 12.5 }}>
          上传 Markdown 技能文档（.md / .txt），启用的技能按 scope 注入 pi Agent 上下文：<b>HTML 生成</b>（L2 背景合成引擎）、<b>文案生成</b>、<b>QC 裁判</b>或全部。点击技能名称可预览全文。
        </div>
      </div>
      <div className="sectionGap" />

      <div className="card">
        <div className="rowFlex" style={{ gap: 10 }}>
          <button className="btn primary" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? <span className="spin" /> : '＋'} 上传技能（可多选）
          </button>
          <select className="input" style={{ width: 210 }} value={scope} onChange={(e) => setScope(e.target.value)}>
            {Object.entries(SCOPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input ref={fileRef} type="file" accept=".md,.txt" multiple hidden onChange={(e) => upload(e.target.files)} />
          <span style={{ flex: 1 }} />
          <span className="dim" style={{ fontSize: 12 }}>{items.length} 个技能 · {items.filter((x) => x.enabled).length} 个已启用</span>
          <button className="btn sm" disabled={busyAll || !items.length} onClick={() => setAll(true)}>{busyAll ? '…' : '☑ 全部启用'}</button>
          <button className="btn sm" disabled={busyAll || !items.length} onClick={() => setAll(false)}>☐ 全部停用</button>
        </div>
        <div className="sectionGap" />
        {items.length === 0 ? (
          <div className="emptyState">还没有技能 · 例如上传「双11 HTML 背景合成规范.md」（scope=HTML）</div>
        ) : (
          items.map((s) => (
            <div key={s.id} className="rowFlex" style={{ borderBottom: '1px solid var(--line)', padding: '10px 0', gap: 10 }}>
              <span style={{ fontSize: 16 }}>{s.enabled ? '🟢' : '⚪'}</span>
              <div
                style={{ flex: 1, cursor: 'pointer', minWidth: 0 }}
                onClick={() => openPreview(s)}
                title="点击预览全文"
              >
                <div style={{ fontSize: 13.5, fontWeight: 600, textDecoration: previewLoading ? 'none' : undefined }}>{s.name}</div>
                <div className="mono dim" style={{ fontSize: 10.5 }}>{s.id} · {s.filename} · {(s.size / 1024).toFixed(1)}KB</div>
              </div>
              <select
                className="input"
                style={{ width: 180, fontSize: 12 }}
                value={(s.scope || ['all']).includes('all') ? 'all' : (s.scope || [])[0]}
                onChange={async (e) => { await api.setSkillScope(s.id, e.target.value); load() }}
              >
                {Object.entries(SCOPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <button className="btn sm" onClick={async () => { await api.setSkillEnabled(s.id, !s.enabled); load() }}>{s.enabled ? '停用' : '启用'}</button>
              <button className="btn sm" onClick={async () => { if (confirm(`删除技能 ${s.name}?`)) { await api.deleteSkill(s.id); load() } }}>删除</button>
            </div>
          ))
        )}
      </div>

      {previewLoading && <div className="notice" style={{ marginTop: 12, padding: '6px 12px' }}>正在加载技能全文…</div>}

      {preview && (
        <div
          onClick={() => setPreview(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(5,3,12,0.72)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: 'var(--bg2, #120d1e)', border: '1px solid var(--line)', borderRadius: 16, width: 'min(880px, 100%)', maxHeight: '84vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 80px rgba(0,0,0,0.5)' }}
          >
            <div className="rowFlex" style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', gap: 12 }}>
              <b style={{ fontSize: 14 }}>{preview.name}</b>
              <span className="mono dim" style={{ fontSize: 10.5 }}>{(preview.scope || ['all']).map((x) => SCOPE_LABELS[x] || x).join(' / ')} · {preview.enabled ? '已启用' : '已停用'} · {(preview.content.length / 1024).toFixed(1)}KB</span>
              <span style={{ flex: 1 }} />
              <button className="btn sm" onClick={() => setPreview(null)}>关闭 ✕</button>
            </div>
            <pre style={{ margin: 0, padding: '16px 20px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12.5, lineHeight: 1.75, color: 'var(--ink, #efeaf7)' }}>{preview.content}</pre>
          </div>
        </div>
      )}
    </div>
  )
}
