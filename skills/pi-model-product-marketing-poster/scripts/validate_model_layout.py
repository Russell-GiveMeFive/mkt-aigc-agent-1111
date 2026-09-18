#!/usr/bin/env python3
"""Validate geometry, scale, centering, visibility, and occlusion for a model poster."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


ANCHORS = {
    "top-left": (0.0, 0.0),
    "top-center": (0.5, 0.0),
    "top-right": (1.0, 0.0),
    "center-left": (0.0, 0.5),
    "center": (0.5, 0.5),
    "center-right": (1.0, 0.5),
    "bottom-left": (0.0, 1.0),
    "bottom-center": (0.5, 1.0),
    "bottom-right": (1.0, 1.0),
}

REQUIRED_TARGETS = {
    "groupCenterXRange",
    "groupCenterYRange",
    "modelHeightRatioRange",
    "productHeightRatioRange",
    "productToModelHeightRatioRange",
    "groupWidthRatioRange",
    "groupHeightRatioRange",
}


def visible_box(layer: dict[str, Any]) -> list[float]:
    box = [float(value) for value in layer["contentBox"]]
    scale = float(layer["scale"])
    target = [float(value) for value in layer["target"]]
    anchor = layer.get("anchor", "center")
    if anchor not in ANCHORS:
        raise ValueError(f"unknown anchor {anchor!r} for {layer.get('id')}")
    if scale <= 0:
        raise ValueError("scale must be positive")
    left, top, right, bottom = box
    if right <= left or bottom <= top:
        raise ValueError("contentBox must have positive width and height")
    fraction_x, fraction_y = ANCHORS[anchor]
    anchor_x = left + (right - left) * fraction_x
    anchor_y = top + (bottom - top) * fraction_y
    image_left = target[0] - anchor_x * scale
    image_top = target[1] - anchor_y * scale
    return [
        image_left + left * scale,
        image_top + top * scale,
        image_left + right * scale,
        image_top + bottom * scale,
    ]


def box_width(box: list[float]) -> float:
    return max(0.0, box[2] - box[0])


def box_height(box: list[float]) -> float:
    return max(0.0, box[3] - box[1])


def box_area(box: list[float]) -> float:
    return box_width(box) * box_height(box)


def union_box(*boxes: list[float]) -> list[float]:
    return [
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    ]


def intersection_area(first: list[float], second: list[float]) -> float:
    width = max(0.0, min(first[2], second[2]) - max(first[0], second[0]))
    height = max(0.0, min(first[3], second[3]) - max(first[1], second[1]))
    return width * height


def intersection_ratio(first: list[float], second: list[float]) -> float:
    area = intersection_area(first, second)
    denominator = min(box_area(first), box_area(second))
    return area / denominator if denominator else 0.0


def fully_visible(box: list[float], width: float, height: float, tolerance: float = 0.5) -> bool:
    return (
        box[0] >= -tolerance
        and box[1] >= -tolerance
        and box[2] <= width + tolerance
        and box[3] <= height + tolerance
    )


def horizontal_gap(first: list[float], second: list[float]) -> float:
    if first[2] <= second[0]:
        return second[0] - first[2]
    if second[2] <= first[0]:
        return first[0] - second[2]
    return -min(first[2], second[2]) + max(first[0], second[0])


def parse_range(
    targets: dict[str, Any], key: str, errors: list[str]
) -> tuple[float, float] | None:
    value = targets.get(key)
    if not isinstance(value, list) or len(value) != 2:
        errors.append(f"compositionTargets.{key} must be [min, max]")
        return None
    try:
        lower, upper = float(value[0]), float(value[1])
    except (TypeError, ValueError):
        errors.append(f"compositionTargets.{key} must contain numbers")
        return None
    if lower > upper:
        errors.append(f"compositionTargets.{key} min must not exceed max")
        return None
    return lower, upper


def check_range(
    name: str,
    value: float,
    allowed: tuple[float, float] | None,
    errors: list[str],
) -> None:
    if allowed and not allowed[0] <= value <= allowed[1]:
        errors.append(
            f"{name}={value:.4f} is outside [{allowed[0]:.4f}, {allowed[1]:.4f}]"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("layout", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--face-overlap-threshold", type=float, default=0.02)
    args = parser.parse_args()

    layout_path = args.layout.expanduser().resolve()
    data = json.loads(layout_path.read_text(encoding="utf-8"))
    errors: list[str] = []
    warnings: list[str] = []
    resolved: list[dict[str, Any]] = []

    canvas = data.get("canvas") or {}
    width = float(canvas.get("width", 0))
    height = float(canvas.get("height", 0))
    if width <= 0 or height <= 0:
        errors.append("canvas.width and canvas.height must be positive")

    face_safe = data.get("faceSafeBox")
    if not isinstance(face_safe, list) or len(face_safe) != 4:
        errors.append("faceSafeBox must be [left, top, right, bottom]")
        face_safe = None

    targets = data.get("compositionTargets")
    if not isinstance(targets, dict):
        errors.append("compositionTargets is required; do not render from unconstrained guesses")
        targets = {}
    for key in sorted(REQUIRED_TARGETS - set(targets)):
        errors.append(f"compositionTargets.{key} is required")
    optional_ranges = {"modelProductGapXRatioRange", "titleHeightRatioRange"}
    ranges = {
        key: parse_range(targets, key, errors)
        for key in sorted(REQUIRED_TARGETS | optional_ranges)
        if key in targets or key in REQUIRED_TARGETS
    }

    layers = data.get("layers") or []
    layer_ids = {layer.get("id") for layer in layers}
    boxes_by_role: dict[str, list[float]] = {}
    for layer in layers:
        role = layer.get("role")
        try:
            source_width = float(layer["sourceWidth"])
            source_height = float(layer["sourceHeight"])
            if source_width <= 0 or source_height <= 0:
                raise ValueError("sourceWidth and sourceHeight must be positive")
            content_box = [float(value) for value in layer["contentBox"]]
            if (
                content_box[0] < 0
                or content_box[1] < 0
                or content_box[2] > source_width
                or content_box[3] > source_height
            ):
                raise ValueError("contentBox must stay within original source dimensions")
            declared_aspect = layer.get("sourceAspectRatio")
            if declared_aspect is not None and abs(float(declared_aspect) - source_width / source_height) > 1e-8:
                raise ValueError("sourceAspectRatio does not match sourceWidth/sourceHeight")
            box = visible_box(layer)
        except (KeyError, TypeError, ValueError) as error:
            errors.append(f"{layer.get('id', '<unknown>')}: {error}")
            continue
        if role in boxes_by_role:
            errors.append(f"multiple {role!r} layers require explicit multi-layer handling")
        boxes_by_role[role] = box
        face_overlap = intersection_ratio(box, face_safe) if face_safe else 0.0
        is_fully_visible = fully_visible(box, width, height) if width and height else False
        resolved.append(
            {
                "id": layer.get("id"),
                "role": role,
                "visibleBox": [round(value, 4) for value in box],
                "widthRatio": round(box_width(box) / width, 6) if width else None,
                "heightRatio": round(box_height(box) / height, 6) if height else None,
                "fullyVisible": is_fully_visible,
                "faceOverlapRatio": round(face_overlap, 6),
            }
        )
        if role in {"title", "product"} and face_overlap > args.face_overlap_threshold:
            if layer.get("allowFaceOverlap"):
                warnings.append(
                    f"{layer.get('id')} overlaps {face_overlap:.1%} of faceSafeBox by explicit permission"
                )
            else:
                errors.append(f"{layer.get('id')} overlaps {face_overlap:.1%} of faceSafeBox")
        if targets.get("requireFullyVisible", True) and not is_fully_visible:
            errors.append(f"{layer.get('id')} is not fully visible inside the canvas")

    for role in ("model", "product"):
        if role not in boxes_by_role:
            errors.append(f"a {role} layer is required")

    metrics: dict[str, Any] = {}
    model = boxes_by_role.get("model")
    product = boxes_by_role.get("product")
    title = boxes_by_role.get("title")
    if model and product and width and height:
        group = union_box(model, product)
        model_height_ratio = box_height(model) / height
        product_height_ratio = box_height(product) / height
        product_to_model_height_ratio = (
            box_height(product) / box_height(model) if box_height(model) else 0.0
        )
        group_width_ratio = box_width(group) / width
        group_height_ratio = box_height(group) / height
        group_center_x_ratio = ((group[0] + group[2]) / 2) / width
        group_center_y_ratio = ((group[1] + group[3]) / 2) / height
        overlap_ratio = intersection_ratio(model, product)
        gap_x_ratio = horizontal_gap(model, product) / width
        metrics.update(
            {
                "modelVisibleBox": [round(value, 4) for value in model],
                "productVisibleBox": [round(value, 4) for value in product],
                "groupBox": [round(value, 4) for value in group],
                "modelHeightRatio": round(model_height_ratio, 6),
                "productHeightRatio": round(product_height_ratio, 6),
                "productToModelHeightRatio": round(product_to_model_height_ratio, 6),
                "groupWidthRatio": round(group_width_ratio, 6),
                "groupHeightRatio": round(group_height_ratio, 6),
                "groupCenterXRatio": round(group_center_x_ratio, 6),
                "groupCenterYRatio": round(group_center_y_ratio, 6),
                "modelProductOverlapRatio": round(overlap_ratio, 6),
                "modelProductGapXRatio": round(gap_x_ratio, 6),
                "modelFullyVisible": fully_visible(model, width, height),
                "productFullyVisible": fully_visible(product, width, height),
            }
        )
        check_range("modelHeightRatio", model_height_ratio, ranges.get("modelHeightRatioRange"), errors)
        check_range("productHeightRatio", product_height_ratio, ranges.get("productHeightRatioRange"), errors)
        check_range(
            "productToModelHeightRatio",
            product_to_model_height_ratio,
            ranges.get("productToModelHeightRatioRange"),
            errors,
        )
        check_range("groupWidthRatio", group_width_ratio, ranges.get("groupWidthRatioRange"), errors)
        check_range("groupHeightRatio", group_height_ratio, ranges.get("groupHeightRatioRange"), errors)
        check_range("groupCenterXRatio", group_center_x_ratio, ranges.get("groupCenterXRange"), errors)
        check_range("groupCenterYRatio", group_center_y_ratio, ranges.get("groupCenterYRange"), errors)
        check_range("modelProductGapXRatio", gap_x_ratio, ranges.get("modelProductGapXRatioRange"), errors)
        if targets.get("forbidModelProductOverlap", True) and overlap_ratio > 0:
            errors.append(f"model and product overlap by {overlap_ratio:.2%}")
        if targets.get("layoutStyle", "side-by-side") == "side-by-side" and gap_x_ratio < 0:
            errors.append("side-by-side layout requires horizontally separated model and product")
        if title:
            title_group_overlap = intersection_ratio(title, group)
            metrics["titleGroupOverlapRatio"] = round(title_group_overlap, 6)
            metrics["titleHeightRatio"] = round(box_height(title) / height, 6)
            check_range(
                "titleHeightRatio",
                box_height(title) / height,
                ranges.get("titleHeightRatioRange"),
                errors,
            )
            if title_group_overlap > 0:
                errors.append(f"title overlaps the model-product group by {title_group_overlap:.2%}")

    if data.get("occlusionStrategy") == "hand-held":
        hand_mask = data.get("handMaskLayerId")
        already_holds = bool(data.get("modelAlreadyHoldsProduct"))
        if not already_holds and (not hand_mask or hand_mask not in layer_ids):
            errors.append("hand-held strategy requires handMaskLayerId or modelAlreadyHoldsProduct=true")

    report = {
        "valid": not errors,
        "layout": str(layout_path),
        "errors": errors,
        "warnings": warnings,
        "compositionMetrics": metrics,
        "resolvedLayers": resolved,
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    print(rendered, end="")
    if args.output:
        output = args.output.expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered, encoding="utf-8")
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
