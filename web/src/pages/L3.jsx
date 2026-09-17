import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { AssetCard, Pager, withDisplayNames } from './L1.jsx'
import { openPreview } from '../components/Preview.jsx'

const EMPTY_SLOTS = { headline: '', productName: '', price: '', oldPrice: '', cta: '立即抢购', promo: '' }

function JobRow({ job }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ borderBottom: '1px solid var(--line)', padding: '10px 0' }}>
      <div className="rowFlex" style={{ gap: 8, alignItems: 'center' }}>
        <span className={`tag ${job.status === 'done' ? 'ok' : job.status === 'failed' ? 'err' : 'run'}`}>
          {job.status === 'running' ? 'RUNNING' : job.status?.toUpperCase()}
        </span>
        <span className="mono dim" style={{ fontSize: 11 }}>{job.jobId}</span>
        <span className="dim" style={{ fontSize: 12 }}>{job.name || ''}</span>
        <span style={{ flex: 1 }} />
        {job.usable != null && (
          <span className={`tag ${job.usable ? 'ok' : 'err'}`} style={{ fontSize: 10 }}>
            {job.usable ? '可用' : '不合格'} · {job.qcScore}
          </span>
        )}
        {job.l3Url && <a className="link mono" style={{ fontSize: 11 }} href={job.l3Url} target="_blank" rel="noreferrer">海报 ↗</a>}
        <button className="btn sm" onClick={() => setOpen(!open)}>{open ? '收起' : '详情'}</button>
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div className="stageRail">
            {(job.stages || []).map((s, i) => (
              <React.Fragment key={s.key}>
                {i > 0 && <span className="stageArrow">→</span>}
                <span className={`stage ${s.status}`} title={s.note || ''}>
                  {s.status === 'running' && <span className="spin" />}{s.key}{s.status === 'done' && ' ✓'}{s.status === 'failed' && ' ×'}
                </span>
              </React.Fragment>
            ))}
          </div>
          {job.qc?.slice(-1).map(({ verdict }, i) => (
            <div key={i} style={{ marginTop: 8 }}>
              {verdict?.defects?.length
                ? verdict.defects.map((d, j) => (
                  <div key={j} style={{ fontSize: 11.5, color: d.severity === 'high' ? 'var(--err)' : 'var(--warn)' }}>
                    ▸ [{d.severity}] {d.code} — {d.note}
                  </div>
                ))
                : <div className="dim" style={{ fontSize: 11.5 }}>无缺陷</div>}
            </div>
          ))}
          {job.error && <div className="notice err" style={{ marginTop: 8 }}>{job.error}</div>}
        </div>
      )}
    </div>
  )
}

