#!/usr/bin/env python3
import argparse
import json
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Inspect a model-product reference/result video and optionally create a contact sheet")
    parser.add_argument("video", type=Path)
    parser.add_argument("--contact-sheet", type=Path)
    parser.add_argument("--samples", type=int, default=10)
    args = parser.parse_args()

    video = args.video.expanduser().resolve()
    if not video.is_file():
        parser.error(f"video not found: {video}")
    result = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries",
        "format=filename,duration,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate",
        "-of", "json", str(video),
    ], text=True))
    duration = float(result.get("format", {}).get("duration", 0) or 0)
    if args.contact_sheet:
        output = args.contact_sheet.expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        fps = args.samples / duration if duration > 0 else 2
        columns = 5
        rows = (args.samples + columns - 1) // columns
        subprocess.run([
            "ffmpeg", "-y", "-i", str(video), "-vf",
            f"fps={fps},scale=360:-1,tile={columns}x{rows}:padding=6:margin=6",
            "-frames:v", "1", "-update", "1", str(output),
        ], check=True)
        result["contact_sheet"] = str(output)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
