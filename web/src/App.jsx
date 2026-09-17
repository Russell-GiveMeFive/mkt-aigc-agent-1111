import React, { useEffect, useState } from 'react'
import L1 from './pages/L1.jsx'
import L2 from './pages/L2.jsx'
import L3 from './pages/L3.jsx'
import L4 from './pages/L4.jsx'
import Settings from './pages/Settings.jsx'
import Skills from './pages/Skills.jsx'
import Logs from './pages/Logs.jsx'
import { PreviewHost } from './components/Preview.jsx'
import { api } from './api.js'

const NAV = [
  ['l1', '基础素材', '◍', L1],
  ['l2', '商品海报合成', '◈', L2],
  ['l3', '海报合成 - 二次加工', '▤', L3],
  ['l4', '视频合成', '▶', L4],
  ['logs', '运行日志', '⧉', Logs],
  ['settings', '设置', '⚙', Settings],
  ['skills', '技能', '✦', Skills],
]

export default function App() {
  const [tab, setTab] = useState(() => localStorage.getItem('tab') || 'l1')
  const [mock, setMock] = useState(null)

  useEffect(() => { localStorage.setItem('tab', tab) }, [tab])
  useEffect(() => { api.meta().then((m) => setMock(m.mock)).catch(() => {}) }, [])

  const Page = NAV.find(([k]) => k === tab)?.[3] || L1

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <div className="t1">素材工厂</div>
          <div className="t2">AIGC · v2</div>
        </div>
        {NAV.map(([k, label, icon, _P]) => (
          <button key={k} className={`navItem ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
            <span className="ico">{icon}</span>
            {label}
          </button>
        ))}
        <div className="railSpacer" />
        <div className={`modeTag ${mock ? '' : 'real'}`}>
          {mock == null ? '…' : mock ? 'MOCK 模式 · 全链路本地模拟' : 'LIVE · MiniMax 已连接'}
        </div>
      </aside>
      <main className="main">
        <div className="mainWrap">
        <Page goTab={setTab} />
        </div>
      </main>
      <PreviewHost />
    </div>
  )
}
