# 素材工厂 v2 · API 说明文档

三层素材模型开放接口。Base URL: `http://<host>:8788`，全部 JSON（文件上传除外）。

**鉴权**：设置页配置了 API Key 列表后，所有 `/v1` `/v2` 请求需带请求头 `X-API-Key: <key>`；留空则不鉴权。

**四桶存储**：`l1` 基础素材 / `l2` 平台合成素材 / `l3` 商家最终海报 / `l4` 视频合成。每桶独立配置 `local`（本地磁盘）或 `oss`（S3 兼容对象存储）。所有桶内资源经统一代理访问：`GET /v2/files/{bucket}/{fileId}`。

**fileId 规则**：`{category前缀}_{时间戳36进制}{6位随机hex}.{扩展名}`，如 `plate_mtymcg7xc1ae59.png`。fileId 即唯一文件标识符，全链路引用它。

**分页查询**：所有列表接口（L1/L2/L3/L4 的 assets 与 jobs）统一支持 `?page=1&pageSize=24`（pageSize ≤ 200），统一出参：

```json
{ "items": [...], "total": 19, "page": 1, "pages": 4, "pageSize": 5, "hasMore": true }
```

列表读取的是**本地素材库索引**（SQLite：`data/assets.db`，L1/L2/L3/L4 各层素材统一入库，首次启动自动从旧 `buckets-meta/*.json` 迁移），零 OSS 请求；桶内容与索引通过对账接口同步：`POST /v2/buckets/:bucket/sync`（全量列举一次桶——OSS 内部循环翻页取全，把索引之外的对象按前缀推断类别补录；返回 `{ok, objects, added}`）。正常读写都会自动维护索引，sync 用于外部直传/对账。

**MOCK 模式**：未配置 MiniMax API Key 时全链路本地模拟（LLM 模板 / 启发式 QC / ffmpeg 合成视频），接口协议与 LIVE 完全一致。

---

## 目录

