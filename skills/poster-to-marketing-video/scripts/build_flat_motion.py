#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
from PIL import Image


def parse_box(value: str):
    values = [float(item.strip()) for item in value.split(",")]
    if len(values) != 4 or any(item < 0 or item > 1 for item in values):
        raise argparse.ArgumentTypeError("box must be normalized x,y,w,h values between 0 and 1")
    x, y, w, h = values
    if w <= 0 or h <= 0 or x + w > 1 or y + h > 1:
        raise argparse.ArgumentTypeError("box must fit inside the canvas")
    return values


def main():
    parser = argparse.ArgumentParser(description="Build deterministic flat-safe poster animation HTML")
    parser.add_argument("poster", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--title-box", required=True, type=parse_box, help="normalized x,y,w,h")
    parser.add_argument("--product-box", required=True, type=parse_box, help="normalized x,y,w,h")
    parser.add_argument("--product-layer", type=Path, help="full-canvas transparent product-only PNG")
    parser.add_argument("--smoke-layer", action="append", default=[], type=Path, help="repeatable full-canvas transparent smoke-only PNG")
    parser.add_argument("--duration", type=float, default=5.0)
    parser.add_argument("--fps", type=int, default=25)
    parser.add_argument("--plan", type=Path)
    args = parser.parse_args()

    poster = args.poster.expanduser().resolve()
    if not poster.is_file():
        parser.error(f"poster not found: {poster}")
    with Image.open(poster) as image:
        width, height = image.size
    product_layer = None
    if args.product_layer:
        product_layer = args.product_layer.expanduser().resolve()
        if not product_layer.is_file():
            parser.error(f"product layer not found: {product_layer}")
        with Image.open(product_layer) as image:
            if image.size != (width, height):
                parser.error("product layer must be registered to the poster and have the same pixel dimensions")
            if "A" not in image.getbands():
                parser.error("product layer must contain an alpha channel")
    smoke_layers = []
    for candidate in args.smoke_layer:
        smoke_layer = candidate.expanduser().resolve()
        if not smoke_layer.is_file():
            parser.error(f"smoke layer not found: {smoke_layer}")
        with Image.open(smoke_layer) as image:
            if image.size != (width, height):
                parser.error("every smoke layer must be registered to the poster and have the same pixel dimensions")
            if "A" not in image.getbands():
                parser.error("every smoke layer must contain an alpha channel")
        smoke_layers.append(smoke_layer)
    template = Path(__file__).resolve().parent.parent / "assets" / "flat-motion-template.html"
    config = {
        "mode": "flat-safe",
        "width": width,
        "height": height,
        "durationMs": round(args.duration * 1000),
        "fps": args.fps,
        "posterUri": poster.as_uri(),
        "productUri": product_layer.as_uri() if product_layer else None,
        "hasProductLayer": bool(product_layer),
        "titleBox": args.title_box,
        "productBox": args.product_box,
        "smokeUris": [layer.as_uri() for layer in smoke_layers],
    }
    html = template.read_text(encoding="utf-8").replace("__CONFIG_JSON__", json.dumps(config, ensure_ascii=False))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(html, encoding="utf-8")

    plan_path = args.plan or args.output.with_name("motion-plan.json")
    plan = {
        **config,
        "poster": str(poster),
        "backgroundTransform": "none",
        "frameTransform": "none",
        "effects": [
            "locked base poster and decorative frame",
            "soft CSS illumination",
            "source-pixel title scale-and-lift breath",
            "alpha-isolated product scale-and-lift breath" if product_layer else "product motion disabled: no product-only alpha layer",
            "alpha-isolated smoke translation and displacement at fixed scale 1.0" if smoke_layers else "smoke motion disabled",
        ],
        "visible_layers": {
            "base": str(poster),
            "title-emphasis": str(poster),
            "product-emphasis": str(product_layer) if product_layer else "disabled",
            "illumination": "CSS soft light fields",
            "smoke-flow": [str(layer) for layer in smoke_layers] if smoke_layers else "disabled",
        },
        "smokeLayers": [str(layer) for layer in smoke_layers],
        "smokeScale": 1.0,
        "forbidden_elements": [],
    }
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"html": str(args.output.resolve()), "plan": str(plan_path.resolve()), "canvas": [width, height]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
