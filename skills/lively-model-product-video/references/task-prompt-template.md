# Task prompt template

```text
使用 $lively-model-product-video，把当前选中的模特与商品画面制作成5秒、25fps、竖版、无音频的营销视频。

保持模特身份、五官、发型、年龄、身材、服装和首饰一致；保持商品外形、颜色、标签、文字和结构一致；背景、标题和Logo固定不变，禁止整画面推近或拉远。

模特始终保持真实的镜头意识和鲜活感：自然呼吸，一次不刻意的眨眼，轻微眼球微移后重新看向镜头，笑容有细小变化，头部与肩膀产生自然反向平衡，头发和衣料略微滞后摆动。动作不能同步、机械或循环。

主动作是模特用原本持有商品的手，把商品从胸前自然递向镜头。商品通过真实手臂前伸和透视逐渐变大，不得使用商品图层机械放大代替。手腕、手肘、肩膀和躯干运动必须连贯；商品靠近镜头后占画面宽度约25%～45%，模特面部仍保持大部分可见。商品只允许2～4°的小幅展示角度调整，不得旋转变形。

皮肤保持自然哑光到缎光质感，保留细微毛孔、绒毛、表情纹理和局部肤色差异。高光只能柔和地出现在鼻梁、上颧骨、下唇和合理受光位置；禁止额头与双颊出现整片油光。禁止磨皮、塑料皮肤、蜡像感、湿润油腻感和过度锐化毛孔。

0～0.6秒建立眼神和呼吸；0.6～1.4秒出现一次自然眨眼与轻微笑容变化；1.4～3.2秒手臂将商品递向镜头；3.2～4.4秒保持商品英雄展示位并维持鲜活眼神；4.4～5秒让头发、衣料和呼吸自然收稳，不得完全冻结或淡黑。

不得新增人物、手指、首饰、化妆、道具、文字、粒子或装饰。输出主提示词、负面提示词、motion-plan.json，并在生成后抽取首帧、25%、50%、75%和末帧进行人物、皮肤、手部和商品一致性检查。
```

## Default negative prompt

```text
identity drift, different face, facial asymmetry, facial melting, frozen eyes, dead smile, robotic movement, synchronized body motion, greasy facial shine, oily forehead and cheeks, wet skin, sweaty face, plastic skin, wax figure, porcelain doll, poreless beauty filter, over-smoothed face, airbrushed skin, rubber arm, disconnected shoulder, broken wrist, extra fingers, fused fingers, missing fingers, unstable grip, floating product, product morphing, changing label, unreadable product text, duplicated buttons or cameras, changing product color, background warping, title distortion, logo deformation, whole-frame zoom, camera push-in, sudden motion, jitter, flicker
```

