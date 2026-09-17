import React, { useEffect, useState } from 'react'

/** 任意卡片调 openPreview(item) 打开大图预览（全局单例，App 挂载 <PreviewHost/>） */
export function openPreview(item) {
  window.dispatchEvent(new CustomEvent('dsh-preview', { detail: item }))
}

export function PreviewHost() {
  const [item, setItem] = useState(null)
  useEffect(() => {
    const on = (e) => setItem(e.detail)
    window.addEventListener('dsh-preview', on)
    const esc = (e) => { if (e.key === 'Escape') setItem(null) }
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('dsh-preview', on); window.removeEventListener('keydown', esc) }
  }, [])
  if (!item) return null
  const isVideo = (item.fileId || item.url || '').endsWith('.mp4')
  return (
    <div className="lightbox" onClick={() => setItem(null)}>
      <div className="lightboxBody" onClick={(e) => e.stopPropagation()}>
        {isVideo
          ? <video src={item.url} controls autoPlay loop style={{ maxHeight: '78vh', maxWidth: '100%', borderRadius: 12, display: 'block', background: '#000' }} />
          : <img src={item.url} alt={item.name} style={{ maxHeight: '78vh', maxWidth: '100%', borderRadius: 12, display: 'block' }} />}
        <div className="rowFlex" style={{ justifyContent: 'space-between', marginTop: 10, gap: 12 }}>
          <span style={{ fontSize: 13, color: '#fff' }}>{item.name}</span>
          <span className="mono dim" style={{ fontSize: 11 }}>{isVideo ? '视频' : '图片'} · 点击空白或 Esc 关闭</span>
        </div>
      </div>
      <button className="lightboxClose" onClick={() => setItem(null)}>×</button>
    </div>
  )
}
