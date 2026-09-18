# Job schema

Write UTF-8 JSON with absolute paths:

```json
{
  "background": "/absolute/path/background.png",
  "title": "/absolute/path/title.png",
  "model": "/absolute/path/model.png",
  "product": "/absolute/path/product.png",
  "watermark": "/absolute/path/watermark.png",
  "outputDir": "/absolute/path/output",
  "productClass": "auto",
  "modelSide": "auto",
  "hierarchy": "balanced",
  "brief": "人物和商品完整呈现，组合居中，互不遮挡"
}
```

Enums:

- `productClass`: `auto`, `small-handheld`, `medium`, `large`
- `modelSide`: `auto`, `left`, `right`
- `hierarchy`: `balanced`, `model-led`, `product-led`

All five asset paths and `outputDir` are required. Unknown fields are ignored and never become HTML or shell code.
