/**
 * v2 全链路集成测试 —— 隔离数据目录（data-test）起真实服务打 HTTP（MOCK 模式）
 * 运行：node --test tests/
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const PORT = 8791
const B = `http://127.0.0.1:${PORT}`
let child

const j = async (method, path, body, apiKey) => {
  const res = await fetch(B + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch { /* 非 JSON（如 404 html） */ }
  return { status: res.status, data }
}

/** 上传本地测试图（multipart） */
const upload = async (category, filePath, name) => {
  const fd = new FormData()
  fd.append('category', category)
  const buf = fs.readFileSync(filePath)
  fd.append('files', new Blob([buf], { type: 'image/png' }), filePath.split('/').pop())
  if (name) fd.append('names', JSON.stringify([name]))
  const res = await fetch(`${B}/v2/l1/assets`, { method: 'POST', body: fd })
  return { status: res.status, data: await res.json() }
}

const pollJob = async (path, { timeout = 90_000 } = {}) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const { status, data } = await j('GET', path)
    if (status === 200 && (data.status === 'done' || data.status === 'failed')) return data
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`轮询超时: ${path}`)
}

/** 重启测试服务（同一 data-test 数据目录），验证持久化 */
const restartServer = async () => {
  child.kill()
  await new Promise((r) => child.on('exit', r))
  child = spawn('node', ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: 'data-test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d))
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${B}/v2/meta`)).ok) return } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('测试服务重启失败')
}

/** 保证有可用的 L2 管线背景与 L1 商品图（供 L3 用例复用） */
let shared = {}

before(async () => {
  fs.rmSync('data-test', { recursive: true, force: true })
  child = spawn('node', ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: 'data-test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d))
  // 端口被占（孤儿服务）时子进程会静默退出 —— 显式识别，避免打到旧实例
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  const ready = (async () => {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${B}/v2/meta`)).ok) return true } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  })()
  const code = await Promise.race([exited, ready.then((ok) => (ok ? 'ready' : 'timeout'))])
  if (code !== 'ready') {
    throw new Error(`测试服务启动失败（${code === 'timeout' ? '就绪超时' : `进程退出 code=${code}`}；若 EADDRINUSE 请清理占用 ${PORT} 的进程）`)
  }
})

after(() => {
  child?.kill()
  if (!process.env.KEEP_TEST_DATA) fs.rmSync('data-test', { recursive: true, force: true })
})

/* ================= 通用 ================= */

test('GET /v2/meta：四桶 + 七类 + MOCK 状态', async () => {
  const { status, data } = await j('GET', '/v2/meta')
  assert.equal(status, 200)
  assert.deepEqual(data.buckets, ['l1', 'l2', 'l3', 'l4'])
  assert.equal(data.l1Categories.length, 7)
  assert.equal(data.mock, true)
  assert.equal(data.l1Categories[0].key, 'plate')
})

test('GET /v2/files：不存在的 fileId → 404', async () => {
  const res = await fetch(`${B}/v2/files/l1/nope.png`)
  assert.equal(res.status, 404)
})

/* ================= L1 基础素材 ================= */

