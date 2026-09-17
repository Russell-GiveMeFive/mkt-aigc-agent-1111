---
name: layered-marketing-poster
description: Create fixed-size vertical marketing posters by layering a required background, title artwork, product image, watermark, and optional model image in HTML, then render an exact-size PNG. Use when users describe poster placement or scaling in natural language such as 上方20%、居中、距顶部80px、放大100% or 缩小50%.
---

# Layered Marketing Poster

把用户提供的图片视为一组分层设计资产，生成可复现的 HTML 和最终 PNG。不要重新生成、重绘或擅自改写用户素材。

## 不可破坏的约束

1. 背景图是唯一画布基准。读取它的真实像素宽高，HTML 中 `#poster` 和最终 PNG 必须与之完全一致。
2. 不得为了满足口头的“9:16”而裁剪、补边或拉伸非 9:16 底版。若比例偏差超过 1%，先说明“底版尺寸优先”，继续按底版输出；只有用户明确授权时才另做 9:16 版本。
3. 背景、标题、商品、水印均为必需输入；模特可选。保持图片纵横比，不改文字内容、Logo、商品包装和水印。
4. 同尺寸透明 PNG 默认是“注册图层”：以 `left:0; top:0; width:canvasWidth; height:canvasHeight` 原位叠加。移动和缩放时，以 alpha 可见内容边界为准，而不是以整张透明画布边界为准。
5. 不透明素材不能假装已经去背。用户要求把不透明模特照作为独立人物层时，说明其矩形背景会保留，并优先请用户提供透明 PNG；未经明确要求，不调用生成式图片编辑。
6. 用户给出的精确位置和缩放指令高于自动审美调整。不要为了“更好看”静默偏移或改倍率。
7. 用户说“商品中心”“商品的几何中心”时，唯一合法含义是：商品 alpha 非透明可见轮廓的轴对齐外接矩形中心，即 `((left+right)/2, (top+bottom)/2)`。禁止使用 PNG 整张画布中心、CSS 元素中心、alpha 重心、视觉重心、底边或经验位置替代。

## 严格参数模式

当用户出现“固定为”“最终倍率”“严格执行”“不得自动调整”“scale = N”或明确要求超过 `2×` 时，进入严格参数模式：

- 将该层写为 `strictScale: true`，并令 `requestedScale` 与 `scale` 等于用户要求的最终倍率。
- **不存在 `2×`、`200%` 或任何其他倍率上限。** 不得使用 `Math.min()`、`max-width`、安全区、完整露出、比例协调或审美判断限制精确倍率。
- 精确倍率导致图层超出画布时，保留该倍率并由 `#poster { overflow:hidden }` 自然裁切。只报告裁切，不回退倍率。
- “完整海报模式”表示交付完整的 HTML、PNG 和布局数据，**不表示每个图层必须完整露出**。
- “协调”“大小合适”“位于中央”等软要求不能覆盖精确数值。只有用户明确说“可以自动调整倍率”时才允许改动。
- “缩放到300%”“最终为300%”按最终 `3.0×` 执行；“增加300%”表示最终 `4.0×`。“放大300%”单独出现时有歧义：若同句给出 `scale=3.0`，以 `scale=3.0` 为准，否则先确认，不得自行改成 `2.0×`。
- 必须使用截图脚本的 `--expect-scale layer-id=N` 做渲染态断言。断言失败则任务未完成，不能交付截图。

精确位置同样属于严格参数。用户说“画布正中央向上100px”时，必须计算成：

```text
targetX = canvasWidth / 2
targetY = canvasHeight / 2 - 100
```

该目标点必须与缩放后的商品几何中心重合。层配置写入 `anchor: "center"`、`strictPosition: true`、`requestedCenter: [targetX,targetY]`，并使用 `--expect-center product=targetX,targetY` 验证最终 DOM；误差超过 1px 不得交付。

## 工作流

1. 收集并确认角色：`background`、`title`、`product`、`watermark`，以及可选 `model`。多商品时把每个商品作为独立层。
2. 运行 `scripts/probe_assets.py` 检查尺寸、alpha、`geometry_box` 和 `geometry_center`。定位商品时使用 `geometry_box`，不得重新猜中心。例如：

   ```bash
   python3 scripts/probe_assets.py \
     --background /path/bg.png --title /path/title.png \
     --product /path/sku.png --watermark /path/watermark.png \
     --output /path/layout-probe.json
   ```

3. 解析用户的位置和缩放语言。遇到位置、锚点或“放大/放大到”的歧义时，读取 [references/layout-language.md](references/layout-language.md)。把解析结果写进项目的 `layout.json`，保留原话与数值映射，便于复核。
4. 从 `assets/poster-starter.html` 复制起步文件，替换 `POSTER_CONFIG`。图片 URL 使用绝对 `file://` URI或复制进项目的相对路径；不要把图片 base64 塞进 HTML，除非用户要求单文件交付。
5. 先建立层级：背景 `z=0`，装饰/模特通常 `z=10`，商品 `z=20`，标题 `z=30`，水印 `z=100`。若用户明确要求遮挡关系，以用户要求为准。
6. 做一次视觉平衡检查。标题先保证可读，商品是主体，水印只保证合规可见；阴影、滤镜和混合模式默认关闭，只在与底版光照明显不协调且不会改变品牌资产时克制使用。视觉平衡检查只能调整未锁定的参数，不能修改严格参数。
7. 用 `scripts/render_poster.py` 截图，并按 [references/quality-checklist.md](references/quality-checklist.md) 验证：

   ```bash
   python3 scripts/render_poster.py /path/poster.html --output /path/poster.png
   ```

   用户指定精确倍率时必须追加断言，例如：

   ```bash
   python3 scripts/render_poster.py /path/poster.html \
     --output /path/poster.png \
     --expect-scale product=3.0 --expect-scale title=0.65 \
     --expect-center product=540,860
   ```

8. 交付 `poster.html`、`poster.png`、`layout.json`。报告画布尺寸、是否严格 9:16、每层最终的可见锚点和倍率；不要只交截图而丢掉可编辑 HTML。

## 默认设计判断

- 用户没有给某层位置时，同尺寸透明图层保留原始注册位置，因为它往往已经由设计师在底版坐标系中排好。
- 非同尺寸透明商品图默认把可见内容中心放在画面水平中心、垂直约 62% 处，并限制在安全区内；这只适用于用户没有指定精确倍率和位置的自动布局。
- 标题与商品至少保留约 `0.025 × min(W,H)` 的视觉间隔，除非参考稿有明确重叠关系。
- 水印保持原始比例和透明度，默认使用素材中的注册位置；没有注册信息时放右下安全区。
- 可选模特只有在用户提供透明素材或明确接受矩形照片时才加入。

## HTML 产出要求

- 使用静态 HTML/CSS/少量原生 JS；不需要 React、CDN、网络字体或远程依赖。
- `html, body` 必须无 margin、无滚动条；`#poster` 使用固定像素尺寸和 `overflow:hidden`。
- 背景必须完整铺满且不发生 `cover` 裁切。输入尺寸与底版一致时按 1:1 像素渲染。
- 每层保留语义化 `id`、`data-role` 和配置注释，方便后续按“标题再上移 40px”增量修改。
- 渲染前等待全部图片 `decode()` 完成；任何素材加载失败都应让截图脚本失败，而不是输出残缺海报。
