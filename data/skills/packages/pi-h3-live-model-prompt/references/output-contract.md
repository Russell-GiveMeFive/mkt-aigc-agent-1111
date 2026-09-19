# Output contract

最终回复使用以下简洁结构，不要返回 HTML：

## H3 可直接复制提示词

输出 `h3_prompt` 原文。

## 参考图职责

- 图 1：模特身份、外观、初始姿势和动作依据。
- 图 2：商品、文字、Logo、背景、色彩和广告构图依据；默认使用 multi-reference 合成，不把无人物海报强制设为首帧。

## 建议创建参数

输出 `recommended_params`，至少包含 `model`、`duration`、`resolution`、`ratio`、`audio`。

不要展示内部 chain-of-thought。`image_analysis` 只允许输出简洁的可核验视觉事实；不能输出推理过程。

工具 JSON 契约：

```json
{
  "image_analysis": {
    "model": "可核验的人物外观、姿态、手势、表情",
    "poster": "商品类别、构图、文案及固定元素",
    "motion_rationale": "为什么这些动作符合人物初始姿势与商品属性"
  },
  "reference_mapping": {
    "image_1": "character_reference",
    "image_2": "product_scene_reference"
  },
  "motion_strategy": {
    "action_archetype": "handheld-push-in",
    "human_performance": "人物连续表演动作链",
    "product_showcase": "商品展示路径和 hero moment",
    "background_flow": "背景现有元素的流动方式",
    "title_motion": "标题分组与短促动效"
  },
  "h3_prompt": "一段包含时间线和禁止项的完整提示词",
  "negative_constraints": ["约束 1", "约束 2"],
  "recommended_params": {
    "model": "MiniMax-H3",
    "duration": 5,
    "resolution": "2K",
    "ratio": "adaptive",
    "audio": false,
    "input_mode": "multi_reference"
  },
  "verification": {
    "passed": true,
    "identity_locked": true,
    "poster_locked": true,
    "product_locked": true,
    "pose_compatible": true,
    "timeline_present": true,
    "negative_constraints_embedded": true,
    "product_hero_present": true,
    "background_flow_present": true,
    "title_motion_present": true
  }
}
```
