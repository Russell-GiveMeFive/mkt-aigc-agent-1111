import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data')
export const ASSETS_DIR = path.join(DATA_DIR, 'assets')
export const OUTPUTS_DIR = path.join(DATA_DIR, 'outputs')
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')

for (const d of [DATA_DIR, ASSETS_DIR, OUTPUTS_DIR]) fs.mkdirSync(d, { recursive: true })

const DEFAULTS = {
  // MiniMax API Key：优先从页面设置读取；留空则回退读环境变量 MINIMAX_API_KEY
  apiKey: '',
  // 中国站: https://api.minimaxi.com  国际站: https://api.minimax.io
  baseUrl: 'https://api.minimax.cn',
  textModel: 'MiniMax-M3',
  imageModel: 'image-01',
  videoModel: 'MiniMax-H3',
  videoResolution: '768P', // 768P | 2K
  // QC 裁判视觉模型（pi-ai openai-completions 协议）
  qcModel: 'MiniMax-M3',
  // QC 修复环路轮数上限
  maxRepairRounds: 2,
  mock: false, // MOCK 开关默认 false（LIVE）；设置页/ settings.json 可改；无 apiKey 时 effective() 仍强制 mock
  concurrency: 0, // 批量任务并发；0 = 不限制（H3 为异步任务 API，全部立即提交，由 MiniMax 服务端调度）
  // 对外 /v1 接口的调用方 Key 列表（空 = 鉴权关闭，仅限开发）
  apiKeys: [],
  // 四桶存储：l1 基础素材 / l2 平台合成素材 / l3 商家最终海报 / l4 视频合成
  // 每桶独立配置 driver: local | oss(S3 兼容)
  buckets: {
    l1: { driver: 'local' },
    l2: { driver: 'local' },
    l3: { driver: 'local' },
    l4: { driver: 'local' },
  },
}

let cache = null

export function getSettings() {
  if (cache) return cache
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }
  } catch {
    cache = { ...DEFAULTS }
  }
  if (!cache.apiKey && process.env.MINIMAX_API_KEY) cache.apiKey = process.env.MINIMAX_API_KEY
  cache.buckets = { ...DEFAULTS.buckets, ...(cache.buckets || {}) }
  return cache
}

export function updateSettings(patch) {
  const s = { ...getSettings(), ...patch }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2))
  cache = s
  return s
}

/** 实际生效配置（mock 判定：无 key 即 mock） */
export function effective() {
  const s = getSettings()
  return { ...s, mock: s.mock || !s.apiKey }
}

/** 对外展示用：隐藏 key 明文 */
export function publicSettings() {
  const s = getSettings()
  const { apiKey, ...rest } = s
  return {
    ...rest,
    hasKey: !!apiKey,
    keyTail: apiKey ? apiKey.slice(-6) : '',
    keySource: apiKey ? (process.env.MINIMAX_API_KEY === apiKey ? 'env' : 'settings') : 'none',
  }
}
