# JD AIGC · 1111 营销素材 AIGC Agent

**独立部署的服务负载**：营销素材生产线（背景 AIGC → 严格版式合成 → QC 裁判 → H3 图生 5s 视频 → 商品×模特批量），内置 **pi 驱动的 QC Judge + Repair Loop** 保障京东可用率，对外提供 **GUI + /v1 开放接口**。

对齐参考素材规格：

| 参考 | 规格 | 本工具对齐 |
|---|---|---|
| 背景/海报样式 `01.jpg` | 紫色氛围、元素位置严格 | 风格库「紫曜梦境」+ 可配置版式 JSON |
| 动效视频 `02.mp4` | 720×1440 · 5s · 25fps · 上静下流动 | 海报 720×1440；I2V 画幅自动跟随首帧 |

## 架构

```
┌────────────────────────────────────────────────┐
│ 营销素材 AIGC Agent（Docker 负载）               │
│                                                │
│  GUI(web/dist) ──▶ API 层 ──┬─ /api/*  控制台   │
│  外部系统 ────────▶ /v1/* ──┘  (X-API-Key)      │
│                     │                          │
│            任务队列(并发/持久化)                 │
│                     │                          │
│  确定性流水线: copy → bg → compose → QC ─▶ video │
│                          ▲        │            │
│                     Repair Loop◀──┘ (≤2轮)      │
│                     │                           │
│            Agent 层（pi 内嵌）                   │
│            · QC Judge: 视觉+京东规范清单          │
│              → JSON verdict（pi-ai complete）    │
│            · 缺陷→阶段参数修复决策                │
└────────────────────────────────────────────────┘
```

- **确定性部分**（合成/队列/API）保持纯代码：可复现、低成本
- **Agent 部分**（QC Judge / Repair）：`@mariozechner/pi-ai` 库级内嵌，openai-completions 协议接 MiniMax；QC 输出严格 JSON verdict（pass/score/defects/repairPlan）
- 可用率 = `GET /api/stats`（通过率/均分/缺陷分布/修复轮次）

## 三层素材资产模型（v2 · 当前）

```
L1 基础素材（用户上传·七类）   →  L2 平台合成素材                 →  L3 商家最终营销海报
├─ plate 底版图                   ├─ 自然语言 → LLM 生成 HTML          ├─ ① 管线生成：L2管线背景
├─ pattern 花纹                   │   （绝对定位精细控制）              │    +商品+模特+文案槽位
├─ arttext 艺术字字体样式          │   → 无头 Chrome 截图                │    → QC裁判 + 修复 ≤2轮
├─ product 商品图                 ├─ 生产管线标记（批量）               ├─ ② 再加工：换商品图重合成
├─ model 模特图（图/mp4）         └─ L2 桶（PNG + HTML 存档）           └─ L3 桶
├─ 水印                                                                 ┌────────────────┐
└─ labelstyle 标签样式                                          L4  →   │ 5s 竖版视频 · H3 │
                                                                        └────────────────┘
```

- 四桶独立存储（L1/L2/L3/L4）：`local` 或 `oss`（S3 兼容），设置页逐桶配置
- GUI 六页签：基础素材 / 平台合成素材 / 商家最终海报 / 视频合成 / 设置 / 技能
- 技能 = 上传 Markdown，注入 QC 裁判（pi Agent）上下文
- **所有接口均有批量衍生变体；所有资源可单个/批量删除；完整接口文档见 `docs/API.md`**

<details>
<summary>v1 三层资产模型（旧，仍兼容）</summary>

```
L1 基础素材（用户上传）          L2 合成素材（用户上传/输入）              L3 最终素材
├─ plate 背景底版图        →    ├─ bg 合成背景图 ← L1组合 或 AIGC     ┌────────────────┐
├─ pattern 花纹                 ├─ product 商品                       │ L3 底版静态图    │
└─ arttext 艺术字字效           ├─ model_image 模特图 / model_video    │ = bg+商品+模特+文案
                               └─ copy 替换文案（用户输入槽位）          │   按严格版式合成
                                                                    └───────┬────────┘
                                                            QC 裁判 + 修复 ≤2轮
                                                                            ▼ 动起来
                                                              5s 投流素材（模特视频 → H3 Reference 模式）
```

