# Source-only policy

## Allowed

- Translation, scale, rotation, opacity, blur, brightness, contrast, saturation, and soft shadow applied to selected source pixels.
- A completely stationary base poster plus local title/product transforms.
- Low-opacity registered smoke-only transparent layers made from smoke pixels already present in selected inputs.
- Clipped duplicates of the same poster for subtle local emphasis in flat-safe mode.
- Soft radial or linear illumination fields with no identifiable objects or hard geometric edges.
- Natural clipping at the canvas edge when the user explicitly permits it.

## Forbidden

- Any image, video frame, logo, font rendering, product, model, character, illustration, icon, badge, particle, petal, ribbon, smoke asset, or texture not present in selected inputs.
- OCR-based title replacement or synthetic font substitution.
- Generative fill, inpainting, outpainting, or a guessed clean background unless the user separately authorizes content modification.
- Reusing visible pixels from a reference video.
- BGM, sound effects, narration, or a creator watermark unless requested.
- Whole-poster zoom, pan, drift, push-in, pull-out, or Ken Burns movement unless explicitly requested.

## Pixel-source audit

Before delivery, list every visible layer and its source. A valid flat-safe audit normally contains only:

1. `base`: selected poster image.
2. `title-emphasis`: clipped duplicate of selected poster.
3. `product-emphasis`: clipped duplicate of selected poster.
4. `illumination`: CSS-only soft light/shadow field.
5. `smoke-flow`: full-canvas transparent smoke-only layers; no frame pixels and no scale animation.

If any visible layer cannot be traced to one of those sources, remove it.
