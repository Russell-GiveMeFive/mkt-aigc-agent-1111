async function jfetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store', // 任何列表删除/新增后立即反映；不读浏览器缓存条目
    ...options,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return body
}

function upload(files, extra = {}) {
  const fd = new FormData()
  for (const f of files) fd.append('files', f)
  for (const [k, v] of Object.entries(extra)) fd.append(k, v)
  return fetch('/v2/l1/assets', { method: 'POST', body: fd }).then(async (r) => {
    const b = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
    return b
  })
}

function qs(params = {}) {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') s.set(k, v)
  }
  const str = s.toString()
  return str ? `?${str}` : ''
}

export const api = {
  /* 通用 */
  meta: () => jfetch('/v2/meta'),
  settings: () => jfetch('/v2/settings'),
  prompts: () => jfetch('/v2/prompts'),
  logs: (q = {}) => jfetch(`/v2/logs?${qs(q)}`), // qs 会跳过 undefined/空值（URLSearchParams 会把 undefined 序列化成 'undefined' 导致后端过滤成 0 条）
  revealSettings: () => jfetch('/v2/settings?reveal=1'),
  saveSettings: (patch) => jfetch('/v2/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  testBucket: (b) => jfetch(`/v2/buckets/${b}/test`, { method: 'POST' }),
  syncBucket: (b) => jfetch(`/v2/buckets/${b}/sync`, { method: 'POST' }),
  stats: () => jfetch('/api/stats'),

  /* L1 基础素材（列表分页：page/pageSize，返回 {items,total,page,pages,hasMore}） */
  l1Assets: (params) => jfetch(`/v2/l1/assets${qs(params)}`),
  uploadL1: upload,
  deleteL1: (fileId) => jfetch(`/v2/l1/assets/${fileId}`, { method: 'DELETE' }),
  deleteL1Batch: (fileIds) => jfetch('/v2/l1/assets/delete', { method: 'POST', body: JSON.stringify({ fileIds }) }),

  /* L2 平台合成素材 */
  composeBg: (payload) => jfetch('/v2/l2/compose-bg', { method: 'POST', body: JSON.stringify(payload) }),
  composeBgBatch: (jobs) => jfetch('/v2/l2/compose-bg/batch', { method: 'POST', body: JSON.stringify({ jobs }) }),
  l2Assets: (params) => jfetch(`/v2/l2/assets${qs(params)}`),
  setPipeline: (fileIds, enabled) => jfetch('/v2/l2/pipeline', { method: 'POST', body: JSON.stringify({ fileIds, enabled }) }),
  deleteL2: (fileId) => jfetch(`/v2/l2/assets/${fileId}`, { method: 'DELETE' }),
  deleteL2Batch: (fileIds) => jfetch('/v2/l2/assets/delete', { method: 'POST', body: JSON.stringify({ fileIds }) }),

  /* L3 商家最终营销海报 */
  l3Generate: (payload) => jfetch('/v2/l3/generate', { method: 'POST', body: JSON.stringify(payload) }),
  l3Direct: (payload) => jfetch('/v2/l3/direct', { method: 'POST', body: JSON.stringify(payload) }),
  l4Render: (payload) => jfetch('/v2/l4/render', { method: 'POST', body: JSON.stringify(payload) }),
  l3GenerateBatch: (items) => jfetch('/v2/l3/generate/batch', { method: 'POST', body: JSON.stringify({ items }) }),
  l3Rework: (payload) => jfetch('/v2/l3/rework', { method: 'POST', body: JSON.stringify(payload) }),
  l3Jobs: (params) => jfetch(`/v2/l3/jobs${qs(params)}`),
  l3Job: (id) => jfetch(`/v2/l3/jobs/${id}`),
  l3Assets: (params) => jfetch(`/v2/l3/assets${qs(params)}`),
  deleteL3: (fileId) => jfetch(`/v2/l3/assets/${fileId}`, { method: 'DELETE' }),
  deleteL3Batch: (fileIds) => jfetch('/v2/l3/assets/delete', { method: 'POST', body: JSON.stringify({ fileIds }) }),

  /* L4 视频合成 */
  l4Generate: (payload) => jfetch('/v2/l4/generate', { method: 'POST', body: JSON.stringify(payload) }),
  l4GenerateBatch: (items) => jfetch('/v2/l4/generate/batch', { method: 'POST', body: JSON.stringify({ items }) }),
  l4Jobs: (params) => jfetch(`/v2/l4/jobs${qs(params)}`),
  l4Job: (id) => jfetch(`/v2/l4/jobs/${id}`),
  l4Assets: (params) => jfetch(`/v2/l4/assets${qs(params)}`),
  deleteL4: (fileId) => jfetch(`/v2/l4/assets/${fileId}`, { method: 'DELETE' }),
  deleteL4Batch: (fileIds) => jfetch('/v2/l4/assets/delete', { method: 'POST', body: JSON.stringify({ fileIds }) }),

  /* 技能 */
  skills: () => jfetch('/v2/skills'),
  uploadSkills: (files, name, scope) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    if (name) fd.append('name', name)
    if (scope) fd.append('scope', scope)
    return fetch('/v2/skills', { method: 'POST', body: fd }).then(async (r) => {
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
      return b
    })
  },
  setSkillEnabled: (id, enabled) => jfetch(`/v2/skills/${id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  setSkillScope: (id, scope) => jfetch(`/v2/skills/${id}/scope`, { method: 'POST', body: JSON.stringify({ scope }) }),
  getSkillContent: (id) => jfetch(`/v2/skills/${id}/content`),
  deleteSkill: (id) => jfetch(`/v2/skills/${id}`, { method: 'DELETE' }),
}
