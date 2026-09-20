import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

const OSS_ONLY = ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey', 'region', 'publicBaseUri']
const FIELD_LABELS = { endpoint: 'Endpoint', bucket: 'Bucket 名', accessKeyId: 'AccessKeyId', secretAccessKey: 'SecretAccessKey', region: 'Region', publicBaseUri: '公共访问前缀' }
const BUCKET_LABELS = { l1: '素材桶 · 原始素材', l2: '海报桶 · 生产管线海报', l4: '视频桶 · mp4（taskId 命名）' } // 三桶制：l3 桶已停用（历史数据保留）

export default function Settings() {
  const [s, setS] = useState(null)
  const [keyInput, setKeyInput] = useState('') // 用户正在输入的新 Key（空 = 未编辑）
  const [showKey, setShowKey] = useState(false) // 点击显示
  const [revealedKey, setRevealedKey] = useState('') // 从服务端取回的完整 Key
  const [showSec, setShowSec] = useState({}) // 各桶 secretAccessKey 显示开关
  const [msg, setMsg] = useState('')
  const [test, setTest] = useState({})
  const [saving, setSaving] = useState(false)

  const load = async () => setS(await api.settings())
  useEffect(() => { load() }, [])
  if (!s) return <div className="emptyState">加载中…</div>

  const set = (patch) => setS({ ...s, ...patch })
  const setBucket = (b, patch) => setS({ ...s, buckets: { ...s.buckets, [b]: { ...s.buckets[b], ...patch } } })

  const MASK = '••••••••••'
  const keyDisplaying = !!s.hasKey && !keyInput // 填写框处于「展示已存 Key」状态
  const keyBoxValue = keyDisplaying ? (showKey ? revealedKey : `${MASK}${s.keyTail || ''}`) : keyInput

  const toggleShowKey = async () => {
    if (!revealedKey) {
      try {
        const full = await api.revealSettings()
        setRevealedKey(full.apiKey || '')
      } catch (e) {
        setMsg(`✗ 读取 Key 失败：${e.message}`)
        return
      }
    }
    setShowKey(!showKey)
  }

  const save = async () => {
    setSaving(true)
    setMsg('')
    try {
      const patch = {
        baseUrl: s.baseUrl, textModel: s.textModel, videoModel: s.videoModel,
        videoResolution: s.videoResolution, qcModel: s.qcModel, maxRepairRounds: s.maxRepairRounds,
        concurrency: s.concurrency, mock: s.mock, apiKeys: s.apiKeys, buckets: s.buckets,
      }
      if (keyInput) patch.apiKey = keyInput // 只在用户输入时提交，避免覆盖已有 Key
      await api.saveSettings(patch)
      await load()
      setKeyInput('')
      // 保存后自动拉取：所有 OSS 桶把桶内已有内容对账进素材库
      const ossBuckets = Object.entries(s.buckets || {}).filter(([, cfg]) => cfg.driver === 'oss' && cfg.endpoint && cfg.bucket)
      if (ossBuckets.length) {
        const parts = []
        for (const [b] of ossBuckets) {
          setMsg(`正在从 OSS 拉取 ${BUCKET_LABELS[b]}…`)
          try {
            const r = await api.syncBucket(b)
            parts.push(`${BUCKET_LABELS[b]} 拉取 ${r.objects} 个对象（新增索引 ${r.added}）`)
          } catch (e) {
            parts.push(`${BUCKET_LABELS[b]} 拉取失败：${e.message}`)
          }
        }
        setMsg(`✓ 设置已保存并持久化 · ${parts.join(' · ')}`)
      } else {
        setMsg('✓ 设置已保存并持久化（data/settings.json）')
      }
    } catch (e) {
      setMsg(`✗ ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  const testOne = async (b, formDriver) => {
    setTest({ ...test, [b]: { loading: true } })
    try {
      const r = await api.testBucket(b)
      // 测的是「已保存」配置——表单改过未保存时会测旧值，明确提示避免误解
      const stale = formDriver && r.driver && formDriver !== r.driver
      setTest({ ...test, [b]: { ok: r.ok, text: `${r.driver} · ${r.objects} 个对象${stale ? ' ⚠️ 表单已改但未保存——先点「保存设置」再测' : ''}` } })
    } catch (e) {
      setTest({ ...test, [b]: { ok: false, text: e.message } })
    }
  }

  const syncOne = async (b) => {
    setTest({ ...test, [b]: { syncing: true } })
    try {
      const r = await api.syncBucket(b)
      setTest({ ...test, [b]: { ok: r.ok, text: `对账完成 · 桶内 ${r.objects} 个对象，补录索引 ${r.added} 个` } })
    } catch (e) {
      setTest({ ...test, [b]: { ok: false, text: e.message } })
    }
  }

  return (
    <div>
      <div className="card">
        <h3>MiniMax API <span className="mono dim" style={{ fontSize: 10.5 }}>M3 文案/HTML · H3 视频</span></h3>
        <div className="f">
          <span>API Key</span>
          <input
            className="input mono"
            type={keyDisplaying ? 'text' : 'password'}
            style={{ width: 340 }}
            readOnly={keyDisplaying}
            value={keyBoxValue}
            onFocus={() => { if (keyDisplaying) setKeyInput('') }}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={s.hasKey ? '点击输入框可覆盖，留空保持不变' : '留空 = MOCK 模式'}
            title={keyDisplaying ? '已保存的 Key（点击输入框可修改）' : ''}
          />
          {s.hasKey && (
            <button className="btn sm" onClick={toggleShowKey}>{showKey ? '🙈 隐藏' : '👁 显示'}</button>
          )}
          {s.hasKey
            ? <span className="ok" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>✓ 已配置 · 尾号 {s.keyTail}</span>
            : <span className="dim" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>未配置（MOCK 模式）</span>}
        </div>
        <div className="f">
          <span>Base URL</span>
          <input className="input" style={{ width: 420 }} value={s.baseUrl || ''} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.minimax.cn" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, maxWidth: 640 }}>
          <label className="f"><span>文本模型</span><input className="input" value={s.textModel || ''} onChange={(e) => set({ textModel: e.target.value })} /></label>
          <label className="f"><span>视频模型</span><input className="input" value={s.videoModel || ''} onChange={(e) => set({ videoModel: e.target.value })} /></label>
          <label className="f"><span>QC 模型</span><input className="input" value={s.qcModel || ''} onChange={(e) => set({ qcModel: e.target.value })} /></label>
        </div>
      </div>
      <div className="sectionGap" />

      <div className="card">
        <h3>三桶存储 <span className="mono dim" style={{ fontSize: 10.5 }}>素材 / 海报 / 视频 各自配置 · l3 已停用</span></h3>
        <div className="grid2">
          {['l1', 'l2', 'l4'].map((b) => {
            const cfg = s.buckets?.[b] || {}
            const t = test[b]
            return (
              <div key={b} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 12 }}>
                <div className="rowFlex" style={{ marginBottom: 8 }}>
                  <b style={{ fontSize: 13 }}>{BUCKET_LABELS[b]}</b>
                  <span style={{ flex: 1 }} />
                  <button className="btn sm" title="全量列举一次桶内容，补录索引之外的对象（列表接口零 OSS 请求）" onClick={() => syncOne(b)}>{t?.syncing ? '…' : '⟳ 同步'}</button>
                  <button className="btn sm" onClick={() => testOne(b, cfg?.driver)}>{t?.loading ? '…' : '测连通'}</button>
                  {cfg.driver === 'oss' && <button className="btn sm" title="把本地 data/buckets 里的历史文件搬进 OSS（fileId 不变，可重复执行，已存在的跳过）" onClick={async () => { setTest({ ...test, [b]: { loading: true } }); try { const r = await api.migrateBucketLocal(b); setTest({ ...test, [b]: { ok: true, text: `迁移完成：${r.migrated} 个上传 · ${r.skipped} 个已存在跳过${r.failed ? ` · ${r.failed} 个失败` : ''}` } }) } catch (e) { setTest({ ...test, [b]: { ok: false, text: e.message } }) } }}>{t?.loading ? '…' : '迁本地'}</button>}
                </div>
                {t && !t.loading && <div className={t.ok ? 'ok' : 'err'} style={{ fontSize: 11, marginBottom: 6 }}>{t.ok ? '✓ ' : '✗ '}{t.text}</div>}
                <label className="f"><span>存储类型</span>
                  <select className="input" style={{ width: '100%' }} value={cfg.driver || 'local'} onChange={(e) => setBucket(b, { driver: e.target.value })}>
                    <option value="local">本地磁盘</option>
                    <option value="oss">OSS (S3 兼容)</option>
                  </select>
                </label>
                {cfg.driver === 'oss' && OSS_ONLY.map((k) => (
                  <label key={k} className="f"><span>{FIELD_LABELS[k]}</span>
                    {k === 'secretAccessKey' ? (
                      <span className="rowFlex" style={{ gap: 6 }}>
                        <input className="input mono" style={{ width: '100%', flex: 1 }} type={showSec[b] ? 'text' : 'password'} value={cfg[k] || ''} onChange={(e) => setBucket(b, { [k]: e.target.value })} placeholder="SK…" />
                        <button className="btn sm" style={{ flexShrink: 0 }} onClick={() => setShowSec({ ...showSec, [b]: !showSec[b] })}>{showSec[b] ? '🙈' : '👁'}</button>
                      </span>
                    ) : (
                      <input className="input" style={{ width: '100%' }} value={cfg[k] || ''} onChange={(e) => setBucket(b, { [k]: e.target.value })} />
                    )}
                  </label>
                ))}
                {cfg.driver !== 'oss' && <div className="dim" style={{ fontSize: 11 }}>data/buckets/{b}/</div>}
              </div>
            )
          })}
        </div>
      </div>
      <div className="sectionGap" />

      <div className="card">
        <h3>开放接口鉴权 <span className="mono dim" style={{ fontSize: 10.5 }}>X-API-Key</span></h3>
        <div className="dim" style={{ fontSize: 11.5, marginBottom: 6 }}>逗号分隔；留空 = /v1 /v2 接口不鉴权</div>
        <input className="input" style={{ width: 420 }} value={(s.apiKeys || []).join(',')} onChange={(e) => set({ apiKeys: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
      </div>
      <div className="sectionGap" />

      <div className="rowFlex">
        <button className="btn primary" disabled={saving} onClick={save}>{saving ? <span className="spin" /> : ''} 保存全部设置</button>
        <span className="dim" style={{ fontSize: 11 }}>保存到 data/settings.json · 配置 OSS 桶后自动拉取桶内已有素材进索引</span>
        {msg && <span className="notice" style={{ padding: '4px 10px' }}>{msg}</span>}
      </div>
    </div>
  )
}
