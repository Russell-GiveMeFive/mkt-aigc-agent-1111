使用 /skill:pi-model-product-marketing-poster 生成带模特的商品营销海报。

最终响应必须直接返回完整HTML。第一个非空白字符必须是`<`并以`<!doctype html>`开头，最后必须以`</html>`结束。不要返回文件路径、JSON、解释文字或Markdown代码块。

严格只使用我提供的背景图、标题艺术字、模特图、商品图和水印图。背景是唯一画布基准，保持原始像素和颜色。模特、商品和标题必须完整显示；人物与商品组成居中的主视觉，比例协调，默认相邻且不遮挡脸部。不得新增文字、图片、人物、装饰、滤镜、光效或色彩蒙层。

请识别五项素材的绝对路径，调用 pi_compose_model_product_poster。禁止自行编写 HTML、CSS、缩放倍率或坐标。如果工具不可用，只允许执行 skill 自带的 scripts/run_poster.py；如果 runtime 也不可用，返回 PIPELINE_UNAVAILABLE。

交付前必须读取 result.json 与 verification.json。result.generator 必须是 pi-model-product-marketing-poster@5.2.0；模特可见高度必须占画布56%～66%，商品可见高度不得低于30%，modelVisible 必须为 true。验证通过后读取poster.html，并把文件完整内容逐字作为最终回复，不得添加任何前缀或后缀。