test('L1 上传（多文件批量）→ fileId 前缀即 category', async () => {
  const { status, data } = await upload('pattern', 'data/assets/l1-pattern/l1-pattern-1.png', '测试花纹A')
  assert.equal(status, 201)
  assert.equal(data.items.length, 1)
  const it = data.items[0]
  assert.ok(it.fileId.startsWith('pattern_'))
  assert.equal(it.category, 'pattern')
  assert.equal(it.name, '测试花纹A')
  assert.match(it.url, /^\/v2\/files\/l1\//)
  shared.pattern = it.fileId
})

test('L1 上传非法 category → 400', async () => {
  const fd = new FormData()
  fd.append('category', 'notacat')
  fd.append('files', new Blob([Buffer.from('x')]), 'x.png')
  const res = await fetch(`${B}/v2/l1/assets`, { method: 'POST', body: fd })
  assert.equal(res.status, 400)
})

test('L1 分页列表：total/page/pages/hasMore 出参齐全', async () => {
  await upload('pattern', 'data/assets/l1-pattern/l1-pattern-2.png', '测试花纹B')
  await upload('pattern', 'data/assets/l1-pattern/l1-pattern-3.png', '测试花纹C')
  const p1 = await j('GET', '/v2/l1/assets?page=1&pageSize=2')
  assert.equal(p1.status, 200)
  assert.equal(p1.data.page, 1)
  assert.equal(p1.data.pageSize, 2)
  assert.ok(p1.data.total >= 3)
  assert.ok(p1.data.pages >= 2)
  assert.equal(p1.data.hasMore, true)
  assert.equal(p1.data.items.length, 2)
  // 按创建时间倒序：第一页最新
  assert.ok(p1.data.items[0].createdAt >= p1.data.items[1].createdAt)
})

test('L1 分页翻页：page=2 取到剩余数据，越界自动收敛到最后一页', async () => {
  const list = await j('GET', '/v2/l1/assets?category=pattern&pageSize=2')
  const total = list.data.total
  const p2 = await j('GET', `/v2/l1/assets?category=pattern&page=2&pageSize=2`)
  assert.equal(p2.data.items.length, Math.max(total - 2, 0))
  const overflow = await j('GET', `/v2/l1/assets?category=pattern&page=99&pageSize=2`)
  assert.equal(overflow.data.page, overflow.data.pages)
})

test('L1 category 过滤只返回该类', async () => {
  const { data } = await j('GET', '/v2/l1/assets?category=watermark')
  assert.ok(data.items.every((x) => x.category === 'watermark'))
})

test('L1 文件代理可读取', async () => {
  const res = await fetch(`${B}/v2/files/l1/${shared.pattern}`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /image\/png/)
})

test('L1 单个删除后 404，批量删除生效', async () => {
  const up = await upload('watermark', 'data/assets/l1-plate/l1-plate-1.png', '待删水印')
  const id = up.data.items[0].fileId
  assert.match(id, /^watermark_/)
  const del = await j('DELETE', `/v2/l1/assets/${id}`)
  assert.equal(del.status, 200)
  assert.equal((await fetch(`${B}/v2/files/l1/${id}`)).status, 404)
  const del404 = await j('DELETE', `/v2/l1/assets/${id}`)
  assert.equal(del404.status, 404)

  const up2 = await upload('labelstyle', 'data/assets/l1-plate/l1-plate-2.png', '待批量删')
  const id2 = up2.data.items[0].fileId
  const batch = await j('POST', '/v2/l1/assets/delete', { fileIds: [id2] })
  assert.equal(batch.status, 200)
  assert.equal(batch.data.items[0].deleted, true)
})

/* ================= L2 平台合成素材 ================= */

test('L2 compose-bg：缺 itemIds → 400；不存在的 fileId → 400', async () => {
  assert.equal((await j('POST', '/v2/l2/compose-bg', { itemIds: [], instruction: 'x' })).status, 400)
  assert.equal((await j('POST', '/v2/l2/compose-bg', { itemIds: ['plate_nope.png'], instruction: 'x' })).status, 400)
})

test('L2 compose-bg：合成 PNG + HTML 存档，可经代理读取', async () => {
  const up = await upload('plate', 'data/assets/l1-plate/l1-plate-1.png', '测试底版')
  shared.plate = up.data.items[0].fileId
  const { status, data } = await j('POST', '/v2/l2/compose-bg', {
    itemIds: [shared.plate, shared.pattern],
    instruction: '底版铺满，花纹平铺右上角',
    name: '测试合成背景',
  })
  assert.equal(status, 201)
  assert.ok(data.fileId.startsWith('l2bg_'))
  assert.equal(data.name, '测试合成背景')
  assert.equal(data.pipeline, false)
  assert.ok(data.html.includes('<'), '响应应包含生成的 HTML')
  assert.match(data.source, /mock-template/)
  shared.l2bg = data.fileId
  shared.l2html = data.htmlFileId
  assert.equal((await fetch(`${B}/v2/files/l2/${shared.l2bg}`)).status, 200)
  assert.equal((await fetch(`${B}/v2/files/l2/${shared.l2html}`)).status, 200)
})

test('L2 生产管线标记：批量开启/关闭，pipeline=1 过滤', async () => {
  const on = await j('POST', '/v2/l2/pipeline', { fileIds: [shared.l2bg], enabled: true })
  assert.equal(on.status, 200)
  const list = await j('GET', '/v2/l2/assets?pipeline=1')
  assert.ok(list.data.items.some((x) => x.fileId === shared.l2bg))
  // HTML 存档不应出现在素材列表
  assert.ok(list.data.items.every((x) => !x.fileId.endsWith('.html')))
})

test('L2 批量合成：两个 job 一次提交', async () => {
  const { status, data } = await j('POST', '/v2/l2/compose-bg/batch', {
    jobs: [
      { itemIds: [shared.plate], instruction: '纯底版', name: '批量A' },
      { itemIds: [shared.pattern], instruction: '纯花纹', name: '批量B' },
    ],
  })
  assert.equal(status, 201)
  assert.equal(data.items.length, 2)
  assert.ok(data.items.every((x) => x.fileId))
  shared.l2extra = data.items.map((x) => x.fileId)
})

test('L2 分页列表', async () => {
  const { data } = await j('GET', '/v2/l2/assets?pageSize=2')
  assert.ok(data.total >= 3)
  assert.equal(data.items.length, 2)
  assert.ok(data.hasMore === (data.total > 2))
})

/* ================= L3 商家最终营销海报 ================= */

test('L3 generate：未标记管线的背景 → 400', async () => {
  const { status, data } = await j('POST', '/v2/l3/generate', {
    bgFileId: shared.l2extra[0], // 未加管线
    productFileId: shared.pattern,
  })
  assert.equal(status, 400)
  assert.match(data.error, /生产管线/)
})

test('L3 generate 全链路：合成 → QC → 落桶，海报可用', async () => {
  const up = await upload('product', 'data/assets/product/prod-p2.png', '测试商品')
  shared.product = up.data.items[0].fileId
  const { status, data } = await j('POST', '/v2/l3/generate', {
    bgFileId: shared.l2bg,
    productFileId: shared.product,
    copySlots: { headline: '双11狂欢\n爆款直降', productName: '测试礼盒', price: '299', oldPrice: '599', cta: '立即抢购', promo: '前2小时5折' },
  })
  assert.equal(status, 202)
  assert.ok(data.jobId)
  assert.match(data.poll, /\/v2\/l3\/jobs\//)
  const job = await pollJob(data.poll)
  assert.equal(job.status, 'done')
  assert.equal(job.usable, true)
  assert.ok(typeof job.qcScore === 'number')
  assert.ok(job.l3FileId?.startsWith('l3_'))
  shared.l3 = job.l3FileId
  shared.l3job = job.jobId
  // 海报可经代理读取
  assert.equal((await fetch(`${B}/v2/files/l3/${shared.l3}`)).status, 200)
})

test('L3 job 详情：stages 与 qc 结构完整', async () => {
  const { status, data } = await j('GET', `/v2/l3/jobs/${shared.l3job}`)
  assert.equal(status, 200)
  assert.ok(Array.isArray(data.stages) && data.stages.length >= 4)
  assert.ok(data.stages.some((s) => s.key === 'qc' && s.status === 'done'))
  // qc 独立顶层数组：[{round, verdict:{pass,score,defects,repairPlan}}]
  assert.ok(Array.isArray(data.qc) && data.qc.length >= 1)
  const verdict = data.qc[0].verdict
  assert.equal(verdict.pass, true)
  assert.ok(typeof verdict.score === 'number')
  assert.ok(Array.isArray(verdict.defects))
})

test('L3 批量生成：两个任务', async () => {
  const { status, data } = await j('POST', '/v2/l3/generate/batch', {
    items: [
      { bgFileId: shared.l2bg, productFileId: shared.product },
      { bgFileId: shared.l2bg, productFileId: shared.product, generateVideo: false },
    ],
  })
  assert.equal(status, 202)
  assert.equal(data.items.length, 2)
  assert.ok(data.items.every((x) => x.jobId))
  shared.batchJobs = data.items.map((x) => x.jobId)
  const done = await pollJob(`/v2/l3/jobs/${shared.batchJobs[0]}`)
  assert.equal(done.status, 'done')
})

test('L3 再加工（换商品图）→ 新海报', async () => {
  const { status, data } = await j('POST', '/v2/l3/rework', { l3FileId: shared.l3, productFileId: shared.product })
  assert.equal(status, 202)
  const job = await pollJob(data.poll)
  assert.equal(job.status, 'done')
  assert.notEqual(job.l3FileId, shared.l3)
  shared.l3rework = job.l3FileId
})

test('L3 assets 分页 + usable/qcScore 关联', async () => {
  const { data } = await j('GET', '/v2/l3/assets?pageSize=200')
  assert.ok(data.total >= 2)
  assert.ok(data.pages >= 1)
  const item = data.items.find((x) => x.fileId === shared.l3)
  assert.ok(item, '主任务的海报应在列表中')
  assert.equal(item.usable, true)
  assert.ok(typeof item.qcScore === 'number')
  assert.ok(item.jobId)
})

test('L3 jobs 分页', async () => {
  const { data } = await j('GET', '/v2/l3/jobs?pageSize=2')
  assert.ok(data.total >= 3)
  assert.equal(data.items.length, 2)
  assert.ok(data.pages >= 2)
})

/* ================= L4 视频合成 ================= */

test('L4 generate：海报 → 5s 视频落桶', async () => {
  const { status, data } = await j('POST', '/v2/l4/generate', { l3FileId: shared.l3, prompt: '模特微笑递商品，文字静止' })
  assert.equal(status, 202)
  const job = await pollJob(data.poll)
  assert.equal(job.status, 'done')
  assert.ok(job.l4FileId?.startsWith('l4_'))
  shared.l4 = job.l4FileId
  const res = await fetch(`${B}/v2/files/l4/${shared.l4}`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /video\/mp4/)
})

test('L4 缺 l3FileId → 400', async () => {
  assert.equal((await j('POST', '/v2/l4/generate', { prompt: 'x' })).status, 400)
})

test('L4 assets 分页 + l3FileId 关联；L4 jobs 分页', async () => {
  const { data } = await j('GET', '/v2/l4/assets?pageSize=5')
  const item = data.items.find((x) => x.fileId === shared.l4)
  assert.ok(item)
  assert.ok(item.jobId)
  const jobs = await j('GET', '/v2/l4/jobs?pageSize=2')
  assert.ok(jobs.data.total >= 1)
  assert.equal(jobs.data.items.length, Math.min(jobs.data.total, 2))
})

/* ================= 桶对账 / 设置 / 技能 ================= */

test('桶 sync：对账补录（清空索引后 sync 应找回）', async () => {
  // 索引已 SQLite 化：直接清空 l3 的索引行模拟索引缺失，桶内文件仍在
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync('data-test/assets.db')
  db.prepare("DELETE FROM assets WHERE bucket = 'l3'").run()
  db.close()
  const before = await j('GET', '/v2/l3/assets')
  assert.equal(before.data.total, 0)
  const sync = await j('POST', '/v2/buckets/l3/sync')
  assert.equal(sync.status, 200)
  assert.equal(sync.data.ok, true)
  assert.ok(sync.data.added >= 1)
  const after = await j('GET', '/v2/l3/assets')
  assert.ok(after.data.total >= sync.data.added)
  assert.ok(after.data.items.some((x) => x.fileId === shared.l3))
})

test('设置：PUT buckets 增量合并，四桶配置回读', async () => {
  const put = await j('PUT', '/v2/settings', {
    buckets: { l2: { driver: 'oss', endpoint: 'https://oss-cn-beijing.aliyuncs.com', bucket: 'test-l2', accessKeyId: 'AK', secretAccessKey: 'SK', region: 'oss-cn-beijing' } },
  })
  assert.equal(put.status, 200)
  const { data } = await j('GET', '/v2/settings')
  assert.equal(data.buckets.l2.driver, 'oss')
  assert.equal(data.buckets.l1.driver, 'local')
  // 测连通（oss 配置指向假 endpoint，应返回 ok:false 而非 500 崩溃）
  const test = await j('POST', '/v2/buckets/l2/test')
  assert.equal(test.status, 500) // 连不上 → ok:false 错误响应
})

test('设置持久化：重启后配置仍在；apiKey 不被无 Key 的保存抹掉', async () => {
  // 重启服务（同一数据目录），桶配置应从 settings.json 恢复
  await restartServer()
  const s1 = await j('GET', '/v2/settings')
  assert.equal(s1.data.buckets.l2.driver, 'oss', '重启后 l2 仍为 oss')
  // 写入 apiKey → 模拟不带 apiKey 的保存 → Key 不被抹掉
  await j('PUT', '/v2/settings', { apiKey: 'mm_test_key_123' })
  await j('PUT', '/v2/settings', { baseUrl: 'https://api.minimax.cn' })
  const s2 = await j('GET', '/v2/settings')
  assert.equal(s2.data.hasKey, true, 'apiKey 保存后持久存在')
  assert.equal(s2.data.keyTail, 'ey_123')
  // 还原：清 Key、l2 回 local（供后续用例）
  await j('PUT', '/v2/settings', {
    apiKey: '',
    buckets: { l2: { driver: 'local', endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '', region: '', publicBaseUri: '' } },
  })
  const s3 = await j('GET', '/v2/settings')
  assert.equal(s3.data.hasKey, false)
  assert.equal(s3.data.buckets.l2.driver, 'local')
  const localTest = await j('POST', '/v2/buckets/l2/test')
  assert.equal(localTest.status, 200)
  assert.equal(localTest.data.ok, true)
})

test('技能：上传 → 列表 → 停用 → 删除', async () => {
  const fd = new FormData()
  fd.append('files', new Blob([Buffer.from('# 双11海报规范\n- 主标题不超过两行')], { type: 'text/markdown' }), '规范.md')
  fd.append('scope', 'qc')
  const up = await fetch(`${B}/v2/skills`, { method: 'POST', body: fd })
  assert.equal(up.status, 201)
  const { id } = (await up.json()).items[0]
  const list = await j('GET', '/v2/skills')
  assert.ok(list.data.items.some((x) => x.id === id && x.enabled === true))
  assert.deepEqual(list.data.items.find((x) => x.id === id).scope, ['qc'])
  // 修改 scope → html（L2 HTML 生成引擎注入）
  const sc = await j('POST', `/v2/skills/${id}/scope`, { scope: 'html,copy' })
  assert.equal(sc.status, 200)
  const list1 = await j('GET', '/v2/skills')
  assert.deepEqual(list1.data.items.find((x) => x.id === id).scope, ['html', 'copy'])
  // 全文预览接口
  const content = await j('GET', `/v2/skills/${id}/content`)
  assert.equal(content.status, 200)
  assert.match(content.data.content, /双11海报规范/)
  assert.equal((await j('GET', '/v2/skills/no-such-id/content')).status, 404)
  const off = await j('POST', `/v2/skills/${id}/enabled`, { enabled: false })
  assert.equal(off.status, 200)
  const list2 = await j('GET', '/v2/skills')
  assert.equal(list2.data.items.find((x) => x.id === id).enabled, false)
  assert.equal((await j('DELETE', `/v2/skills/${id}`)).status, 200)
  assert.ok(!(await j('GET', '/v2/skills')).data.items.some((x) => x.id === id))
})

test('鉴权：设置 apiKeys 后无 Key 请求 → 401，带 Key → 200', async () => {
  // 此时鉴权未开启（apiKeys 空），本次 PUT 不需要 Key
  await j('PUT', '/v2/settings', { apiKeys: ['secret-key-1'] })
  const noKey = await fetch(`${B}/v2/l1/assets`)
  assert.equal(noKey.status, 401)
  const withKey = await fetch(`${B}/v2/l1/assets`, { headers: { 'X-API-Key': 'secret-key-1' } })
  assert.equal(withKey.status, 200)
  // 关闭鉴权的 PUT 必须携带 Key
  const off = await j('PUT', '/v2/settings', { apiKeys: [] }, 'secret-key-1')
  assert.equal(off.status, 200)
  assert.equal((await fetch(`${B}/v2/l1/assets`)).status, 200)
})

test('清理：删除全部测试素材', async () => {
  const ids = [shared.pattern, shared.plate, shared.product, shared.l2bg, shared.l2html, ...shared.l2extra, shared.l3, shared.l3rework, shared.l4]
  for (const [bucket, method] of [['l1', 'l1'], ['l2', 'l2'], ['l3', 'l3'], ['l4', 'l4']]) {
    const { data } = await j('GET', `/v2/${method}/assets?pageSize=200`)
    const fileIds = data.items.map((x) => x.fileId)
    if (fileIds.length) await j('POST', `/v2/${method}/assets/delete`, { fileIds })
  }
  const l1 = await j('GET', '/v2/l1/assets')
  assert.equal(l1.data.total, 0)
})
