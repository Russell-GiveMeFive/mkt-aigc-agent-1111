#!/usr/bin/env python3
"""Run the complete deterministic model-product poster pipeline from one job JSON."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
TEMPLATE = ROOT / "assets" / "poster-starter.html"
REQUIRED_PATHS = ("background", "title", "model", "product", "watermark")
PRODUCT_CLASSES = {"auto", "small-handheld", "medium", "large"}
MODEL_SIDES = {"auto", "left", "right"}
HIERARCHIES = {"balanced", "model-led", "product-led"}


class PipelineError(RuntimeError):
    def __init__(self, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.code = code
        self.details = details


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=False, capture_output=True, text=True)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def one_asset(probe: dict[str, Any], role: str) -> dict[str, Any]:
    matches = [asset for asset in probe["assets"] if asset["role"] == role]
    if len(matches) != 1:
        raise PipelineError("ASSET_ROLE_ERROR", f"expected exactly one {role}, found {len(matches)}")
    return matches[0]


def classify_product(asset: dict[str, Any]) -> str:
    aspect = float(asset.get("visible_aspect_ratio") or 1)
    if aspect >= 1.25:
        return "large"
    if aspect <= 0.8:
        return "small-handheld"
    return "medium"


def candidate_values(product_class: str, hierarchy: str) -> tuple[list[float], list[float]]:
    model = {
        "balanced": [0.64, 0.62, 0.60, 0.58, 0.56],
        "model-led": [0.66, 0.64, 0.62, 0.60, 0.58],
        "product-led": [0.60, 0.58, 0.62, 0.56, 0.64],
    }[hierarchy]
    product_defaults = {
        "small-handheld": [0.44, 0.42, 0.40, 0.38, 0.36, 0.34, 0.32, 0.30],
        "medium": [0.50, 0.48, 0.46, 0.44, 0.42, 0.40, 0.38, 0.36, 0.34],
        "large": [0.62, 0.60, 0.58, 0.56, 0.54, 0.52, 0.50, 0.48, 0.46, 0.44, 0.42, 0.40, 0.38],
    }[product_class]
    if hierarchy == "model-led":
        product_defaults = list(reversed(sorted(product_defaults)))
    elif hierarchy == "product-led":
        product_defaults = sorted(product_defaults, reverse=True)
    return model, product_defaults


def add_watermark(layout: dict[str, Any], watermark: dict[str, Any]) -> None:
    canvas = layout["canvas"]
    if watermark["width"] != canvas["width"] or watermark["height"] != canvas["height"]:
        raise PipelineError(
            "WATERMARK_SIZE_MISMATCH",
            "watermark must have the same pixel dimensions as the background for registered placement",
        )
    left, top, right, bottom = watermark["geometry_box"]
    layout["layers"].append(
        {
            "id": "watermark",
            "role": "watermark",
            "src": watermark["file_uri"],
            "sourceWidth": watermark["width"],
            "sourceHeight": watermark["height"],
            "sourceAspectRatio": round(watermark["width"] / watermark["height"], 10),
            "contentBox": watermark["geometry_box"],
            "contentAspectRatio": round((right - left) / (bottom - top), 10),
            "anchor": "top-left",
            "target": [left, top],
            "scale": 1,
            "requestedScale": 1,
            "strictScale": True,
            "requestedCenter": None,
            "strictPosition": False,
            "opacity": 1,
            "zIndex": 100,
            "scaleSource": "registered-watermark",
        }
    )


def build_html(layout: dict[str, Any]) -> str:
    config = {
        "width": layout["canvas"]["width"],
        "height": layout["canvas"]["height"],
        "background": layout["background"]["src"],
        "layers": layout["layers"],
    }
    template = TEMPLATE.read_text(encoding="utf-8")
    replacement = "const POSTER_CONFIG = " + json.dumps(config, ensure_ascii=False, indent=2) + ";"
    html, count = re.subn(
        r"const POSTER_CONFIG = \{.*?\n    \};",
        replacement,
        template,
        count=1,
        flags=re.DOTALL,
    )
    if count != 1:
        raise PipelineError("TEMPLATE_ERROR", "could not replace POSTER_CONFIG in HTML template")
    return html


def choose_layout(
    probe_path: Path,
    output_dir: Path,
    product_class: str,
    model_side: str,
    hierarchy: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    model_values, product_values = candidate_values(product_class, hierarchy)
    sides = [model_side] if model_side != "auto" else ["left", "right"]
    title_values = [0.20, 0.18, 0.16, 0.14, 0.12]
    center_values = [0.62, 0.60, 0.64, 0.58, 0.66]
    valid: list[tuple[float, dict[str, Any], dict[str, Any]]] = []
    attempts: list[dict[str, Any]] = []
    index = 0
    enough_candidates = False
    for side in sides:
        for model_ratio in model_values:
            for product_ratio in product_values:
                for title_ratio in title_values:
                    for center_ratio in center_values:
                        index += 1
                        candidate = output_dir / f".candidate-{index}.json"
                        command = [
                            sys.executable,
                            str(SCRIPTS / "plan_side_by_side.py"),
                            str(probe_path),
                            "--output",
                            str(candidate),
                            "--product-class",
                            product_class,
                            "--model-side",
                            side,
                            "--model-height-ratio",
                            str(model_ratio),
                            "--product-height-ratio",
                            str(product_ratio),
                            "--title-height-ratio",
                            str(title_ratio),
                            "--group-center-y-ratio",
                            str(center_ratio),
                        ]
                        planned = run(command)
                        if planned.returncode != 0:
                            if len(attempts) < 20:
                                attempts.append({"params": command[-12:], "error": planned.stderr.strip()})
                            continue
                        checked = run([sys.executable, str(SCRIPTS / "validate_model_layout.py"), str(candidate)])
                        if checked.returncode != 0:
                            if len(attempts) < 20:
                                attempts.append({"params": command[-12:], "error": checked.stdout.strip()})
                            candidate.unlink(missing_ok=True)
                            continue
                        layout = load_json(candidate)
                        report = json.loads(checked.stdout)
                        metrics = report["compositionMetrics"]
                        score = (
                            abs(metrics["groupCenterXRatio"] - 0.5) * 50
                            + abs(metrics["groupCenterYRatio"] - 0.62) * 20
                            + abs(model_ratio - 0.62) * 8
                            + abs(title_ratio - 0.18) * 5
                            - metrics["groupWidthRatio"] * 2
                        )
                        valid.append((score, layout, report))
                        candidate.unlink(missing_ok=True)
                        if len(valid) >= 24:
                            enough_candidates = True
                            break
                    if enough_candidates:
                        break
                if enough_candidates:
                    break
            if enough_candidates:
                break
        if enough_candidates:
            break
    if not valid:
        raise PipelineError("NO_VALID_LAYOUT", "no candidate satisfied geometry constraints", attempts)
    valid.sort(key=lambda item: item[0])
    return valid[0][1], valid[0][2]


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: run_poster.py /absolute/path/job.json")
    job_path = Path(sys.argv[1]).expanduser().resolve()
    job = load_json(job_path)
    output_dir = Path(job.get("outputDir", "")).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    error_path = output_dir / "render-error.json"
    try:
        for key in REQUIRED_PATHS:
            raw = job.get(key)
            if not isinstance(raw, str) or not raw:
                raise PipelineError("MISSING_ASSET", f"{key} is required")
            if not Path(raw).expanduser().resolve().is_file():
                raise PipelineError("ASSET_NOT_FOUND", f"{key} file not found: {raw}")
        product_class = job.get("productClass", "auto")
        model_side = job.get("modelSide", "auto")
        hierarchy = job.get("hierarchy", "balanced")
        if product_class not in PRODUCT_CLASSES or model_side not in MODEL_SIDES or hierarchy not in HIERARCHIES:
            raise PipelineError("INVALID_OPTION", "invalid productClass, modelSide, or hierarchy")

        probe_path = output_dir / "assets.json"
        probe_command = [sys.executable, str(SCRIPTS / "probe_assets.py")]
        for key in REQUIRED_PATHS:
            probe_command.extend([f"--{key}", str(Path(job[key]).expanduser().resolve())])
        probe_command.extend(["--output", str(probe_path)])
        probed = run(probe_command)
        if probed.returncode != 0:
            raise PipelineError("PROBE_FAILED", "asset probing failed", probed.stderr)
        probe = load_json(probe_path)
        model = one_asset(probe, "model")
        product = one_asset(probe, "product")
        watermark = one_asset(probe, "watermark")
        for role in ("model", "product", "title", "watermark"):
            asset = one_asset(probe, role)
            if not asset["has_transparency"]:
                raise PipelineError(
                    f"OPAQUE_{role.upper()}",
                    f"{role} must contain transparency; opaque rectangles would cover or alter the background",
                )
        if product_class == "auto":
            product_class = classify_product(product)

        layout, preflight = choose_layout(probe_path, output_dir, product_class, model_side, hierarchy)
        add_watermark(layout, watermark)
        layout["job"] = {
            "productClassRequested": job.get("productClass", "auto"),
            "productClassResolved": product_class,
            "modelSideRequested": model_side,
            "hierarchy": hierarchy,
            "brief": str(job.get("brief", "")),
        }
        layout_path = output_dir / "layout.json"
        write_json(layout_path, layout)
        poster_html = output_dir / "poster.html"
        poster_html.write_text(build_html(layout), encoding="utf-8")

        preflight_path = output_dir / "preflight.json"
        validated = run(
            [
                sys.executable,
                str(SCRIPTS / "validate_model_layout.py"),
                str(layout_path),
                "--output",
                str(preflight_path),
            ]
        )
        if validated.returncode != 0:
            raise PipelineError("PREFLIGHT_FAILED", "final layout validation failed", validated.stdout)

        poster_png = output_dir / "poster.png"
        verification = output_dir / "verification.json"
        render_command = [
            sys.executable,
            str(SCRIPTS / "render_poster.py"),
            str(poster_html),
            "--output",
            str(poster_png),
            "--layout",
            str(layout_path),
            "--verification-output",
            str(verification),
        ]
        for role in ("model", "product", "title", "watermark"):
            render_command.extend(["--require-role", role])
        rendered = run(render_command)
        if rendered.returncode != 0:
            raise PipelineError("RENDER_FAILED", "Playwright rendering or pixel verification failed", rendered.stdout + rendered.stderr)

        final_report = load_json(verification)
        roles = set(final_report.get("visibleRoles", []))
        missing_roles = sorted({"model", "product", "title", "watermark"} - roles)
        if missing_roles:
            raise PipelineError("MISSING_VISIBLE_LAYER", "required visible layers missing", missing_roles)
        result = {
            "status": "success",
            "generator": "pi-model-product-marketing-poster@5.2.0",
            "tool": "pi_compose_model_product_poster",
            "canvas": layout["canvas"],
            "productClass": product_class,
            "hierarchy": hierarchy,
            "compositionMetrics": load_json(preflight_path)["compositionMetrics"],
            "scales": {layer["role"]: layer["scale"] for layer in layout["layers"]},
            "outputs": {
                "posterHtml": str(poster_html),
                "posterPng": str(poster_png),
                "layout": str(layout_path),
                "verification": str(verification),
            },
        }
        write_json(output_dir / "result.json", result)
        error_path.unlink(missing_ok=True)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except PipelineError as error:
        payload = {"status": "error", "code": error.code, "message": str(error), "details": error.details}
        write_json(error_path, payload)
        print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
        return 1
    except Exception as error:
        payload = {"status": "error", "code": "UNEXPECTED_ERROR", "message": str(error)}
        write_json(error_path, payload)
        print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
