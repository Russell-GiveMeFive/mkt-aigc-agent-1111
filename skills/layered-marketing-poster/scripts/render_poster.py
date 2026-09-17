#!/usr/bin/env python3
"""Render #poster from a local HTML file to an exact-size PNG."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("html", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--selector", default="#poster")
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
    output.parent.mkdir(parents=True, exist_ok=True)

    console_errors: list[str] = []
    page_errors: list[str] = []

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
        page.set_viewport_size({"width": width, "height": height})

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

    print(f"OK: {output} ({width}x{height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
