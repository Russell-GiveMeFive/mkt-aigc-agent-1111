#!/usr/bin/env python3
"""Create an aspect-aware side-by-side layout from probe_assets.py JSON."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


PRODUCT_TARGETS = {
    "small-handheld": {
        "productHeightRatioRange": [0.30, 0.46],
        "productToModelHeightRatioRange": [0.48, 0.72],
        "defaultProductHeightRatio": 0.40,
    },
    "medium": {
        "productHeightRatioRange": [0.34, 0.52],
        "productToModelHeightRatioRange": [0.55, 0.85],
        "defaultProductHeightRatio": 0.46,
    },
    "large": {
        "productHeightRatioRange": [0.38, 0.65],
        "productToModelHeightRatioRange": [0.65, 1.05],
        "defaultProductHeightRatio": 0.56,
    },
}


def parse_box(raw: str | None) -> list[float] | None:
    if raw is None:
        return None
    try:
        values = [float(value.strip()) for value in raw.split(",")]
    except ValueError as error:
        raise SystemExit("--face-box-source must contain four numbers") from error
    if len(values) != 4 or values[2] <= values[0] or values[3] <= values[1]:
        raise SystemExit("--face-box-source must be left,top,right,bottom")
    return values


def asset_by_role(payload: dict[str, Any], role: str) -> dict[str, Any]:
    matches = [asset for asset in payload.get("assets", []) if asset.get("role") == role]
    if len(matches) != 1:
        raise SystemExit(f"expected exactly one {role} asset, found {len(matches)}")
    return matches[0]


def visible_dimensions(asset: dict[str, Any]) -> tuple[float, float]:
    left, top, right, bottom = [float(value) for value in asset["geometry_box"]]
    return right - left, bottom - top


def layer(asset: dict[str, Any], target: list[float], scale: float, z_index: int) -> dict[str, Any]:
    source_width = int(asset["width"])
    source_height = int(asset["height"])
    visible_width, visible_height = visible_dimensions(asset)
    return {
        "id": asset["role"],
        "role": asset["role"],
        "src": asset["file_uri"],
        "sourceWidth": source_width,
        "sourceHeight": source_height,
        "sourceAspectRatio": round(source_width / source_height, 10),
        "contentBox": asset["geometry_box"],
        "contentAspectRatio": round(visible_width / visible_height, 10),
        "anchor": "center",
        "target": [round(value, 4) for value in target],
        "scale": round(scale, 10),
        "requestedScale": round(scale, 10),
        "strictScale": True,
        "requestedCenter": [round(value, 4) for value in target],
        "strictPosition": True,
        "opacity": 1,
        "zIndex": z_index,
        "scaleSource": "aspect-aware-planner",
    }


def transform_box(source_box: list[float], asset: dict[str, Any], target: list[float], scale: float) -> list[float]:
    left, top, right, bottom = [float(value) for value in asset["geometry_box"]]
    center_x = (left + right) / 2
    center_y = (top + bottom) / 2
    image_left = target[0] - center_x * scale
    image_top = target[1] - center_y * scale
    return [
        round(image_left + source_box[0] * scale, 4),
        round(image_top + source_box[1] * scale, 4),
        round(image_left + source_box[2] * scale, 4),
        round(image_top + source_box[3] * scale, 4),
    ]


def expand_box(box: list[float], ratio: float, canvas_width: float, canvas_height: float) -> list[float]:
    width = box[2] - box[0]
    height = box[3] - box[1]
    return [
        round(max(0, box[0] - width * ratio), 4),
        round(max(0, box[1] - height * ratio), 4),
        round(min(canvas_width, box[2] + width * ratio), 4),
        round(min(canvas_height, box[3] + height * ratio), 4),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("probe_json", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--product-class", choices=sorted(PRODUCT_TARGETS), default="small-handheld")
    parser.add_argument("--model-side", choices=["left", "right"], default="left")
    parser.add_argument("--model-height-ratio", type=float, default=0.60)
    parser.add_argument("--product-height-ratio", type=float)
    parser.add_argument("--title-height-ratio", type=float, default=0.25)
    parser.add_argument("--group-center-y-ratio", type=float, default=0.65)
    parser.add_argument("--gap-ratio", type=float, default=0.05)
    parser.add_argument("--face-box-source", help="Model-source face box: left,top,right,bottom")
    args = parser.parse_args()

    payload = json.loads(args.probe_json.expanduser().resolve().read_text(encoding="utf-8"))
    canvas = payload["canvas"]
    canvas_width = float(canvas["width"])
    canvas_height = float(canvas["height"])
    background = asset_by_role(payload, "background")
    model = asset_by_role(payload, "model")
    product = asset_by_role(payload, "product")
    title = asset_by_role(payload, "title")
    product_targets = PRODUCT_TARGETS[args.product_class]
    product_height_ratio = (
        args.product_height_ratio
        if args.product_height_ratio is not None
        else product_targets["defaultProductHeightRatio"]
    )

    if not 0.56 <= args.model_height_ratio <= 0.66:
        raise SystemExit("--model-height-ratio must stay within 0.56–0.66")
    product_min, product_max = product_targets["productHeightRatioRange"]
    if not product_min <= product_height_ratio <= product_max:
        raise SystemExit(
            f"--product-height-ratio must stay within {product_min:.2f}–{product_max:.2f}"
        )
    if not 0.12 <= args.title_height_ratio <= 0.30:
        raise SystemExit("--title-height-ratio must stay within 0.12–0.30")
    if not 0.01 <= args.gap_ratio <= 0.10:
        raise SystemExit("--gap-ratio must stay within 0.01–0.10")

    model_visible_width, model_visible_height = visible_dimensions(model)
    product_visible_width, product_visible_height = visible_dimensions(product)
    title_visible_width, title_visible_height = visible_dimensions(title)
    model_scale = canvas_height * args.model_height_ratio / model_visible_height
    product_scale = canvas_height * product_height_ratio / product_visible_height
    title_scale = canvas_height * args.title_height_ratio / title_visible_height
    model_rendered_width = model_visible_width * model_scale
    product_rendered_width = product_visible_width * product_scale
    gap = canvas_width * args.gap_ratio
    group_width = model_rendered_width + gap + product_rendered_width
    if group_width > canvas_width * 0.90:
        raise SystemExit(
            "chosen height ratios produce a group wider than 90% of canvas; "
            "select lower in-range ratios instead of distorting either asset"
        )

    group_left = (canvas_width - group_width) / 2
    if args.model_side == "left":
        model_center_x = group_left + model_rendered_width / 2
        product_center_x = group_left + model_rendered_width + gap + product_rendered_width / 2
    else:
        product_center_x = group_left + product_rendered_width / 2
        model_center_x = group_left + product_rendered_width + gap + model_rendered_width / 2
    group_center_y = canvas_height * args.group_center_y_ratio
    model_half_height = model_visible_height * model_scale / 2
    product_half_height = product_visible_height * product_scale / 2
    top_limit = canvas_height * 0.31
    bottom_limit = canvas_height * 0.97
    min_center_y = max(top_limit + model_half_height, top_limit + product_half_height)
    max_center_y = min(bottom_limit - model_half_height, bottom_limit - product_half_height)
    if min_center_y > max_center_y:
        raise SystemExit("selected ratios cannot fit both full alpha bounds inside the canvas")
    group_center_y = min(max(group_center_y, min_center_y), max_center_y)

    title_rendered_height = title_visible_height * title_scale
    title_center_y = canvas_height * 0.02 + title_rendered_height / 2
    group_top = min(
        group_center_y - model_half_height,
        group_center_y - product_half_height,
    )
    title_bottom = title_center_y + title_rendered_height / 2
    if title_bottom + canvas_height * 0.03 > group_top:
        raise SystemExit(
            "title and subject group cannot fit with a 3% vertical gap; "
            "reduce title/model ratios within their allowed ranges"
        )

    model_target = [model_center_x, group_center_y]
    product_target = [product_center_x, group_center_y]
    title_target = [canvas_width / 2, title_center_y]
    face_source = parse_box(args.face_box_source)
    if face_source is None:
        left, top, right, bottom = [float(value) for value in model["geometry_box"]]
        visible_width = right - left
        visible_height = bottom - top
        face_source = [
            left + visible_width * 0.22,
            top + visible_height * 0.02,
            right - visible_width * 0.22,
            top + visible_height * 0.22,
        ]
        face_box_heuristic = True
    else:
        face_box_heuristic = False
    face_box = transform_box(face_source, model, model_target, model_scale)
    face_safe_box = expand_box(face_box, 0.16, canvas_width, canvas_height)

    product_to_model_ratio = product_height_ratio / args.model_height_ratio
    allowed_ratio = product_targets["productToModelHeightRatioRange"]
    if not allowed_ratio[0] <= product_to_model_ratio <= allowed_ratio[1]:
        raise SystemExit(
            "product/model height ratio is outside its product-class range; "
            "choose compatible height ratios"
        )

    layers = [
        layer(model, model_target, model_scale, 10),
        layer(product, product_target, product_scale, 20),
        layer(title, title_target, title_scale, 30),
    ]
    layout = {
        "canvas": {"width": int(canvas_width), "height": int(canvas_height)},
        "background": {
            "src": background["file_uri"],
            "sourceWidth": background["width"],
            "sourceHeight": background["height"],
        },
        "faceBox": face_box,
        "faceSafeBox": face_safe_box,
        "faceBoxHeuristic": face_box_heuristic,
        "gazeDirection": "front",
        "poseOpening": "front",
        "productClass": args.product_class,
        "occlusionStrategy": "adjacent",
        "compositionTargets": {
            "layoutStyle": "side-by-side",
            "requireFullyVisible": True,
            "forbidModelProductOverlap": True,
            "groupCenterXRange": [0.47, 0.53],
            "groupCenterYRange": [0.58, 0.68],
            "modelHeightRatioRange": [0.56, 0.66],
            "productHeightRatioRange": product_targets["productHeightRatioRange"],
            "productToModelHeightRatioRange": allowed_ratio,
            "groupWidthRatioRange": [0.50, 0.90],
            "groupHeightRatioRange": [0.56, 0.72],
            "modelProductGapXRatioRange": [0.01, 0.10],
            "titleHeightRatioRange": [0.12, 0.30],
        },
        "aspectAnalysis": {
            role: {
                "sourceAspectRatio": round(asset["width"] / asset["height"], 10),
                "contentAspectRatio": round(visible_dimensions(asset)[0] / visible_dimensions(asset)[1], 10),
            }
            for role, asset in (("model", model), ("product", product), ("title", title))
        },
        "layers": layers,
    }
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(layout, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"OK: {output}; groupWidthRatio={group_width / canvas_width:.4f}; "
        f"modelScale={model_scale:.6f}; productScale={product_scale:.6f}; "
        f"titleScale={title_scale:.6f}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
