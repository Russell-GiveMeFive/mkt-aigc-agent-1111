#!/usr/bin/env python3
import argparse
import json
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Inspect a reference video and optionally create a contact sheet")
    parser.add_argument("video", type=Path)
    parser.add_argument("--contact-sheet", type=Path)
    args = parser.parse_args()
    video = args.video.expanduser().resolve()
    if not video.is_file():
        parser.error(f"video not found: {video}")
    data = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate",
        "-of", "json", str(video),
    ], text=True))
    if args.contact_sheet:
        sheet = args.contact_sheet.resolve()
        sheet.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([
            "ffmpeg", "-y", "-i", str(video), "-vf",
            "fps=2,scale=520:-1,tile=5x2:padding=8:margin=8", "-frames:v", "1", "-update", "1", str(sheet),
        ], check=True)
        data["contact_sheet"] = str(sheet)
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
