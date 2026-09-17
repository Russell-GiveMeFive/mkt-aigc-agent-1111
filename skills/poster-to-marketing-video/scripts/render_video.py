#!/usr/bin/env python3
import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright


def probe(path: Path):
    command = [
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate",
        "-of", "json", str(path),
    ]
    return json.loads(subprocess.check_output(command, text=True))


def main():
    parser = argparse.ArgumentParser(description="Render seekable poster HTML to exact-frame MP4")
    parser.add_argument("html", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--keep-frames", action="store_true")
    parser.add_argument("--verification", type=Path)
    args = parser.parse_args()

    html = args.html.resolve()
    output = args.output.resolve()
    if not html.is_file():
        parser.error(f"HTML not found: {html}")
    output.parent.mkdir(parents=True, exist_ok=True)
    frame_dir = Path(tempfile.mkdtemp(prefix="poster-motion-frames-"))
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 800, "height": 800}, device_scale_factor=1)
            page.goto(html.as_uri(), wait_until="load")
            page.wait_for_function("window.__ready === true", timeout=30000)
            config = page.evaluate("window.POSTER_MOTION_CONFIG")
            width, height = int(config["width"]), int(config["height"])
            fps = int(config["fps"])
            duration_ms = int(config["durationMs"])
            page.set_viewport_size({"width": width, "height": height})
            locator = page.locator("#poster-stage")
            total_frames = round(duration_ms / 1000 * fps)
            for index in range(total_frames):
                timestamp_ms = index * 1000 / fps
                page.evaluate("t => window.__seek(t)", timestamp_ms)
                locator.screenshot(path=str(frame_dir / f"frame-{index:05d}.png"), animations="disabled")
            browser.close()

        subprocess.run([
            "ffmpeg", "-y", "-framerate", str(fps), "-i", str(frame_dir / "frame-%05d.png"),
            "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", "-an", str(output),
        ], check=True)
        verification = probe(output)
        verification["expected"] = {"width": width, "height": height, "fps": fps, "durationMs": duration_ms, "frames": total_frames}
        verification_path = args.verification or output.with_name("verification.json")
        verification_path.write_text(json.dumps(verification, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"video": str(output), "verification": str(verification_path), "frames": total_frames}, ensure_ascii=False))
    finally:
        if args.keep_frames:
            print(f"frames kept at: {frame_dir}")
        else:
            shutil.rmtree(frame_dir, ignore_errors=True)


if __name__ == "__main__":
    main()

