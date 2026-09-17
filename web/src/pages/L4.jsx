import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Pager } from './L1.jsx'
import { openPreview } from '../components/Preview.jsx'
import PiTracePanel from '../components/PiTracePanel.jsx'

const VIDEO_PROMPT_TEMPLATE = `使用 $poster-to-marketing-video，将当前选中的静态海报制作成一条简单、精致的营销视频。

【输入素材】
可能包含以下素材：
1. 静态海报
2. 动效参考视频
3. 透明标题图层（可选）
4. 透明商品图层（商品需要运动时必须提供）
5. 透明烟雾图层或烟雾alpha蒙版（烟雾需要流动时必须提供）

参考视频只能用于分析运动节奏、呼吸速度、烟雾流动方向和背景光影变化，不得复制其中的商品、人物、文字、Logo、花瓣、粒子、烟雾或其他装饰元素。

【视频参数】
- 时长：5秒
- 帧率：25fps
- 输出格式：MP4
- 编码：H.264、yuv420p
- 无音频
- 视频尺寸必须与静态海报完全一致。
- 禁止裁剪、拉伸、扩图或改变原始画幅比例。
- 第一帧和最后一帧都必须保持完整海报构图。
- 结束时保持完整画面，不得淡出至黑色。

【背景与相框】
静态海报的背景底图必须完全锁定。
相框、门框、拱门、舞台、窗框、底座、建筑、背景纹理及其他装饰结构必须保持原来的大小、位置和形状。
严格禁止：
- 整张海报放大或缩小
- 镜头推近或拉远
- 整体平移或漂移
- Ken Burns镜头效果
- 相框跟随商品缩放
- 相框跟随烟雾移动或变形
- 通过背景缩放制造呼吸感
背景只能出现缓慢、柔和的明暗光影变化。光影变化不得带动海报构图，不得改变相框尺寸和位置。

【标题动效】
标题围绕自身可见内容的几何中心进行缓慢的原地呼吸：
- 缩放范围：100%～103%。
- 放大时轻微向上移动3～6px。
- 缩小时回到原始大小和原始位置。
- 动画必须连续、缓慢、柔和。
- 保持原标题的文字、字形、颜色和排版。
- 不得OCR后重新排字。
- 不得替换字体或修改文字内容。
- 不得出现文字变形、重影或突然跳动。
如果提供透明标题图层，优先使用透明标题图层进行独立运动。
如果只有合成海报，可以使用羽化的标题局部区域，但该区域不得包含相框、商品或其他需要保持固定的元素。

【商品动效】
商品围绕自身alpha可见内容的几何中心进行缓慢的原地呼吸：
- 缩放范围：100%～102%。
- 放大时轻微向上移动5～10px。
- 缩小时回到原始大小和原始位置。
- 商品运动周期应比标题稍慢。
- 默认不旋转商品。
- 保持商品原来的方向、内容和视觉中心。
- 不得改变商品外观、文字、颜色或结构。
商品动画只能作用于透明商品图层或可靠的商品轮廓蒙版。
相框、背景、烟雾、花朵、飞鸟和其他装饰不得进入商品图层。
禁止使用包含商品与相框的矩形截图作为商品运动区域。
如果无法可靠分离商品和相框，必须保持商品静止并请求透明商品图层，不得为了让商品运动而带动相框。
商品缩放应以100%为最小值，只允许从原始大小轻微放大后再回到100%，避免缩小时露出海报中原来固定的商品边缘。

【烟雾流动】
只有海报中原本存在烟雾时，才启用烟雾动画。
必须先将烟雾提取为与海报画布尺寸完全一致的透明烟雾专属图层，或使用可靠的烟雾alpha蒙版。
烟雾图层只能包含烟雾像素，不得包含：
- 相框
- 商品
- 标题
- 花朵
- 飞鸟
- 建筑
- 背景装饰
- 其他固定元素
禁止使用包含相框的矩形截图作为烟雾图层。
烟雾图层大小必须始终保持100%，即scale固定为1。
严格禁止：
- 烟雾放大或缩小
- 烟雾呼吸或脉冲
- 烟雾整体膨胀或收缩
- 通过尺寸变化表现烟雾运动
- 烟雾带动相框发生变化
烟雾的流动感通过以下方式实现：
- 沿烟雾原本的延伸方向缓慢位移4～12px。
- 使用连续的displacement纹理扭曲，让烟雾内部纹理缓慢游动。
- 使用轻微的透明度变化表现烟雾浓淡。
- 可以添加不超过1px的柔和模糊。
- 运动周期控制在3～5秒。
- 不同烟雾图层使用不同的运动相位。
- 烟雾运动必须连续、缓慢，类似气流扩散。
- 不得像贴纸一样整体来回摆动。
如果没有透明烟雾图层或无法获得干净的烟雾蒙版，必须保持烟雾静止。
不得通过移动包含烟雾和相框的矩形区域来伪造烟雾流动。
烟雾只能复用原海报中的烟雾像素，不得生成新的烟雾，不得增加烟雾数量，也不得复制参考视频中的烟雾。

【素材限制】
只能使用当前选中的静态海报及用户明确提供的透明图层。
不得添加海报中不存在的：
- 图片
- 商品
- 人物
- 文字
- Logo
- 图标
- 花瓣
- 粒子
- 烟雾
- 光斑素材
- 插画或装饰元素
不得使用AI补图、生成式填充、扩图、重新绘制商品或重新生成烟雾。
允许使用CSS生成柔和的明暗光影，但不得生成具有具体形状的新视觉元素。
不得添加BGM、音效、旁白、播放器界面、制作署名或额外水印。

【输入模式判断】
如果提供了独立背景、透明标题图、透明商品图和透明烟雾图，使用layered模式。
在layered模式中：
- 背景与相框完全固定。
- 标题独立呼吸。
- 商品独立呼吸。
- 烟雾保持100%尺寸，只进行位移、displacement、透明度和模糊变化。
如果只有一张已经合成好的海报，使用flat-safe模式。
在flat-safe模式中：
- 背景与相框必须完全固定。
- 标题可以使用不包含其他元素的羽化区域进行轻微呼吸。
- 商品只有在获得可靠的商品轮廓蒙版后才能运动。
- 烟雾只有在获得可靠的烟雾alpha蒙版后才能流动。
- 禁止使用矩形海报区域代替商品层或烟雾层。
- 如果出现相框变化、背景接缝、重影或破洞，必须停止对应局部动画。
- 不得改成整张海报缩放来掩盖问题。

【时间节奏】
- 0～0.6秒：保持完整构图，标题、商品和烟雾缓慢进入运动状态。
- 0.6～4.3秒：标题和商品使用不同周期进行原地呼吸；烟雾沿原有方向持续缓慢流动。
- 4.3～5秒：标题和商品逐渐回到原始大小与原始位置；烟雾运动逐渐减弱。
- 最后一帧保持稳定完整，不得淡出至黑色。

【执行流程】
1. 检查静态海报尺寸和参考视频参数。
2. 识别背景、相框、标题、商品和已有烟雾。
3. 确认商品图层不包含相框像素。
4. 确认烟雾图层不包含相框、商品或其他固定元素。
5. 创建motion-plan.json，记录：
   - 画布尺寸
   - 视频时长和帧率
   - 输入素材
   - 标题与商品的几何中心
   - 标题和商品的缩放范围及位移幅度
   - 烟雾图层来源
   - 烟雾位移方向、位移幅度、displacement参数和运动周期
   - 背景与相框的transform必须为none
   - 烟雾图层的scale必须固定为1
6. 生成可编辑的poster-motion.html。
7. HTML必须提供window.__seek(ms)和window.__ready。
8. 使用Playwright逐帧截图。
9. 使用ffmpeg编码MP4。
10. 检查首帧、中间帧和末帧。

【输出文件】
输出以下文件：
- poster-motion.html
- poster-motion.mp4
- motion-plan.json
- verification.json

【最终检查】
渲染完成后必须确认：
1. 背景没有发生缩放、平移或漂移。
2. 相框的大小、位置和轮廓逐帧保持一致。
3. 标题只围绕自身中心进行呼吸。
4. 商品只通过透明商品图层进行呼吸。
5. 商品运动没有带动相框。
6. 烟雾尺寸始终保持100%。
7. 烟雾通过方向位移和内部纹理扭曲产生流动感。
8. 烟雾运动没有带动或扭曲相框。
9. 没有矩形区域接缝、明显重影或背景破洞。
10. 没有添加任何原素材中不存在的视觉元素。

【执行优先级】
1. 相框和背景绝对固定。
2. 烟雾尺寸固定为100%，只允许流动，不允许缩放。
3. 商品只能通过透明商品图层或可靠蒙版运动。
4. 严格遵守素材限制。
5. 最后再考虑动效丰富度。

当动效效果与相框稳定性发生冲突时，必须优先保证相框稳定；无法可靠分离的元素保持静止。`

