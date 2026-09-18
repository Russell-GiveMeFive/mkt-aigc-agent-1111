#!/usr/bin/env python3
"""Render #poster from a local HTML file to an exact-size PNG."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageStat
from playwright.sync_api import sync_playwright


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("html", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--verification-output",
        type=Path,
        help="Write DOM/load/visibility verification JSON after a successful render",
    )
    parser.add_argument("--selector", default="#poster")
    parser.add_argument(
        "--layout",
        type=Path,
        required=True,
        help="Required layout.json; it is preflight-validated and must match the rendered DOM",
    )
    parser.add_argument(
        "--require-role",
        action="append",
        default=[],
        metavar="ROLE",
        help="Require a loaded, visible layer with this data-role; repeat as needed",
    )
    parser.add_argument(
        "--expect-scale",
        action="append",
        default=[],
        metavar="LAYER_ID=SCALE",
        help="Assert the rendered DOM scale for a layer; repeat for multiple layers",
    )
    parser.add_argument(
        "--expect-center",
        action="append",
        default=[],
        metavar="LAYER_ID=X,Y",
        help="Assert the rendered alpha-geometry center for a layer",
    )
    parser.add_argument(
        "--position-tolerance",
        type=float,
        default=1.0,
        help="Maximum center-position error in CSS pixels (default: 1)",
    )
    return parser.parse_args()


def parse_scale_assertions(values: list[str]) -> dict[str, float]:
    assertions: dict[str, float] = {}
    for value in values:
        layer_id, separator, raw_scale = value.partition("=")
        if not separator or not layer_id:
            raise SystemExit(f"Invalid --expect-scale value: {value!r}; use LAYER_ID=SCALE")
        try:
            scale = float(raw_scale)
        except ValueError as error:
            raise SystemExit(f"Invalid scale in --expect-scale: {value!r}") from error
        if scale <= 0:
            raise SystemExit(f"Expected scale must be positive: {value!r}")
        assertions[layer_id] = scale
    return assertions


def parse_center_assertions(values: list[str]) -> dict[str, tuple[float, float]]:
    assertions: dict[str, tuple[float, float]] = {}
    for value in values:
        layer_id, separator, raw_center = value.partition("=")
        coordinates = raw_center.split(",")
        if not separator or not layer_id or len(coordinates) != 2:
            raise SystemExit(
                f"Invalid --expect-center value: {value!r}; use LAYER_ID=X,Y"
            )
        try:
            assertions[layer_id] = (float(coordinates[0]), float(coordinates[1]))
        except ValueError as error:
            raise SystemExit(f"Invalid coordinates in --expect-center: {value!r}") from error
    return assertions


def main() -> int:
    args = parse_args()
    scale_assertions = parse_scale_assertions(args.expect_scale)
    center_assertions = parse_center_assertions(args.expect_center)
    if args.position_tolerance < 0:
        raise SystemExit("--position-tolerance must be non-negative")
    html = args.html.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if not html.is_file():
        raise SystemExit(f"HTML file not found: {html}")
    layout_path = args.layout.expanduser().resolve()
    if not layout_path.is_file():
        raise SystemExit(f"Layout file not found: {layout_path}")
    layout = json.loads(layout_path.read_text(encoding="utf-8"))
    validator = Path(__file__).with_name("validate_model_layout.py")
    preflight_result = subprocess.run(
        [sys.executable, str(validator), str(layout_path)],
        check=False,
        capture_output=True,
        text=True,
    )
    if preflight_result.returncode != 0:
        raise RuntimeError(
            "Layout preflight failed; render is forbidden:\n" + preflight_result.stdout + preflight_result.stderr
        )
    preflight_report = json.loads(preflight_result.stdout)
    output.parent.mkdir(parents=True, exist_ok=True)

    console_errors: list[str] = []
    page_errors: list[str] = []
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as baseline_file:
        baseline_path = Path(baseline_file.name)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(
            viewport={"width": 800, "height": 800}, device_scale_factor=1
        )
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto(html.as_uri(), wait_until="load")
        page.evaluate(
            """async () => {
              await document.fonts.ready;
              const images = [...document.images];
              await Promise.all(images.map(async (img) => {
                if (!img.complete || img.naturalWidth === 0) await img.decode();
                if (img.naturalWidth === 0) throw new Error(`Image failed: ${img.src}`);
              }));
            }"""
        )
        poster = page.locator(args.selector)
        if poster.count() != 1:
            raise RuntimeError(f"Expected exactly one {args.selector}, found {poster.count()}")
        box = poster.bounding_box()
        if not box:
            raise RuntimeError(f"Poster selector is not visible: {args.selector}")
        width = round(box["width"])
        height = round(box["height"])
        if width <= 0 or height <= 0:
            raise RuntimeError(f"Invalid poster size: {width}x{height}")
        layout_canvas = layout.get("canvas") or {}
        if (width, height) != (int(layout_canvas.get("width", 0)), int(layout_canvas.get("height", 0))):
            raise RuntimeError(
                f"Poster canvas {width}x{height} does not match layout.json canvas "
                f"{layout_canvas.get('width')}x{layout_canvas.get('height')}"
            )
        page.set_viewport_size({"width": width, "height": height})

        dom_audit = page.evaluate(
            """(posterSelector) => {
              const poster = document.querySelector(posterSelector);
              if (!poster) throw new Error(`Poster not found: ${posterSelector}`);
              const posterRect = poster.getBoundingClientRect();
              const style = getComputedStyle(poster);
              const before = getComputedStyle(poster, "::before");
              const after = getComputedStyle(poster, "::after");
              const neutralContent = (value) => value === "none" || value === "normal";
              const unexpectedChildren = [...poster.children]
                .filter((child) => child.tagName !== "IMG")
                .map((child) => child.tagName.toLowerCase());
              const textContent = [...poster.childNodes]
                .filter((node) => node.nodeType === Node.TEXT_NODE)
                .map((node) => node.textContent.trim())
                .filter(Boolean);
              const backgrounds = [...poster.querySelectorAll('img[data-role="background"]')];
              const background = backgrounds[0];
              const backgroundStyle = background ? getComputedStyle(background) : null;
              const backgroundRect = background ? background.getBoundingClientRect() : null;
              const violations = [];
              if (unexpectedChildren.length) violations.push(`unexpected poster children: ${unexpectedChildren.join(", ")}`);
              if (textContent.length) violations.push("poster contains visible text nodes not supplied as images");
              if (!neutralContent(before.content) || !neutralContent(after.content)) {
                violations.push("poster pseudo-elements are not allowed");
              }
              if (style.opacity !== "1") violations.push(`poster opacity must be 1, got ${style.opacity}`);
              if (style.filter !== "none") violations.push(`poster filter must be none, got ${style.filter}`);
              if (style.mixBlendMode !== "normal") violations.push(`poster blend mode must be normal, got ${style.mixBlendMode}`);
              if (style.backgroundImage !== "none") violations.push("poster background-image overlay is not allowed");
              if (style.backgroundColor !== "rgba(0, 0, 0, 0)") violations.push(`poster background-color must be transparent, got ${style.backgroundColor}`);
              if (style.borderRadius !== "0px") violations.push(`poster border-radius must be 0, got ${style.borderRadius}`);
              if (style.boxShadow !== "none") violations.push("poster box-shadow is not allowed");
              if (backgrounds.length !== 1) violations.push(`expected exactly one background image, found ${backgrounds.length}`);
              if (background && backgroundStyle && backgroundRect) {
                if (background.naturalWidth !== Math.round(posterRect.width) ||
                    background.naturalHeight !== Math.round(posterRect.height)) {
                  violations.push(`background source pixels ${background.naturalWidth}x${background.naturalHeight} do not match canvas ${Math.round(posterRect.width)}x${Math.round(posterRect.height)}`);
                }
                if (backgroundStyle.opacity !== "1") violations.push(`background opacity must be 1, got ${backgroundStyle.opacity}`);
                if (backgroundStyle.filter !== "none") violations.push(`background filter must be none, got ${backgroundStyle.filter}`);
                if (backgroundStyle.mixBlendMode !== "normal") violations.push(`background blend mode must be normal, got ${backgroundStyle.mixBlendMode}`);
                if (backgroundStyle.transform !== "none") violations.push(`background transform must be none, got ${backgroundStyle.transform}`);
                if (Math.abs(backgroundRect.left - posterRect.left) > 0.5 ||
                    Math.abs(backgroundRect.top - posterRect.top) > 0.5 ||
                    Math.abs(backgroundRect.width - posterRect.width) > 0.5 ||
                    Math.abs(backgroundRect.height - posterRect.height) > 0.5) {
                  violations.push("background image does not exactly cover the poster canvas");
                }
              }
              return {violations};
            }""",
            args.selector,
        )
        if dom_audit["violations"]:
            raise RuntimeError("DOM/background integrity failed:\n" + "\n".join(dom_audit["violations"]))

        dom_layers = page.evaluate(
            """(posterSelector) => {
              const poster = document.querySelector(posterSelector);
              if (!poster) throw new Error(`Poster not found: ${posterSelector}`);
              const posterRect = poster.getBoundingClientRect();
              return [...poster.querySelectorAll("img[data-role]")].map((img) => {
                const rect = img.getBoundingClientRect();
                const style = getComputedStyle(img);
                const values = (img.dataset.contentBox || "").split(",").map(Number);
                const sourceWidth = Number(img.dataset.sourceWidth);
                const sourceHeight = Number(img.dataset.sourceHeight);
                const scaleX = sourceWidth > 0 ? rect.width / sourceWidth : NaN;
                const scaleY = sourceHeight > 0 ? rect.height / sourceHeight : NaN;
                const visibleBox = values.length === 4 && values.every(Number.isFinite) &&
                  Number.isFinite(scaleX) && Number.isFinite(scaleY)
                    ? [
                        rect.left - posterRect.left + values[0] * scaleX,
                        rect.top - posterRect.top + values[1] * scaleY,
                        rect.left - posterRect.left + values[2] * scaleX,
                        rect.top - posterRect.top + values[3] * scaleY
                      ]
                    : null;
                const intersectionWidth = Math.max(
                  0,
                  Math.min(rect.right, posterRect.right) - Math.max(rect.left, posterRect.left)
                );
                const intersectionHeight = Math.max(
                  0,
                  Math.min(rect.bottom, posterRect.bottom) - Math.max(rect.top, posterRect.top)
                );
                return {
                  id: img.id,
                  role: img.dataset.role,
                  src: img.currentSrc || img.src,
                  loaded: img.complete && img.naturalWidth > 0 && img.naturalHeight > 0,
                  naturalWidth: img.naturalWidth,
                  naturalHeight: img.naturalHeight,
                  declaredSourceWidth: sourceWidth,
                  declaredSourceHeight: sourceHeight,
                  renderedWidth: rect.width,
                  renderedHeight: rect.height,
                  renderedScaleX: scaleX,
                  renderedScaleY: scaleY,
                  appliedScale: Number(img.dataset.appliedScale),
                  visible: style.display !== "none" && style.visibility !== "hidden" &&
                    Number(style.opacity) > 0 && intersectionWidth > 1 && intersectionHeight > 1,
                  intersectionArea: intersectionWidth * intersectionHeight,
                  visibleBox,
                  styleIntegrity: {
                    opacity: style.opacity,
                    filter: style.filter,
                    mixBlendMode: style.mixBlendMode,
                    boxShadow: style.boxShadow,
                    backgroundColor: style.backgroundColor,
                    backgroundImage: style.backgroundImage,
                    borderRadius: style.borderRadius
                  }
                };
              });
            }""",
            args.selector,
        )

        required_roles = list(dict.fromkeys(args.require_role))
        for layer in dom_layers:
            style = layer["styleIntegrity"]
            if style["opacity"] != "1":
                raise RuntimeError(f"CSS opacity changes source asset {layer['id'] or layer['role']}")
            if style["filter"] != "none":
                raise RuntimeError(f"CSS filter changes source asset {layer['id'] or layer['role']}")
            if style["mixBlendMode"] != "normal":
                raise RuntimeError(f"CSS blend mode changes source asset {layer['id'] or layer['role']}")
            if style["boxShadow"] != "none":
                raise RuntimeError(f"CSS shadow adds an undeclared visual to {layer['id'] or layer['role']}")
            if style["backgroundImage"] != "none" or style["backgroundColor"] != "rgba(0, 0, 0, 0)":
                raise RuntimeError(f"CSS background adds an undeclared visual to {layer['id'] or layer['role']}")
            if style["borderRadius"] != "0px":
                raise RuntimeError(f"CSS border-radius modifies source asset {layer['id'] or layer['role']}")
        for role in required_roles:
            candidates = [layer for layer in dom_layers if layer["role"] == role]
            if not candidates:
                raise RuntimeError(f"Required role missing from poster DOM: {role}")
            if not any(layer["loaded"] and layer["visible"] for layer in candidates):
                raise RuntimeError(f"Required role is not loaded and visible: {role}")

        if layout is not None:
            declared_layers = layout.get("layers") or []
            dom_by_id = {layer["id"]: layer for layer in dom_layers if layer["id"]}
            preflight_by_id = {
                layer["id"]: layer for layer in preflight_report.get("resolvedLayers", [])
            }
            for declared in declared_layers:
                layer_id = declared.get("id")
                role = declared.get("role")
                if not layer_id:
                    raise RuntimeError("layout.json contains a layer without id")
                rendered_layer = dom_by_id.get(layer_id)
                if not rendered_layer:
                    raise RuntimeError(f"Layer declared in layout.json is missing from HTML: {layer_id}")
                if rendered_layer["role"] != role:
                    raise RuntimeError(
                        f"Role mismatch for {layer_id}: layout={role!r}, DOM={rendered_layer['role']!r}"
                    )
                if not rendered_layer["loaded"] or not rendered_layer["visible"]:
                    raise RuntimeError(f"Layer declared in layout.json is not loaded and visible: {layer_id}")
                source_width = float(declared["sourceWidth"])
                source_height = float(declared["sourceHeight"])
                if (
                    rendered_layer["naturalWidth"] != round(source_width)
                    or rendered_layer["naturalHeight"] != round(source_height)
                ):
                    raise RuntimeError(
                        f"Original pixel dimensions mismatch for {layer_id}: layout="
                        f"{source_width:g}x{source_height:g}, browser="
                        f"{rendered_layer['naturalWidth']}x{rendered_layer['naturalHeight']}"
                    )
                if (
                    abs(rendered_layer["declaredSourceWidth"] - source_width) > 1e-9
                    or abs(rendered_layer["declaredSourceHeight"] - source_height) > 1e-9
                ):
                    raise RuntimeError(f"HTML source-dimension metadata disagrees with layout.json for {layer_id}")
                scale_x = rendered_layer["renderedScaleX"]
                scale_y = rendered_layer["renderedScaleY"]
                expected_scale = float(declared["scale"])
                if abs(scale_x - scale_y) > 1e-4:
                    raise RuntimeError(
                        f"Aspect ratio distortion for {layer_id}: scaleX={scale_x:.8f}, scaleY={scale_y:.8f}"
                    )
                if abs(scale_x - expected_scale) > 1e-4:
                    raise RuntimeError(
                        f"Rendered scale differs from layout.json for {layer_id}: "
                        f"expected={expected_scale:.8f}, actual={scale_x:.8f}"
                    )
                if abs(rendered_layer["appliedScale"] - expected_scale) > 1e-9:
                    raise RuntimeError(f"HTML appliedScale metadata disagrees with layout.json for {layer_id}")
                expected_visible = preflight_by_id.get(layer_id, {}).get("visibleBox")
                actual_visible = rendered_layer.get("visibleBox")
                if not expected_visible or not actual_visible:
                    raise RuntimeError(f"Missing visibleBox comparison data for {layer_id}")
                maximum_delta = max(
                    abs(float(actual) - float(expected))
                    for actual, expected in zip(actual_visible, expected_visible)
                )
                if maximum_delta > 1.0:
                    raise RuntimeError(
                        f"Rendered alpha geometry differs from layout.json for {layer_id}; "
                        f"max delta={maximum_delta:.3f}px"
                    )

        page.evaluate(
            """(posterSelector) => {
              const poster = document.querySelector(posterSelector);
              for (const img of poster.querySelectorAll('img[data-role]:not([data-role="background"])')) {
                img.dataset.auditVisibility = img.style.visibility;
                img.style.visibility = "hidden";
              }
            }""",
            args.selector,
        )
        poster.screenshot(path=str(baseline_path), animations="disabled", caret="hide")
        page.evaluate(
            """(posterSelector) => {
              const poster = document.querySelector(posterSelector);
              for (const img of poster.querySelectorAll('img[data-role]:not([data-role="background"])')) {
                img.style.visibility = img.dataset.auditVisibility || "";
                delete img.dataset.auditVisibility;
              }
            }""",
            args.selector,
        )

        for layer_id, expected_scale in scale_assertions.items():
            actual_scale = page.evaluate(
                """(id) => {
                  const layer = document.getElementById(id);
                  if (!layer) throw new Error(`Expected layer not found: ${id}`);
                  return Number(layer.dataset.appliedScale);
                }""",
                layer_id,
            )
            if not isinstance(actual_scale, (int, float)) or abs(actual_scale - expected_scale) > 1e-9:
                raise RuntimeError(
                    f"Scale assertion failed for {layer_id}: expected {expected_scale}, got {actual_scale}"
                )

        for layer_id, (expected_x, expected_y) in center_assertions.items():
            actual_center = page.evaluate(
                """([id, posterSelector]) => {
                  const layer = document.getElementById(id);
                  const poster = document.querySelector(posterSelector);
                  if (!layer) throw new Error(`Expected layer not found: ${id}`);
                  if (!poster) throw new Error(`Poster not found: ${posterSelector}`);
                  const values = layer.dataset.contentBox.split(",").map(Number);
                  if (values.length !== 4 || values.some(v => !Number.isFinite(v))) {
                    throw new Error(`Invalid contentBox metadata for ${id}`);
                  }
                  const sourceWidth = Number(layer.dataset.sourceWidth);
                  const sourceHeight = Number(layer.dataset.sourceHeight);
                  const layerRect = layer.getBoundingClientRect();
                  const posterRect = poster.getBoundingClientRect();
                  const scaleX = layerRect.width / sourceWidth;
                  const scaleY = layerRect.height / sourceHeight;
                  const [left, top, right, bottom] = values;
                  return {
                    x: layerRect.left - posterRect.left + ((left + right) / 2) * scaleX,
                    y: layerRect.top - posterRect.top + ((top + bottom) / 2) * scaleY
                  };
                }""",
                [layer_id, args.selector],
            )
            error_x = abs(actual_center["x"] - expected_x)
            error_y = abs(actual_center["y"] - expected_y)
            if error_x > args.position_tolerance or error_y > args.position_tolerance:
                raise RuntimeError(
                    f"Center assertion failed for {layer_id}: expected "
                    f"({expected_x}, {expected_y}), got "
                    f"({actual_center['x']:.3f}, {actual_center['y']:.3f})"
                )
        poster.screenshot(path=str(output), animations="disabled", caret="hide")
        browser.close()

    if console_errors or page_errors:
        details = "\n".join(console_errors + page_errors)
        raise RuntimeError(f"Browser errors detected:\n{details}")

    with Image.open(output) as rendered:
        if rendered.size != (width, height):
            raise RuntimeError(
                f"Screenshot size mismatch: expected {width}x{height}, got {rendered.size}"
            )
        rendered_rgb = rendered.convert("RGB")
    with Image.open(baseline_path) as baseline:
        baseline_rgb = baseline.convert("RGB")
    baseline_path.unlink(missing_ok=True)
    if baseline_rgb.size != rendered_rgb.size:
        raise RuntimeError("Background baseline size does not match final render")
    fidelity_mask = Image.new("L", rendered_rgb.size, 255)
    mask_draw = ImageDraw.Draw(fidelity_mask)
    for layer in dom_layers:
        if layer["role"] == "background" or not layer.get("visibleBox"):
            continue
        left, top, right, bottom = layer["visibleBox"]
        mask_draw.rectangle(
            [int(left) - 2, int(top) - 2, int(right) + 2, int(bottom) + 2],
            fill=0,
        )
    auditable_pixels = fidelity_mask.histogram()[255]
    if auditable_pixels <= width * height * 0.05:
        raise RuntimeError("Too little uncovered background remains for pixel-fidelity verification")
    difference = ImageChops.difference(rendered_rgb, baseline_rgb)
    mean_error = sum(ImageStat.Stat(difference, mask=fidelity_mask).mean) / 3
    changed_map = difference.convert("L").point(lambda value: 255 if value > 2 else 0)
    changed_outside_layers = ImageChops.multiply(changed_map, fidelity_mask).histogram()[255]
    changed_ratio = changed_outside_layers / auditable_pixels
    if changed_ratio > 0.0001 or mean_error > 0.1:
        raise RuntimeError(
            "Background pixel fidelity failed outside declared alpha bounds: "
            f"changedRatio={changed_ratio:.6f}, meanAbsError={mean_error:.4f}"
        )

    visible_roles = sorted({layer["role"] for layer in dom_layers if layer["loaded"] and layer["visible"]})
    if args.verification_output:
        role_status = {}
        for role in sorted({layer["role"] for layer in dom_layers} | set(args.require_role)):
            candidates = [layer for layer in dom_layers if layer["role"] == role]
            role_status[role] = {
                "present": bool(candidates),
                "loaded": any(layer["loaded"] for layer in candidates),
                "visible": any(layer["loaded"] and layer["visible"] for layer in candidates),
                "layers": candidates,
            }
        model_status = role_status.get("model", {})
        verification = {
            "valid": True,
            "canvas": {"width": width, "height": height},
            "layoutCompared": layout is not None,
            "requiredRoles": required_roles,
            "visibleRoles": visible_roles,
            "modelPresent": bool(model_status.get("present")),
            "modelLoaded": bool(model_status.get("loaded")),
            "modelVisible": bool(model_status.get("visible")),
            "backgroundPixelFidelity": {
                "auditablePixels": auditable_pixels,
                "changedPixelRatio": round(changed_ratio, 8),
                "meanAbsoluteError": round(mean_error, 6),
                "passed": True,
            },
            "noUndeclaredVisibleElements": True,
            "sourceLayerCssIntegrity": True,
            "originalPixelDimensionsVerified": True,
            "uniformAspectScaleVerified": True,
            "renderedGeometryMatchesLayout": True,
            "roles": role_status,
        }
        verification_output = args.verification_output.expanduser().resolve()
        verification_output.parent.mkdir(parents=True, exist_ok=True)
        verification_output.write_text(
            json.dumps(verification, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(f"OK: {output} ({width}x{height}); visible roles: {', '.join(visible_roles)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
