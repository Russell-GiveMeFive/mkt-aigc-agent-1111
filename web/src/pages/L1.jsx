import React, { useEffect, useRef, useState } from 'react'
import { openPreview } from '../components/Preview.jsx'
import { api } from '../api.js'

export const CATEGORIES = [
  ['plate', '底版图', 'image/*'],
  ['pattern', '花纹', 'image/*'],
  ['arttext', '艺术字字体样式', 'image/*'],
  ['product', '商品图', 'image/*'],
  ['model', '模特图（图/mp4）', 'image/*,video/mp4'],
  ['watermark', '水印', 'image/*'],
  ['labelstyle', '标签样式', 'image/*'],
]

/** 同名素材展示去重：第二个同名起追加 · N（上传批量同名文件时卡片可区分） */
export function withDisplayNames(items) {
  const seen = {}
  return items.map((it) => {
    const n = (seen[it.name] = (seen[it.name] || 0) + 1)
    return n > 1 ? { ...it, name: `${it.name} · ${n}` } : it
  })
}

export function AssetCard({ item, video, selected, onSelect, onDelete, poster , checked, onCheck }) {
  return (
    <div
      className={`pickCard ${poster ? 'poster' : ''} ${selected ? 'sel' : ''} ${checked ? 'checkSel' : ''}`}
      style={{ cursor: onSelect ? 'pointer' : 'pointer' }}
      onClick={onSelect || (() => openPreview(item))}
    >
      {video ? (
        <video src={item.url} muted loop onMouseEnter={(e) => e.target.play()} onMouseLeave={(e) => e.target.pause()} />
      ) : (
        <img src={item.url} alt={item.name} />
      )}
      <button className="pvBtn" title="预览大图" onClick={(e) => { e.stopPropagation(); openPreview(item) }}>⤢</button>
      {onCheck && (
        <span className={`cardCheck ${checked ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); onCheck() }}>{checked ? '✓' : ''}</span>
      )}
      <div className="nm">
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</span>
      </div>
    </div>
  )
}

/** 分页器（列表接口统一分页出参 {items,total,page,pages,hasMore}） */
export function Pager({ page, pages, total, onPage }) {
  if (!pages || pages <= 1) return null
  return (
    <div className="rowFlex" style={{ justifyContent: 'center', marginTop: 14, gap: 10 }}>
      <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ 上一页</button>
      <span className="dim mono" style={{ fontSize: 11 }}>{page} / {pages} 页 · 共 {total} 项</span>
      <button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页 ›</button>
    </div>
  )
}

const PAGE_SIZE = 8

export default function L1() {
  // 每个 category 独立分页：{ [cat]: {items, page, pages, total} }
  const [cats, setCats] = useState({})
  const [busyCat, setBusyCat] = useState(null)
  const [msg, setMsg] = useState('')
  const refs = useRef({})
  const [delSel, setDelSel] = useState({}) // 分类 → 勾选待删 fileIds
  const batchDel = async (key) => {
    const ids = delSel[key] || []
    if (!ids.length) return
    if (!confirm(`删除 ${ids.length} 个素材？`)) return
    for (const fid of ids) { try { await api.deleteL1(fid) } catch (e) { alert(`删除 ${fid} 失败：` + e.message) } }
    setDelSel((m) => ({ ...m, [key]: [] }))
    loadCat(key, 1)
  }

  const loadCat = async (key, page = 1) => {
    const r = await api.l1Assets({ category: key, page, pageSize: PAGE_SIZE })
    setCats((c) => ({ ...c, [key]: { items: r.items || [], page: r.page, pages: r.pages, total: r.total } }))
  }
  const loadAll = () => Promise.all(CATEGORIES.map(([key]) => loadCat(key)))
  useEffect(() => { loadAll() }, [])

  const upload = async (category, files) => {
    if (!files?.length) return
    setBusyCat(category)
    setMsg('')
    try {
      await api.uploadL1([...files], { category })
      await loadCat(category, 1) // 新素材在最前，回第一页
      setMsg(`✓ 已上传 ${files.length} 个${CATEGORIES.find((c) => c[0] === category)?.[1] || ''}`)
    } catch (e) {
      setMsg(`✗ ${e.message}`)
    } finally {
      setBusyCat(null)
      if (refs.current[category]) refs.current[category].value = ''
    }
  }

  return (
    <div>
      <div className="card">
        <h3>L1 · 基础素材 <span className="mono dim" style={{ fontSize: 10.5 }}>LEVEL 1 · 原始素材 · 用户上传</span></h3>
        <div className="dim" style={{ fontSize: 12.5 }}>
          七类原始素材：底版图 / 花纹 / 艺术字字体样式 / 商品图 / 模特图 / 水印 / 标签样式。上传后获得唯一文件标识符（fileId），供 L2 背景合成与 L3 生产管线引用。支持一次多文件批量上传，列表分页查看（每类每页 {PAGE_SIZE} 个）。
        </div>
        {msg && <div className="notice" style={{ marginTop: 10 }}>{msg}</div>}
      </div>
      <div className="sectionGap" />

      {CATEGORIES.map(([key, label, accept]) => {
        const st = cats[key] || { items: [], total: 0 }
        return (
          <div key={key}>
            <div className="card">
              <h3 style={{ margin: 0 }}>
                {label} <span className="mono dim" style={{ fontSize: 10.5 }}>{key} · {st.total}</span>
                <span style={{ flex: 1 }} />
                {(delSel[key] || []).length > 0 && (
                  <button className="btn sm" style={{ borderColor: '#f472b6', color: '#f9a8d4' }} disabled={busyCat === key} onClick={() => batchDel(key)}>删除选中 ({(delSel[key] || []).length})</button>
                )}
                <button className="btn sm" disabled={busyCat === key} onClick={() => refs.current[key]?.click()}>
                  {busyCat === key ? <span className="spin" /> : '＋'} 批量上传
                </button>
                <input ref={(el) => (refs.current[key] = el)} type="file" accept={accept} multiple hidden onChange={(e) => upload(key, e.target.files)} />
              </h3>
              <div className="sectionGap" />
              {st.items.length === 0 ? (
                <div className="emptyState" style={{ padding: '10px 0' }}>暂无素材</div>
              ) : (
                <>
                  <div className="pickGrid">
                    {withDisplayNames(st.items).map((a) => (
                      <AssetCard
                        key={a.fileId}
                        item={a}
                        video={a.fileId.endsWith('.mp4')}
                        checked={(delSel[key] || []).includes(a.fileId)}
                        onCheck={() => setDelSel((m) => { const cur = m[key] || []; return { ...m, [key]: cur.includes(a.fileId) ? cur.filter((x) => x !== a.fileId) : [...cur, a.fileId] } })}
                      />
                    ))}
                  </div>
                  <Pager page={st.page} pages={st.pages} total={st.total} onPage={(p) => loadCat(key, p)} />
                </>
              )}
            </div>
            <div className="sectionGap" />
          </div>
        )
      })}
    </div>
  )
}
