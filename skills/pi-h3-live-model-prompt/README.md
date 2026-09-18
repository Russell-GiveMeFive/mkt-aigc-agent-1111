# pi-h3-live-model-prompt

这是给 Pi / MiniMax-M3 使用的 H3 提示词生成 Skill。输入一张模特参考图和一张带商品海报，输出可直接复制到 MiniMax H3 的 multi-reference 视频提示词。

## 配置

把解压后的整个目录作为 Pi package 加载，并在启动 Pi 的环境中设置：

```bash
export MINIMAX_API_KEY="你的 MiniMax API Key"
```

API Key 只从环境变量读取，不要写入 Skill 文件。

## 调用示例

```text
使用 $pi-h3-live-model-prompt：
图1是模特参考图，图2是带商品的营销海报。
生成5秒、vivid 动作强度的 H3 创建提示词。
人物必须保持原脸、服装、比例和原始展示手势；
从第一帧起自然进入海报广告场景，动作符合商品属性，皮肤自然不油腻；
人物必须有完整的展示动作和商品 hero close-up，背景现有烟雾/光影/花瓣应流动，
标题做一次短促回弹或重点数字脉冲，不能只是人物原地呼吸。
只输出 H3 提示词、参考图职责和建议参数，不要生成 HTML。
```

## 命令行 fallback

```bash
python3 scripts/generate_h3_prompt.py \
  --model-image "/absolute/path/model.png" \
  --poster-image "/absolute/path/poster.png" \
  --duration 5 \
  --motion-strength vivid \
  --output "/absolute/path/h3-prompt.json"
```

加 `--dry-run` 可在不调用 API 的情况下验证图片、请求结构与 base64 编码；输出会自动隐藏图片 base64 内容。