- [通用](#通用)
- [L1 基础素材](#l1-基础素材)
- [L2 平台合成素材](#l2-平台合成素材)
- [L3 商家最终营销海报](#l3-商家最终营销海报)
- [L4 视频合成](#l4-视频合成)
- [设置（含四桶）](#设置含四桶)
- [技能](#技能)
- [v1 兼容接口](#v1-兼容接口)

---

## 通用

### GET /v2/meta

枚举与运行状态。

```json
{
  "buckets": ["l1", "l2", "l3", "l4"],
  "l1Categories": [
    { "key": "plate", "label": "底版图", "accept": "image/*" },
    { "key": "pattern", "label": "花纹", "accept": "image/*" },
    { "key": "arttext", "label": "艺术字字体样式", "accept": "image/*" },
    { "key": "product", "label": "商品图", "accept": "image/*" },
    { "key": "model", "label": "模特图", "accept": "image/*,video/mp4" },
    { "key": "watermark", "label": "水印", "accept": "image/*" },
    { "key": "labelstyle", "label": "标签样式", "accept": "image/*" }
  ],
  "renderer": "html-screenshot",
  "mock": true
}
```

### GET /v2/files/:bucket/:fileId

读取任意桶内资源（图片 / 视频 / HTML 存档），带 1h 缓存头。

---

## L1 基础素材

用户上传的原始素材，七类 category，fileId 前缀即 category。

### POST /v2/l1/assets — 上传（多文件 = 批量）

`multipart/form-data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `category` | text | 必填，`plate/pattern/arttext/product/model/watermark/labelstyle` |
| `files[]` | file | 一个或多个文件；图片，或 model 类的 mp4 |
| `names` | text | 可选，JSON 数组，与 files 对应的自定义名称 |

```bash
curl -X POST http://localhost:8788/v2/l1/assets \
  -F category=plate -F files=@底版.png -F files=@底版2.png
```

返回 `201`：

```json
{ "items": [ { "fileId": "plate_mtymcg7xc1ae59.png", "url": "/v2/files/l1/plate_mtymcg7xc1ae59.png",
    "category": "plate", "name": "底版", "size": 12345, "createdAt": 1700000000000 } ], "total": 1 }
```

### GET /v2/l1/assets?category=plate — 列表（可按类过滤）

### DELETE /v2/l1/assets/:fileId — 删除单个

### POST /v2/l1/assets/delete — 批量删除

```json
{ "fileIds": ["plate_x.png", "pattern_y.png"] }
```

---

## L2 平台合成素材

### POST /v2/l2/compose-bg — 自然语言合成背景

选 L1 基础素材 + 一句自然语言 → **LLM 生成 720×1440 HTML（绝对定位精细控制）→ 无头 Chrome 截图** → 存入 L2 桶（PNG + HTML 存档）。

```json
{
  "itemIds": ["plate_x.png", "pattern_y.png"],
  "instruction": "底版铺满整张背景，金色粒子以 25% 透明度平铺，艺术字放上方居中",
  "name": "红金粒子 v2"
}
```

返回 `201`（含生成的 HTML 全文，便于微调后重生成）：

```json
{
  "fileId": "l2bg_mtymbsrac9a354.png", "url": "/v2/files/l2/l2bg_mtymbsrac9a354.png",
  "name": "红金粒子 v2", "instruction": "…", "htmlFileId": "l2bg_mtymbsrac9a354.html",
  "source": "minimax-m3+screenshot", "pipeline": false,
  "html": "<!DOCTYPE html>…"
}
```

`source` 组成：`{LLM来源}+{渲染方式}`；LLM 来源 `minimax-m3`（LIVE）/ `mock-template`（MOCK），渲染方式 `screenshot`（Chrome 截图）/ `fallback`（无浏览器时 sharp 渐变兜底）。

### POST /v2/l2/compose-bg/batch — 批量衍生

```json
{ "jobs": [ { "itemIds": ["…"], "instruction": "…" }, { "itemIds": ["…"], "instruction": "…" } ] }
```

### POST /v2/l2/pipeline — 加入 / 退出生产管线（批量）

被标记的背景才有资格进入 L3 自动生成。

```json
{ "fileIds": ["l2bg_x.png"], "enabled": true }
```

### GET /v2/l2/assets?pipeline=1 — 列表（`pipeline=1/true` 只看管线内，`pipeline=0` 只看管线外）

> 「加入生产管线」的 L2 海报即视频合成素材：`POST /v2/l4/generate` 直接传 `l2bg_*` fileId 即可（服务端按前缀双桶兼容，UI 上 L4 页「选择海报」即此数据源）。

### DELETE /v2/l2/assets/:fileId · POST /v2/l2/assets/delete — 单个 / 批量删除

---

## L3 商家最终营销海报

### POST /v2/l3/generate — 管线生成

`bgFileId` 必须是**已加入生产管线**的 L2 背景。合成（720×1440 京东版式）→ QC 裁判打分 → 缺陷自动修复（≤ `maxRepairRounds` 轮）→ 海报落 L3 桶。

```json
{
  "bgFileId": "l2bg_x.png",
  "productFileId": "product_y.png",
  "modelFileId": "model_z.png",
  "modelVideoFileId": "model_v.mp4",
  "copySlots": {
    "headline": "双11狂欢价\n好物到手",
    "productName": "限定礼盒", "price": "299", "oldPrice": "599",
    "cta": "立即抢购", "promo": "前2小时5折"
  },
  "generateVideo": false
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `bgFileId` | ✓ | L2 桶内、已标记生产管线 |
| `productFileId` | ✓ | L1 商品图 |
| `modelFileId` | | L1 模特图（与 modelVideoFileId 互斥优先视频） |
| `modelVideoFileId` | | L1 模特 mp4 → H3 Reference 模式（参考视频驱动动效） |
| `copySlots` | | 文案槽位直传；缺省自动生成 |
| `generateVideo` | | 完成后直接送 L4 |

返回 `202`：`{ "jobId": "t…", "status": "running", "poll": "/v2/l3/jobs/t…" }`（异步任务，轮询获取结果）

### POST /v2/l3/generate/batch — 批量衍生

```json
{ "items": [ { "bgFileId": "…", "productFileId": "…" }, … ] }
```

### POST /v2/l3/rework — 再加工（换商品图）

对**本系统生成的**海报更换商品图重新合成（沿用原背景 / 模特 / 文案）：

```json
{ "l3FileId": "l3_x.png", "productFileId": "product_new.png", "generateVideo": false }
```

### POST /v2/l3/rework/batch — 批量：`{ "items": [ { "l3FileId": "…", "productFileId": "…" } ] }`

### GET /v2/l3/jobs?status=done · GET /v2/l3/jobs/:id — 任务列表 / 详情

详情含 `stages[]`（copy→bg→compose→qc→video 各阶段状态）、`qc[]`（verdict：`{pass, score, defects[], repairPlan}`）、`usable`、`qcScore`、`l3FileId`、`copy`。

### GET /v2/l3/assets — 海报库（桶内容 + 关联任务的 QC 分 / 可用率 / 文案摘要）

### DELETE /v2/l3/assets/:fileId · POST /v2/l3/assets/delete — 单个 / 批量删除

---

## L4 视频合成

### POST /v2/l4/generate — 海报 → 竖版视频（motion-agent skill FC）

```json
{ "l3FileId": "l3_x.png", "prompt": "模特微笑着将商品缓缓递向镜头，文字保持静止", "modelFileId": "model_z.png", "videoOpts": { "aspectRatio": "3:4", "resolution": "2K", "duration": 5 } }
```

- `l3FileId`：海报 fileId——接受 `l3_*`（L3 桶）或 `l2bg_*`（L2 桶「生产管线」海报，直通视频，服务端双桶兼容）
- `modelFileId`：可选，L1 模特**图**绑定 → motion-agent 以双图多模态（模特参考图 + 海报）调 M3，点名加载 `h3-live-model` 类技能（function calling）产出 H3 multi-reference 提示词；H3 走双图参考模式（`reference_image ×2`）
- `modelVideoFileId`：可选，L1 模特 **mp4** → H3 Reference 模式（参考视频驱动动效）
- 三种 H3 提交模式（任务详情 `mode` 标注）：`model_ref`（模特图）/ `reference`（模特视频）/ `first_frame`（无模特 I2VA 首帧）
- `videoOpts`：`aspectRatio`（3:4/9:16/1:1）、`resolution`（768P/1080P/2K）、`duration`（4~15s）

motion-agent 阶段全程记录于 `/v2/logs?biz=l4video`（traceId = 任务 id）：`motion-agent·round`（FC 轮次）、`motion-agent·load_skill`（技能全文拉取）、`motion-agent-done`（mode 与 skillsLoaded）、`h3-submit`（H3 taskId + mode）。

返回 `202`：`{ "jobId": "…", "poll": "/v2/l4/jobs/…" }`

### POST /v2/l4/generate/batch — 批量

```json
{ "items": [ { "l3FileId": "l2bg_x.png", "prompt": "…", "modelFileId": "model_z.png" }, { "l3FileId": "l3_y.png", "prompt": "…" } ] }
```

每项独立携带 `modelFileId`（绑定模特走有模特路线，未绑定走无模特路线），逐张提交。

### GET /v2/l4/jobs · GET /v2/l4/jobs/:id · GET /v2/l4/assets — 任务 / 视频库

任务详情出参含：`stages`、`videoTaskId`（H3 taskId）、`videoOpts`、**`modelFileId` / `modelVideoFileId`**（本次绑定的模特图/视频）、`motionPlan`、`l4FileId/l4Url`。

### DELETE /v2/l4/assets/:fileId · POST /v2/l4/assets/delete — 单个 / 批量删除

---

## 设置（含四桶）

### GET /v2/settings · PUT /v2/settings

```json
{
  "apiKey": "eyJ…", "baseUrl": "https://api.minimax.cn",
  "textModel": "MiniMax-M3", "videoModel": "MiniMax-H3", "qcModel": "MiniMax-M3",
  "maxRepairRounds": 2, "concurrency": 2, "mock": false,
  "apiKeys": ["my-client-key"],
  "buckets": {
    "l1": { "driver": "local" },
    "l2": { "driver": "oss", "endpoint": "https://oss-cn-beijing.aliyuncs.com",
            "bucket": "jd-l2", "accessKeyId": "AK", "secretAccessKey": "SK",
            "region": "oss-cn-beijing", "publicBaseUri": "https://cdn.example.com/l2" },
    "l3": { "driver": "local" },
    "l4": { "driver": "local" }
  }
}
```

PUT 为增量合并；每桶字段：`driver`(local|oss) / `endpoint` / `bucket` / `accessKeyId` / `secretAccessKey` / `region` / `publicBaseUri` / `forcePathStyle`。`publicBaseUri` 配置后资源 URL 直接走 CDN 前缀。

### POST /v2/buckets/:bucket/test — 桶连通性测试

返回 `{ "ok": true, "driver": "oss", "objects": 12 }`

### POST /v2/buckets/:bucket/sync — 桶内容对账（补录索引）

全量列举一次桶（OSS 自动循环翻页），索引之外的对象补录进元数据（l1 按 fileId 前缀推断 category），返回 `{ "ok": true, "objects": 12, "added": 3 }`。列表接口不直接读 OSS，依赖此接口（或正常读写流程）维护的本地索引。

---

## 技能

技能 = 上传的 Markdown 文档，注入 QC 裁判（pi Agent）的评审上下文；MOCK 模式不受影响。

### POST /v2/skills — 上传（多文件 = 批量，.md / .txt）

`multipart/form-data`：`files[]` + 可选 `name`。返回 `201 { "items": [ { "id": "skill_x.md", "name": "京东双11海报设计规范", "enabled": true, … } ] }`

### GET /v2/skills — 列表 · POST /v2/skills/:id/enabled — 启停 `{ "enabled": false }` · DELETE /v2/skills/:id

---

## v1 兼容接口

旧单品流水线与批量任务接口保持可用（`POST /v1/jobs`、`POST /v1/jobs/batch`、`GET /v1/jobs/:id`、webhook 回调），鉴权方式与 v2 相同，详见 README。
