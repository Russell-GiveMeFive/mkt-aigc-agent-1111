import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { AssetCard, CATEGORIES, Pager } from './L1.jsx'
import { openPreview } from '../components/Preview.jsx'
import PiTracePanel from '../components/PiTracePanel.jsx'

/** 默认合成指令（与服务端 L2_TEMPLATES[0] 同步维护；useState 初始即填，不依赖异步接口）
 * 文案写在「」里会被系统精确渲染（代码级文字层）；「」外是视觉指令 */
const DEFAULT_INSTRUCTION = `生成完整海报（完整海报模式）。
门头「京东七夕节」日期「8.4—8.19」
主标题「七夕送礼上京东」副标题「1元心意好礼」
卖点「官方正品|7天无理由|一年质保」
到手价「¥199」原价「¥399」底行「每日10点开抢 · 全场满199减50」
主色「#e0417e」辅助「#d9a441」氛围「樱花粉渐变 #ffd9e8 → #ffabc8」
商品：居中悬浮 + 光雾底座，放底版的视觉焦点位置；按五段节奏饱满排布`

export default function L2() {
  const [lib, setLib] = useState({ items: [], page: 1, pages: 1, total: 0 })
  const [delSel2, setDelSel2] = useState([])
  const [libPage, setLibPage] = useState(1)
  const [l1, setL1] = useState([])
  const [selMap, setSelMap] = useState({}) // category → fileId（每类单选）
  const [instruction, setInstruction] = useState(DEFAULT_INSTRUCTION)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [showHtml, setShowHtml] = useState(false)
  const [mode, setMode] = useState('ai') // 样式合成已隐藏（保留 API 能力），UI 固定走 AI 合成
  const [pending, setPending] = useState([]) // 已提交未完成的合成任务（素材库 loading 占位）
  const [templates, setTemplates] = useState([])
  const selCount = Object.keys(selMap).length

  const loadPicker = async () => setL1((await api.l1Assets({ pageSize: 500 })).items || [])
  const loadLib = async (p = libPage) => setLib(await api.l2Assets({ page: p, pageSize: 12 }))
  useEffect(() => { loadPicker(); loadLib(1); api.prompts().then((r) => { setTemplates(r.templates || []); setInstruction(r.templates?.[0]?.text || '') }).catch(() => {}) }, []) // 页面加载总是回默认模板

  const load = () => { loadPicker(); loadLib() }

  const toggle = (cat, fileId) => setSelMap((m) => {
    const next = { ...m }
    if (next[cat] === fileId) delete next[cat]
    else next[cat] = fileId
    return next
  })

  // 提交即返回：后台合成（~2min），素材库显示占位卡，完成后自动替换为成品
  const compose = async () => {
    if (!selCount) return alert('先在下方每个类别中各选一个素材')
    const key = `c${Date.now()}`
    let ids = Object.values(selMap)
    const nm = name
    // 含模特图时样式合成（模板直出，无 LLM/无技能/版式无模特位）给不了模特效果 → 自动切 AI 合成
    let useMode = mode
    const hasModelPick = ids.some((fid) => (l1 || []).some((m) => m.fileId === fid && m.category === 'model'))
    if (hasModelPick && mode === 'template') {
      useMode = 'ai'
      alert('已选择模特图：样式合成的固定版式不支持模特，本次自动切换为「AI 合成」（加载模特海报技能）。')
    }
    setResult(null)
    setPending((p) => [...p, { key, name: nm || 'LLM 合成背景' }])
    setSelMap({})
    setName('')
    api.composeBg({ itemIds: ids, instruction, name: nm || undefined, mode: useMode })
      .then((r) => setResult(r))
      .catch((e) => alert(`合成失败: ${e.message}`))
      .finally(() => {
        setPending((p) => p.filter((x) => x.key !== key))
        setBusy(false)
        loadLib(1)
      })
    setBusy(true)
  }

  const togglePipeline = async (item) => {
    await api.setPipeline([item.fileId], !item.pipeline)
    loadLib()
  }

  const items = lib.items || []

  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
      <div className="card">
        <h3>L2 · 商品海报合成 <span className="mono dim" style={{ fontSize: 10.5 }}>LEVEL 2 · 自然语言驱动合成</span></h3>
        {/* 样式合成（template 直出）暂时下线：固定走 AI 合成；mode=template 的 API 能力保留，需要时恢复此块并改回默认 mode */}
        <div className="dim" style={{ fontSize: 12.5 }}>
          按类别各选一个 L1 基础素材 + 一句自然语言描述 → LLM 生成 HTML（绝对定位精细控制）→ 浏览器截图 → 存入 L2 桶。标记「生产管线」的背景才能进入 L3 海报生成。
        </div>
      </div>
      <div className="sectionGap" />

      <div className="card">
        <h3>背景合成 <span className="mono dim" style={{ fontSize: 10.5 }}>COMPOSE</span></h3>
        {CATEGORIES.filter(([key]) => key !== 'model').map(([key, label]) => {
          const list = l1.filter((a) => a.category === key)
          const picked = selMap[key]
          return (
            <div key={key} style={{ marginBottom: 14 }}>
              <div className="rowFlex" style={{ gap: 8, marginBottom: 6 }}>
                <span className={`tag ${picked ? 'ok' : ''}`} style={{ fontSize: 10.5 }}>{label}</span>
                <span className="mono dim" style={{ fontSize: 10 }}>{list.length} 个 · {picked ? '已选' : '未选（可选）'}</span>
                {picked && <button className="btn sm" style={{ padding: '1px 8px', fontSize: 10.5 }} onClick={() => toggle(key, picked)}>取消</button>}
              </div>
              {list.length === 0 ? (
                <div className="dim" style={{ fontSize: 11.5, opacity: 0.6 }}>—— 暂无该类别素材 ——</div>
              ) : (
                <div className="pickGrid">
                  {list.map((a) => (
                    <AssetCard key={a.fileId} item={a} video={a.fileId.endsWith('.mp4')} poster selected={picked === a.fileId} onSelect={() => toggle(key, a.fileId)} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
        <div className="sectionGap" />
        <div className="rowFlex" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          <span className="mono dim" style={{ fontSize: 10.5, alignSelf: 'center' }}>场景模板</span>
          {(templates || []).map((t) => (
            <button
              key={t.id}
              className="btn sm"
              style={instruction === t.text ? { borderColor: 'var(--violet)', color: '#fff', background: 'rgba(124,92,255,0.18)' } : undefined}
              onClick={() => setInstruction(instruction === t.text ? '' : t.text)}
              title="点击填入，再微调价格/文案后提交"
            >
              {t.name}
            </button>
          ))}
        </div>
        <textarea
          className="input"
          rows={8}
          style={{ width: '100%', resize: 'vertical' }}
          placeholder='点上方场景模板一键填入，或直接写自然语言合成指令，例：底版铺满整张背景，金色粒子以 25% 透明度平铺，艺术字放在上方居中'
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
        <div className="rowFlex" style={{ gap: 8, marginTop: 10 }}>
          <input className="input" style={{ width: 220 }} placeholder="背景名称（可选）" value={name} onChange={(e) => setName(e.target.value)} />
          <span style={{ flex: 1 }} />
          <button className="btn primary" disabled={busy || !selCount} onClick={compose}>
            {busy ? <span className="spin" /> : '◈'} {busy ? 'LLM 生成 HTML → 截图中…' : `合成背景图（已选 ${selCount} 类）`}
          </button>
        </div>
        {result && (
          <div className="rowFlex" style={{ gap: 12, marginTop: 14, alignItems: 'flex-start' }}>
            <img src={result.url} alt={result.name} style={{ width: 150, height: 300, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--line)' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>✓ 已存入 L2 桶</div>
              <div className="mono dim" style={{ fontSize: 11, margin: '4px 0 8px' }}>{result.fileId} · 引擎: {result.source}</div>
              <button className="btn sm" onClick={() => api.setPipeline([result.fileId], true).then(load)}>⚑ 加入生产管线</button>
              <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setShowHtml(!showHtml)}>{showHtml ? '隐藏' : '查看'} HTML</button>
              {showHtml && (
                <pre className="mono" style={{ fontSize: 10, marginTop: 8, maxHeight: 200, overflow: 'auto', background: 'rgba(0,0,0,0.3)', padding: 8, borderRadius: 8 }}>{result.html}</pre>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="sectionGap" />

      <div className="card">
        <h3>合成素材库 <span className="mono dim" style={{ fontSize: 10.5 }}>{lib.total}</span>
          {(delSel2 || []).length > 0 && (
            <button className="btn sm" style={{ marginLeft: 10, borderColor: '#f472b6', color: '#f9a8d4' }} onClick={async () => {
              if (!confirm(`删除 ${delSel2.length} 个合成素材？`)) return
              for (const fid of delSel2) { try { await api.deleteL2(fid) } catch (e) { alert(`删除 ${fid} 失败：` + e.message) } }
              setDelSel2([]); loadLib()
            }}>删除选中 ({delSel2.length})</button>
          )}
        </h3>
        {items.length === 0 ? (
          <div className="emptyState">还没有合成背景</div>
        ) : (
          <>
            <div className="pickGrid">
              {pending.map((p) => (
                <div key={p.key} className="pendingCard" title="LLM 生成 HTML → 截图，约 1-3 分钟">
                  <span className="spin" />
                  合成中…
                  <span className="nm2">{p.name}</span>
                </div>
              ))}
              {items.map((a) => (
                <div key={a.fileId} className={`pickCard poster ${(delSel2 || []).includes(a.fileId) ? 'checkSel' : ''}`} style={{ position: 'relative' }} onClick={() => openPreview(a)}>
                  <img src={a.url} alt={a.name} />
                  <button className="pvBtn" title="预览大图" onClick={(e) => { e.stopPropagation(); openPreview(a) }}>⤢</button>
                  {a.pipeline && <span className="tag ok" style={{ position: 'absolute', top: 6, left: 6, fontSize: 9 }}>生产管线</span>}
                  <span className={`cardCheck ${(delSel2 || []).includes(a.fileId) ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setDelSel2((m) => m.includes(a.fileId) ? m.filter((x) => x !== a.fileId) : [...m, a.fileId]) }}>{(delSel2 || []).includes(a.fileId) ? '✓' : ''}</span>
                  <div className="nm">
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span>
                  </div>
                  <div style={{ padding: '0 8px 8px' }}>
                    <button className={`btn sm ${a.pipeline ? '' : 'primary'}`} style={{ width: '100%' }} onClick={() => togglePipeline(a)}>
                      {a.pipeline ? '退出生产管线' : '加入生产管线'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <Pager page={lib.page} pages={lib.pages} total={lib.total} onPage={(p) => { setLibPage(p); loadLib(p) }} />
          </>
        )}
      </div>
      </div>
      <PiTracePanel busy={busy} />
    </div>
  )
}
