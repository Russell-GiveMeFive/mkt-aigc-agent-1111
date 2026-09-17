import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DATA_DIR } from './config.js'
import { buildRouter, buildV1Router } from './routes.js'
import { buildV2Router } from './routesV2.js'
import { getSettings } from './config.js'
import { syncBucketIndex } from './bucketIndex.js'
import * as storage from './storage.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 8788

// 游离 promise 异常兜底（渲染引擎等内部竞态不杀进程）
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.message || err)
})

const app = express()

app.use(express.json({ limit: '4mb' }))
app.use('/api', buildRouter())
app.use('/v1', buildV1Router())
app.use('/v2', buildV2Router())
app.use('/files', express.static(DATA_DIR, { maxAge: '1h' }))

// 托管前端构建产物
const dist = path.join(__dirname, '..', 'web', 'dist')
if (fs.existsSync(dist)) {
  // index.html 永不缓存（保证刷新即拿最新入口与 bundle 引用）；带 hash 的 assets 可长缓存
  app.use(express.static(dist, { index: false, setHeaders: (res, fp) => {
    if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-store')
    else if (/assets\/.+-[A-Za-z0-9_-]+\.(js|css)$/.test(fp)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  } }))
  app.get(/^\/(?!api|files).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.sendFile(path.join(dist, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`[jd-aigc-1111] 素材工厂已启动 → http://localhost:${PORT}`)
  console.log(`[jd-aigc-1111] mock 模式: ${fs.existsSync(path.join(DATA_DIR, 'settings.json')) ? '(见设置)' : '默认开(未填 Key)'}`)
  // 启动即拉取：所有 OSS 桶的内容自动对账进素材库索引（后台执行，不阻塞启动）
  for (const b of storage.BUCKETS) {
    const cfg = getSettings().buckets?.[b]
    if (cfg?.driver !== 'oss' || !cfg.endpoint || !cfg.bucket) continue
    syncBucketIndex(b)
      .then((r) => console.log(`[sync] ${b} 桶对账完成：${r.objects} 个对象，补录 ${r.added} 条索引`))
      .catch((e) => console.error(`[sync] ${b} 桶对账失败: ${e.message}`))
  }
})