export default function L3({ goTab }) {
  const [l2pipeline, setL2pipeline] = useState([])
  const [l1, setL1] = useState([])
  const [assets, setAssets] = useState({ items: [], page: 1, pages: 1, total: 0 })
  const [jobs, setJobs] = useState({ items: [], page: 1, pages: 1, total: 0 })
  const [assetPage, setAssetPage] = useState(1)
  const [jobPage, setJobPage] = useState(1)
  const [bgId, setBgId] = useState('')
  const [productId, setProductId] = useState('')
  const [modelId, setModelId] = useState('')
  const [slots, setSlots] = useState({ ...EMPTY_SLOTS })
  const [generateVideo, setGenerateVideo] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reworkL3, setReworkL3] = useState('')
  const [reworkProduct, setReworkProduct] = useState('')
  const [pending, setPending] = useState([]) // 已提交未完成的合成任务（海报库 loading 占位）
  const pollRef = useRef(null)

  const load = async () => {
    const [p, l, a, j] = await Promise.all([
      api.l2Assets({ pipeline: 1, pageSize: 200 }),
      api.l1Assets({ pageSize: 500 }),
      api.l3Assets({ page: assetPage, pageSize: 12 }),
      api.l3Jobs({ page: jobPage, pageSize: 8 }),
    ])
    setL2pipeline(p.items || [])
    setL1(l.items || [])
    setAssets(a)
    setJobs(j)
  }
  useEffect(() => { load() }, [assetPage, jobPage])

  useEffect(() => {
    clearInterval(pollRef.current)
    // 有运行中任务或未完成的占位 → 持续轮询
    if (!pending.length && !jobs.items?.some((x) => x.status === 'running' || x.status === 'queued')) return
    pollRef.current = setInterval(load, 2500)
    return () => clearInterval(pollRef.current)
  }, [jobs, pending])

  // 占位卡对账：job 完成（done 且已落库）→ 从 pending 移除（海报此时已出现在列表）
  useEffect(() => {
    if (!pending.length) return
    const doneIds = new Set((jobs.items || []).filter((x) => x.status === 'done' && x.l3Url).map((x) => x.jobId))
    const gone = (jobs.items || []).filter((x) => x.status === 'failed' || x.status === 'cancelled').map((x) => x.jobId)
    const next = pending.filter((p) => !doneIds.has(p.jobId) && !gone.includes(p.jobId) && Date.now() - p.t < 15 * 60 * 1000)
    if (next.length !== pending.length) setPending(next)
  }, [jobs, pending])

  const products = l1.filter((x) => x.category === 'product')
  const models = l1.filter((x) => x.category === 'model' && !x.fileId.endsWith('.mp4'))

  const directSave = async () => {
    if (!bgId) return alert('先选择一个生产管线背景')
    setBusy(true)
    try {
      const r = await api.l3Direct({ bgFileId: bgId, name: undefined })
      load()
      setTimeout(load, 400)
      setBusy(false)
    } catch (e) {
      setBusy(false)
      alert('直通失败：' + e.message)
    }
  }

  const generate = async () => {
    if (!bgId) return alert('选择一个生产管线背景')
    setBusy(true)
    try {
      const r = await api.l3Generate({ bgFileId: bgId, productFileId: productId, modelFileId: modelId || undefined, copySlots: slots, generateVideo })
      // 提交即入库占位：jobId 关联，完成（done+l3Url）后由轮询自动移除
      setPending((p) => [...p, { jobId: r.jobId, name: slots.productName || slots.headline || '生产管线海报', t: Date.now() }])
      setBusy(false)
    } catch (e) {
      alert(e.message)
      setBusy(false)
    }
  }

  const rework = async () => {
    if (!reworkL3 || !reworkProduct) return alert('选择海报与新的商品图')
    setBusy(true)
    try {
      const r = await api.l3Rework({ l3FileId: reworkL3, productFileId: reworkProduct })
      setPending((p) => [...p, { jobId: r.jobId, name: '再加工海报', t: Date.now() }])
    } catch (e) {
      alert(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="card">
        <h3>L3 · 海报合成 - 二次加工 <span className="mono dim" style={{ fontSize: 10.5 }}>LEVEL 3 · 严格版式合成 + QC 裁判</span></h3>
        <div className="dim" style={{ fontSize: 12.5 }}>
          三部分：<b>① 管线生成</b> —— L2 中标记「生产管线」的背景 + 商品 + 模特 + 文案槽位 → 合成 + QC 裁判 + 修复 ≤2 轮 → 存 L3 桶；<b>⤴ 直通</b> —— 不选商品/模特，选中 L2 背景「直接作为最终海报」存 L3 桶；<b>② 再加工</b> —— 对已有海报更换商品图重新合成。
        </div>
      </div>
      <div className="sectionGap" />

      <div className="grid2 grid2-gen">
        <div className="card">
          <h3>① 管线生成 <span className="mono dim" style={{ fontSize: 10.5 }}>GENERATE</span></h3>
          <div className="subHead"><b>生产管线背景</b> L2 · 已标记</div>
          <div className="pickGrid pickScroll">
            {l2pipeline.map((a) => (
              <AssetCard key={a.fileId} item={a} poster selected={bgId === a.fileId} onSelect={() => setBgId(a.fileId)} />
            ))}
            {!l2pipeline.length && (
              <div className="jumpHint">
                <span style={{ flex: 1 }}>还没有背景加入生产管线 · 在「商品海报合成」合成后一键标记</span>
                <button className="btn sm primary" onClick={() => goTab?.('l2')}>去合成并标记 →</button>
              </div>
            )}
          </div>
          <div className="sectionGap" />
          <div className="subHead"><b>商品图</b> L1 · 可选（不选 = 仅用背景重新排版）</div>
          <div className="pickGrid pickScroll">
            <div className={`emptySlot ${productId === '' ? 'sel' : ''}`} onClick={() => setProductId('')}>
              <span className="ico">⌀</span>
              不用商品图
            </div>
            {withDisplayNames(products).map((a) => (
              <AssetCard key={a.fileId} item={a} selected={productId === a.fileId} onSelect={() => setProductId(productId === a.fileId ? '' : a.fileId)} />
            ))}
            {!products.length && <div className="jumpHint">基础素材页还没有商品图 · 去上传</div>}
          </div>
          <div className="sectionGap" />
          <div className="subHead"><b>模特图</b> L1 · 可选</div>
          <div className="pickGrid pickScroll">
            <div className={`emptySlot ${modelId === '' ? 'sel' : ''}`} onClick={() => setModelId('')}>
              <span className="ico">⌀</span>
              不用模特
            </div>
            {withDisplayNames(models).map((a) => (
              <AssetCard key={a.fileId} item={a} selected={modelId === a.fileId} onSelect={() => setModelId(a.fileId)} />
            ))}
          </div>
        </div>

        <div className="card">
          <h3>文案槽位 <span className="mono dim" style={{ fontSize: 10.5 }}>COPY SLOTS</span></h3>
          {[['headline', '主标题（可用换行分两行）'], ['productName', '商品名'], ['price', '到手价'], ['oldPrice', '划线原价'], ['cta', '行动号召'], ['promo', '促销标签']].map(([k, label]) => (
            <label key={k} className="f" style={{ display: 'block', marginBottom: 8 }}>
              <span>{label}</span>
              {k === 'headline'
                ? <textarea className="input" rows={2} style={{ width: '100%', resize: 'vertical' }} value={slots[k]} onChange={(e) => setSlots({ ...slots, [k]: e.target.value })} />
                : <input className="input" style={{ width: '100%' }} value={slots[k]} onChange={(e) => setSlots({ ...slots, [k]: e.target.value })} />}
            </label>
          ))}
          <label className="checkboxRow" style={{ margin: '10px 0' }}>
            <input type="checkbox" checked={generateVideo} onChange={(e) => setGenerateVideo(e.target.checked)} />
            生成后直接送 L4 合成 5s 视频
          </label>
          <button className="btn primary" disabled={busy} onClick={generate}>{busy ? <span className="spin" /> : '▶'} 运行生产管线</button>
          <button className="btn" disabled={busy} onClick={directSave} style={{ marginLeft: 8 }} title="不选商品/模特，把当前选中的 L2 背景直接存为 L3 最终海报">⤴ 直接作为最终海报（跳过合成）</button>

          <div className="sectionGap" />
          <h3>② 再加工 <span className="mono dim" style={{ fontSize: 10.5 }}>换商品图</span></h3>
          <select className="input" style={{ width: '100%', marginBottom: 8 }} value={reworkL3} onChange={(e) => setReworkL3(e.target.value)}>
            <option value="">选择已有海报…</option>
            {assets.items.filter((a) => a.usable).map((a) => <option key={a.fileId} value={a.fileId}>{a.name}（{a.qcScore}分）</option>)}
          </select>
          <select className="input" style={{ width: '100%', marginBottom: 10 }} value={reworkProduct} onChange={(e) => setReworkProduct(e.target.value)}>
            <option value="">换成的商品图…</option>
            {products.map((a) => <option key={a.fileId} value={a.fileId}>{a.name}</option>)}
          </select>
          <button className="btn" disabled={busy} onClick={rework}>↻ 再加工</button>
        </div>
      </div>
      <div className="sectionGap" />

      <div className="card">
        <h3>海报库 <span className="mono dim" style={{ fontSize: 10.5 }}>{assets.total}</span></h3>
        {assets.items.length === 0 ? (
          <div className="emptyState">还没有海报</div>
        ) : (
          <>
            <div className="pickGrid">
              {pending.map((p) => (
                <div key={p.jobId} className="pendingCard" title={`任务 ${p.jobId} 进行中`}>
                  <span className="spin" />
                  合成中…
                  <span className="nm2">{p.name}</span>
                </div>
              ))}
              {withDisplayNames(assets.items).map((a) => (
                <div key={a.fileId} className="pickCard poster" style={{ position: 'relative' }} onClick={() => openPreview(a)}>
                  <img src={a.url} alt={a.name} />
                  <button className="pvBtn" title="预览大图" onClick={(e) => { e.stopPropagation(); openPreview(a) }}>⤢</button>
                  <span className={`tag ${a.usable ? 'ok' : a.usable === false ? 'err' : ''}`} style={{ position: 'absolute', top: 6, left: 6, fontSize: 9 }}>
                    {a.usable == null ? '—' : `${a.usable ? '可用' : '不合格'} ${a.qcScore ?? ''}`}
                  </span>
                  <div className="nm">
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span>
                    <button className="del" onClick={async (e) => { e.stopPropagation(); if (confirm(`删除 ${a.name}?`)) { try { await api.deleteL3(a.fileId) } catch (err) { alert('删除失败：' + err.message) } load() } }}>×</button>
                  </div>
                </div>
              ))}
            </div>
            <Pager page={assets.page} pages={assets.pages} total={assets.total} onPage={(p) => setAssetPage(p)} />
          </>
        )}
      </div>
      <div className="sectionGap" />

      <div className="card">
        <h3>生成任务 <span className="mono dim" style={{ fontSize: 10.5 }}>{jobs.total}</span></h3>
        {jobs.items.length === 0 ? (
          <div className="emptyState">暂无任务</div>
        ) : (
          <>
            {jobs.items.map((j) => <JobRow key={j.jobId} job={j} />)}
            <Pager page={jobs.page} pages={jobs.pages} total={jobs.total} onPage={(p) => setJobPage(p)} />
          </>
        )}
      </div>
    </div>
  )
}