export default function L4() {
  const [l3, setL3] = useState([])
  const [assets, setAssets] = useState({ items: [], page: 1, pages: 1, total: 0 })
  const [jobs, setJobs] = useState({ items: [], page: 1, pages: 1, total: 0 })
  const [assetPage, setAssetPage] = useState(1)
  const [jobPage, setJobPage] = useState(1)
  const [sel, setSel] = useState([])
  const [prompt, setPrompt] = useState(VIDEO_PROMPT_TEMPLATE) // 默认提示词模板（skill v2 规范）
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState([]) // 已提交未完成的视频任务（视频库 loading 占位）
  const [aspectRatio, setAspectRatio] = useState('3:4')
  const [resolution, setResolution] = useState('2K')
  const [duration, setDuration] = useState(5)
  const pollRef = useRef(null)

  const load = async () => {
    const [a, v, j] = await Promise.all([
      api.l3Assets({ pageSize: 500 }),
      api.l4Assets({ page: assetPage, pageSize: 12 }),
      api.l4Jobs({ page: jobPage, pageSize: 8 }),
    ])
    setL3(a.items || [])
    setAssets(v)
    setJobs(j)
  }
  useEffect(() => { load() }, [assetPage, jobPage])

  useEffect(() => {
    clearInterval(pollRef.current)
    if (!pending.length && !jobs.items?.some((x) => x.status === 'running' || x.status === 'queued')) return
    pollRef.current = setInterval(load, 2500)
    return () => clearInterval(pollRef.current)
  }, [jobs, pending])

  // 占位卡对账：job 完成/失败 → 移除对应占位（成品已入库或任务行报错）
  useEffect(() => {
    if (!pending.length) return
    const settled = new Set((jobs.items || []).filter((x) => ['done', 'failed', 'cancelled'].includes(x.status)).map((x) => x.jobId))
    const next = pending.filter((p) => !settled.has(p.jobId) && Date.now() - p.t < 15 * 60 * 1000)
    if (next.length !== pending.length) setPending(next)
  }, [jobs, pending])

  const toggle = (id) => setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id])

  const generate = async () => {
    if (!sel.length) return alert('选择至少一张 L3 海报')
    setBusy(true)
    try {
      const jobsNew = sel.length === 1
        ? [await api.l4Generate({ l3FileId: sel[0], prompt, videoOpts: { aspectRatio, resolution, duration } })]
        : (await api.l4GenerateBatch(sel.map((l3FileId) => ({ l3FileId, prompt, videoOpts: { aspectRatio, resolution, duration } })))).items || []
      for (const r of jobsNew) {
        setPending((p) => [...p, { jobId: r.jobId, name: prompt?.slice(0, 18) || 'H3 视频生成', t: Date.now() }])
      }
      setSel([])
      await load()
    } catch (e) {
      alert(e.message)
    } finally {
      setBusy(false)
    }
  }

  const vo = { aspectRatio, resolution, duration }
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
      <div className="card">
        <h3>L4 · 视频合成 <span className="mono dim" style={{ fontSize: 10.5 }}>LEVEL 4 · 海报 → 5s 视频 · MiniMax H3</span></h3>
        <div className="dim" style={{ fontSize: 12.5 }}>
          选择 L3 海报（可多选批量）+ 一句运动描述 → 5 秒竖版视频，存入 L4 桶。多选即批量衍生。
        </div>
      </div>
      <div className="sectionGap" />

      <div className="card">
        <h3>选择海报 <span className="mono dim" style={{ fontSize: 10.5 }}>已选 {sel.length}</span></h3>
        {l3.length === 0 ? (
          <div className="emptyState">L3 暂无海报 · 先去「海报合成 - 二次加工」生成</div>
        ) : (
          <div className="pickGrid pickScroll">
            {l3.filter((a) => a.usable !== false).map((a) => (
              <div key={a.fileId} className={`pickCard poster ${sel.includes(a.fileId) ? 'sel' : ''}`} style={{ cursor: 'pointer' }} onClick={() => toggle(a.fileId)}>
                <img src={a.url} alt={a.name} />
                <div className="nm"><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span></div>
              </div>
            ))}
          </div>
        )}
        <div className="sectionGap" />
        <textarea
          className="input"
          rows={8}
          style={{ width: '100%', resize: 'vertical' }}
          placeholder='视频运动描述，例：模特微笑着将商品缓缓递向镜头，文字与背景保持静止'
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="rowFlex" style={{ marginTop: 10 }}>
          <button className="btn primary" disabled={busy || !sel.length} onClick={generate}>
            {busy ? <span className="spin" /> : '▶'} {sel.length > 1 ? `批量生成 ${sel.length} 个视频` : '生成视频'}
          </button>
        </div>
      </div>
      <div className="sectionGap" />

      <div className="card">
        <h3>视频库 <span className="mono dim" style={{ fontSize: 10.5 }}>{assets.total}</span></h3>
        {assets.items.length === 0 ? (
          <div className="emptyState">还没有视频</div>
        ) : (
          <>
            <div className="pickGrid">
              {pending.map((p) => (
                <div key={p.jobId} className="pendingCard" title={`任务 ${p.jobId} · ${aspectRatio} ${resolution} ${duration}s · H3 约 5-8 分钟`}>
                  <span className="spin" />
                  视频生成中…
                  <span className="nm2">{p.name}</span>
                </div>
              ))}
              {assets.items.map((a) => (
                <div key={a.fileId} className="pickCard poster" style={{ position: 'relative' }} onClick={() => openPreview(a)}>
                  <video src={a.url} controls muted loop style={{ width: '100%', height: 160, objectFit: 'cover', background: '#000' }} />
                  <button className="pvBtn" title="预览大图" onClick={(e) => { e.stopPropagation(); openPreview(a) }}>⤢</button>
                  {a.prompt && <div className="dim" style={{ fontSize: 10, padding: '0 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.prompt}</div>}
                  <div className="nm">
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span>
                    <button className="del" onClick={async (e) => { e.stopPropagation(); if (confirm(`删除 ${a.name}?`)) { try { await api.deleteL4(a.fileId) } catch (err) { alert('删除失败：' + err.message) } load() } }}>×</button>
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
            {jobs.items.map((j) => (
              <div key={j.jobId} className="rowFlex" style={{ borderBottom: '1px solid var(--line)', padding: '8px 0', gap: 8 }}>
                <span className={`tag ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'err' : 'run'}`}>{j.status?.toUpperCase()}</span>
                <span className="mono dim" style={{ fontSize: 11 }}>{j.jobId}</span>
                {j.videoTaskId && <span className="mono" style={{ fontSize: 10, color: '#c792ea' }} title="MiniMax H3 task_id">H3:{String(j.videoTaskId).slice(0, 18)}</span>}
                {j.videoOpts && <span className="mono dim" style={{ fontSize: 10 }}>{j.videoOpts.aspectRatio} · {j.videoOpts.resolution} · {j.videoOpts.duration}s</span>}
                {j.l4Url && <a className="link mono" style={{ fontSize: 11 }} href={j.l4Url} target="_blank" rel="noreferrer">视频 ↗</a>}
                {j.error && <span style={{ fontSize: 11.5, color: 'var(--err)' }}>{j.error}</span>}
              </div>
            ))}
            <Pager page={jobs.page} pages={jobs.pages} total={jobs.total} onPage={(p) => setJobPage(p)} />
          </>
        )}
      </div>
      </div>

      <div style={{ width: 330, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="card">
          <h3>视频参数 <span className="mono dim" style={{ fontSize: 10 }}>MiniMax H3</span></h3>
          <div style={{ fontSize: 12, margin: '8px 0 4px' }} className="dim">视频比例 <span className="mono dim">(ratio)</span></div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {['3:4', '9:16', '1:1', '4:3', '16:9', 'adaptive'].map((r) => (
              <button key={r} className="chip" style={{ opacity: aspectRatio === r ? 1 : 0.55, borderColor: aspectRatio === r ? 'var(--violet)' : undefined, color: aspectRatio === r ? '#fff' : undefined, background: aspectRatio === r ? 'rgba(124,92,255,0.18)' : undefined }} onClick={() => setAspectRatio(r)}>{r}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, marginBottom: 4 }} className="dim">分辨率 <span className="mono dim">(resolution)</span></div>
              <select className="input" value={resolution} onChange={(e) => setResolution(e.target.value)} style={{ width: '100%' }}>
                {['2K', '1080P', '768P'].map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div style={{ width: 100 }}>
              <div style={{ fontSize: 12, marginBottom: 4 }} className="dim">时长 (秒)</div>
              <input className="input" type="number" min={4} max={15} value={duration} onChange={(e) => setDuration(Math.max(4, Math.min(15, parseInt(e.target.value) || 5)))} style={{ width: '100%' }} />
            </div>
          </div>
          <div className="mono dim" style={{ fontSize: 10, marginTop: 8 }}>
            当前: ratio={vo.aspectRatio} · resolution={vo.resolution} · duration={vo.duration}s
          </div>
        </div>
        <PiTracePanel busy={busy} biz="l4video" title="pi 调用记录" subtitle="H3 视频 · live" />
      </div>
    </div>
  )
}
