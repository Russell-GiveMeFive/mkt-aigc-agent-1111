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


---

# 附 · layout-language.md

# 位置与缩放语言

## 坐标模型

- 画布原点在左上角，`x` 向右、`y` 向下。
- `%` 总是相对底版宽高：`x = p × W`，`y = p × H`。
- 默认定位对象是素材的 **alpha 可见内容边界**。`anchor` 可取 `top-left`、`top-center`、`center`、`bottom-center`、`bottom-right` 等。
- “商品中心”或“商品几何中心”固定指 alpha 可见轮廓轴对齐外接矩形的中心：`((left+right)/2, (top+bottom)/2)`。它不是源 PNG 的整图中心，也不是 alpha 加权重心或主观视觉中心。
- “放在上方 20%”默认解释为“可见内容中心的 `y = 20%H`”；“顶边在上方 20%”才使用可见顶边作为锚点。

## 常见表达映射

| 用户表达 | 数值语义 |
|---|---|
| 居中 / 局中 | 可见内容中心落在 `(50%W, 50%H)` |
| 水平居中 | 保持 `y`，可见内容中心 `x = 50%W` |
| 上方 20% | 默认中心锚点 `y = 20%H` |
| 距离上方 80px / 距顶部 80px | 可见内容顶边 `y = 80px` |
| 距离右边 60px | 可见内容右边 `x = W - 60px` |
| 下移 30px | 当前目标锚点 `y += 30px` |
| 放大 100% | 在当前大小上增加 100%，即 `scale = 2.0 × current` |
| 放大 50% | `scale = 1.5 × current` |
| 放大到 100% | 设置为基准大小，即 `scale = 1.0` |
| 缩放到 300% / 最终为 300% | 最终 `scale = 3.0`，不得限制到 `2.0` |
| 放大 300% | 单独出现时有歧义；若同句明确 `scale=3.0` 则按 `3.0`，否则确认是最终 `3.0×` 还是增加后 `4.0×` |
| 增加 300% | 在当前大小上增加 300%，最终 `scale = 4.0 × current` |
| 缩小 50% | 剩余 50%，即 `scale = 0.5 × current` |
| 缩小到 50% | 设置为基准大小的 50%，即 `scale = 0.5` |
| 两倍大 / 200% 大小 | `scale = 2.0` |

当用户同一句同时给绝对位置与相对移动时，先设置绝对位置，再应用相对位移。多轮修改则基于上一次 `layout.json`，不要重新猜默认值。

“画布正中央向上 Npx”的唯一计算方式：

```text
target = (W/2, H/2-N)
```

把缩放后的 `geometry_box` 中心对齐到这个 target。禁止把商品顶边、底边、原 PNG 中心或未缩放坐标对齐到 target。

## 严格倍率

若用户提供最终倍率、`scale=N` 或声明不得自动调整：

1. 在 HTML 层配置中同时写入 `scale: N`、`requestedScale: N`、`strictScale: true`。
2. 禁止通过安全区、最大宽高、完整显示或视觉协调进行 clamp。
3. 超出画布是合法结果，由海报边界裁切。
4. 截图时传入 `--expect-scale id=N`；只有 DOM 实际倍率等于 N 才能交付。

## 严格中心定位

若用户指定商品几何中心坐标：

1. 配置必须使用探测结果中的 `geometry_box` 作为 `contentBox`。
2. 写入 `anchor: "center"`、`target: [x,y]`、`requestedCenter: [x,y]`、`strictPosition: true`。
3. 缩放与位移必须一次性通过公式计算，不能缩放后再凭视觉拖动。
4. 截图时传入 `--expect-center product=x,y`，容差默认 1px。
5. 中心断言失败时，修正 HTML 并重新截图；不能以“整体协调”为理由忽略。

## 可见边界定位公式

素材像素尺寸为 `Iw × Ih`，可见边界为 `[l,t,r,b]`，倍率为 `s`。选择锚点 `(ax, ay)` 后，希望该锚点落在画布 `(tx, ty)`：

```text
left = tx - ax × s
top  = ty - ay × s
renderedWidth  = Iw × s
renderedHeight = Ih × s
```

例如中心锚点：`ax=(l+r)/2`、`ay=(t+b)/2`；顶部中心：`ax=(l+r)/2`、`ay=t`。这种算法能让带巨大透明留白的全画布 PNG 按真实标题或商品移动。

## 越界与安全区

- 精确用户指令允许有意出血；只提示被裁切比例，不自动修正。
- 自动布局时，标题和商品的主要可见内容应尽量留在 `3%W × 2%H` 的安全区内；严格倍率模式不应用安全区约束。
- 水印不得因自动缩放而小到无法辨认，也不得改变其 alpha；若素材本身极淡，只报告而不擅自加深。
- 若标题或商品放大后遮挡参考底版中的核心装饰，优先微调自动层；用户精确指定的层不动。


---

# 附 · quality-checklist.md

# 海报质量检查

## 硬性检查

- `poster.png` 像素尺寸与背景图完全一致。
- 背景四边完整，无 `object-fit: cover` 裁切、拉伸或额外留白。
- 所有必需图片成功加载；浏览器控制台无 error。
- 标题、商品、水印保持原始纵横比；没有非等比缩放。
- 精确位置和倍率与 `layout.json` 一致。
- 用户指定“商品几何中心”时，渲染后的 `geometry_box` 中心与目标坐标在横纵方向均相差不超过 1px；必须通过 `--expect-center` 断言。
- 若底版不是严格 9:16，交付说明中明确报告实际比例。

## 视觉检查

- 先缩略到手机宽度看 3 秒：标题能读、商品能认、视觉焦点不分裂。
- 再按 100% 查看：透明边缘无黑/白底、商品细节不过度模糊、阴影方向不冲突。
- 标题不压住商品的关键包装文字，除非参考图或用户明确要求重叠。
- 水印处于可见但不抢主体的位置；不修改用户水印内容与透明度。
- 可选模特若带不透明背景，矩形边界必须是有意设计，而不是误当抠图。

## 失败条件

遇到以下任一情况不要交付残缺 PNG：素材 404、图片解码失败、截图尺寸不符、背景被裁切、必需层缺失。修复后重新截图。