- **背景三条路**：AIGC 风格图（image-01/mock）/ 库选合成背景 / L1 现场组合（底版+花纹层，混合模式+透明度+平铺）
- **文案槽位制**：文案库 CRUD + AI 润色（只出候选不覆盖）；流水线按槽位精确贴版
- **模特视频**：LIVE 走 H3 r2va（reference_video 驱动人物动效 + reference_image 海报保版式，与首帧模式互斥）
- 接口：`GET/POST /api/assets`（`?level=&kind=`）、`POST /api/assets/upload`（kind）、`POST /api/compose-bg`、`/api/copies` CRUD + `POST /api/copies/:id/polish`

</details>

## 快速开始（本地）

```bash
pnpm install
pnpm dev        # 构建前端 + 启动服务 → http://localhost:8788
```

- **MOCK 模式**（默认）：未填 Key 时全流程本地模拟——mock 背景、mock 文案、ffmpeg 合成 5s ken-burns 视频，无需联网即可演示完整闭环。
- **LIVE 模式**：页面「设置」→ 填入 MiniMax API Key → 保存即切换真实调用链路。

## 流水线

```
素材库(商品×N + 模特×M + 风格库)
  │
  ├─ ① 文案    MiniMax-M3 → 结构化 JSON（标题/价格/CTA/促销标签/视频动效prompt）
  │            · M3 走 Anthropic 兼容 Messages API：POST {base}/anthropic/v1/messages
  │            · thinking 参数可控（HTML 合成用 adaptive，JSON 产出用 disabled）
  ├─ ② 背景    image-01 文生图（9:16 生成）→ 720×1440
  ├─ ③ 合成    sharp 严格版式：模特静区 + 商品白卡 + 价格 + 标题 + CTA + 促销标签
  │            └ 底部自动渐变 scrim，保证任何背景下文字可读
  ├─ ④ 视频    MiniMax-H3 I2VA：海报为首帧 + 动效 prompt → 5s 720×1440 MP4
  └─ ⑤ 批量    商品 × 模特 全组合 → 任务队列（并发可配 / 断点状态持久化）
```

### 严格版式规范 v2（`server/layout.js`，对齐 01.jpg 京东官方素材结构，可整体覆盖）

| 区域 | 坐标 (x, y, w, h) | 说明 |
|---|---|---|
| header | 0, 0, 720, 128 | 京东红门头带「京东11.11 又便宜又好」+ Joy 占位 |
| festival | 0, 144, 720, 72 | 节日白色胶囊芯片（活动名 + 档期） |
| headline | 40, 236, 640, 200 | 大字标题（≤2 行，字号按行宽自适应，白描边） |
| badge | 516, 356, Ø152 | 价格圆形角标（到手价 + 划线原价，叠标题右下） |
| model | 80, 470, 560, 660 | 模特主视觉（透明底 contain 静区） |
| product | 210, 930, 300, 300 | 商品图（glow 辉光垫底适配白底图 / card / none） |
| productPill | 110, 1246, 500, 54 | 商品名白色胶囊 |
| cta / promo | 44/292, 1324 | CTA 胶囊 + 促销标签 |

风格 accent/角标配色随风格库（`server/styles.js` 的 `layoutStyle`）联动，任务 options.layout 可逐项覆盖。

### 85% 可用率的保障策略

1. **确定性合成**：商品/模特/文字为图层精确贴放（非整图 AIGC 重绘），位置 100% 合规；
2. **scrim 垫层**：文字区自动加深色渐变，可读性不依赖背景明暗；
3. **QC Judge Agent**（`server/agent/qcAgent.js`）：每张海报按京东规范清单视觉裁判（文字可读性/主体完整性/位置合规/四要素齐全/AI 瑕疵），输出严格 JSON verdict；
4. **Repair Loop**（≤ `maxRepairRounds`=2 轮）：缺陷码 → 阶段修复决策（`bg` 收紧风格关键词重生成 / `compose` 加深 scrim·加粗描边·放大商品区 / `copy` 缩短标题）→ 复检闭环；
5. **人工抽检兜底**：画廊页终审，`/api/stats` 实时给出可用率/均分/缺陷分布。

