#!/usr/bin/env python3
"""Inspect poster assets and emit dimensions, alpha bounds, and ratio metadata."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from PIL import Image


ROLE_ARGS = ("background", "title", "product", "watermark", "model")


def inspect_image(role: str, raw_path: str) -> dict[str, Any]:
    path = Path(raw_path).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"{role}: file not found: {path}")

    with Image.open(path) as image:
        image.load()
        width, height = image.size
        bands = image.getbands()
        has_alpha = "A" in bands
        alpha_min = alpha_max = None
        visible_box = [0, 0, width, height]

        if has_alpha:
            alpha = image.getchannel("A")
            alpha_min, alpha_max = alpha.getextrema()
            bbox = alpha.getbbox()
            visible_box = list(bbox) if bbox else [0, 0, 0, 0]

        left, top, right, bottom = visible_box
        visible_width = max(0, right - left)
        visible_height = max(0, bottom - top)
        visible_area_ratio = (
            (visible_width * visible_height) / (width * height) if width and height else 0
        )

        return {
            "role": role,
            "path": str(path),
            "file_uri": path.as_uri(),
            "format": image.format,
            "mode": image.mode,
            "width": width,
            "height": height,
            "aspect_ratio": round(width / height, 8),
            "has_alpha_channel": has_alpha,
            "has_transparency": bool(has_alpha and alpha_min is not None and alpha_min < 255),
            "alpha_range": [alpha_min, alpha_max] if has_alpha else None,
            "visible_box": visible_box,
            "geometry_box": visible_box,
            "geometry_center": [
                round((left + right) / 2, 4),
                round((top + bottom) / 2, 4),
            ],
            "visible_box_normalized": [
                round(left / width, 6),
                round(top / height, 6),
                round(right / width, 6),
                round(bottom / height, 6),
            ],
            "visible_area_ratio": round(visible_area_ratio, 6),
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    for role in ROLE_ARGS:
        parser.add_argument(f"--{role}", action="append" if role == "product" else "store")
    parser.add_argument("--output", type=Path, help="Optional JSON output path")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.background:
        raise SystemExit("--background is required")

    assets: list[dict[str, Any]] = []
    for role in ROLE_ARGS:
        value = getattr(args, role)
        if not value:
            continue
        values = value if isinstance(value, list) else [value]
        assets.extend(inspect_image(role, item) for item in values)

    background = next(item for item in assets if item["role"] == "background")
    target_ratio = 9 / 16
    actual_ratio = background["aspect_ratio"]
    payload = {
        "canvas": {
            "width": background["width"],
            "height": background["height"],
            "aspect_ratio": actual_ratio,
            "target_9_16_ratio": target_ratio,
            "ratio_delta_percent": round(abs(actual_ratio - target_ratio) / target_ratio * 100, 4),
            "is_strict_9_16": abs(actual_ratio - target_ratio) / target_ratio <= 0.01,
        },
        "assets": assets,
    }

    rendered = json.dumps(payload, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output:
        output = args.output.expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