## API

### 控制台接口 `/api/*`（GUI 使用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | `/api/settings` | Key、模型（含 qcModel）、并发、maxRepairRounds、apiKeys、版式 |
| POST | `/api/settings/test` | 连通性测试 |
| GET | `/api/stats` | 可用率统计（通过率/均分/缺陷直方图/修复次数） |
| GET | `/api/styles` | 背景风格库 |
| GET/POST/DELETE | `/api/assets*` | 素材库（`/upload` 上传、`/placeholders` 占位生成） |
| POST | `/api/copy` | 文案生成（M3） |
| POST | `/api/tasks` / `/api/batch` | 单品流水线 / 批量矩阵任务 |
| GET | `/api/tasks` `/api/tasks/:id` | 任务列表 / 详情（含 qc verdicts） |
| GET | `/api/gallery` | 产出画廊 |

任务状态机：`queued → running → done/failed/canceled`，阶段：`copy → bg → compose(L3) → qc → video`。
产物落盘 `data/outputs/<taskId>/{bg,poster,video}.*`，经 `/files/` 静态访问。

### 开放接口 `/v1/*`（外部系统调用，X-API-Key 鉴权）

在设置 `apiKeys` 中配置调用方 Key（留空 = 鉴权关闭，仅限开发环境）。

```bash
# 提交异步任务
curl -X POST http://host:8788/v1/jobs \
  -H "X-API-Key: <key>" -H "Content-Type: application/json" \
  -d '{
    "productId": "prod-xxx", "modelId": "model-xxx",
    "styleId": "violet-dream", "promo": "双11狂欢价", "price": "¥299",
    "generateVideo": true,
    "webhookUrl": "https://your-system/callback"   # 可选，完成时 POST 结果
  }'
# → 202 { "jobId": "t...", "status": "queued", "poll": "/v1/jobs/t..." }

# 轮询任务（含 stages / qc verdicts / 产物 URL）
curl http://host:8788/v1/jobs/t... -H "X-API-Key: <key>"

# 批量（商品×模特矩阵）
curl -X POST http://host:8788/v1/jobs/batch -H "X-API-Key: <key>" \
  -H "Content-Type: application/json" \
  -d '{"productIds":["a","b"],"modelIds":["m1","m2"],"styleId":"red-gold"}'

# 服务健康 + 实时可用率
curl http://host:8788/v1/health -H "X-API-Key: <key>"
```

webhook 回调体：`{event, jobId, usable, qcScore, poster, video, error}`。

## 部署（Docker 负载）

```bash
cp .env.example .env        # 填 MINIMAX_API_KEY（也可启动后在设置页填）
docker compose up -d --build
# 服务 → http://<host>:8788（GUI + API 同端口）
# 数据卷 ./data：素材库 / 任务 / 产出 / 设置
```

## 目录结构

```
server/        config · minimax(api客户端) · styles(风格库) · layout(版式)
               assets(三层素材注册表) · bgcompose(L1→L2背景合成) · copies(L2文案库)
               placeholders(三层占位素材) · compositor(L3合成引擎) · copywriter(文案生成)
               queue(任务引擎+QC修复环路) · routes(REST+/v1) · index(入口)
server/agent/  driver(pi-ai 封装) · qcAgent(京东规范裁判)
web/           React 控制台：单品流水线 / 批量任务 / 画廊 / 素材库(三层) / 文案库 / 设置
ref/           参考素材 01.jpg · 02.mp4
data/          运行时数据（卷挂载，gitignore）
```

## Roadmap

- [x] QC Judge Agent + Repair Loop（可用率闭环）
- [ ] 真实商品图白底检测与去底
- [ ] 更多输出规格（800×800 主图 / 1080×1440 竖图 / 1920×600 banner）
- [ ] H3 Reference 模式（≤9 参考图直接组合生成）
- [ ] 京东京准通投放规格预设与一键打包
