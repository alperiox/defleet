#!/usr/bin/env python3
"""Add a quiet, repeating soundtrack to the tour without re-encoding its video.

python3 scripts/add-tour-music.py /path/to/music.mp3 --output /tmp/tour-with-music.mp4
Use audio you have permission to include in the intended video publication.
"""
import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile


def duration(path):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    )
    value = float(json.loads(result.stdout)["format"]["duration"])
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"Invalid duration: {path}")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("music", type=Path)
    parser.add_argument("--video", type=Path, default=Path("docs/media/fleet-tour.mp4"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--crossfade", type=float, default=2.0, help="Seconds at each repeat")
    parser.add_argument("--volume", type=float, default=0.5, help="Gain after normalization to -23 LUFS")
    args = parser.parse_args()
    if args.output.resolve() in (args.video.resolve(), args.music.resolve()):
        parser.error("Choose a separate output file so the original stays available.")
    length, music_length = duration(args.video), duration(args.music)
    overlap = args.crossfade
    if not math.isfinite(overlap) or overlap <= 0 or overlap >= music_length / 2:
        parser.error("Crossfade must be positive and shorter than half the music.")
    if not math.isfinite(args.volume) or not 0 < args.volume <= 2:
        parser.error("Volume must be greater than zero and at most 2.")
    copies = max(1, math.ceil((length - overlap) / (music_length - overlap)))
    filters = ["[1:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-23:TP=-2:LRA=7[norm]"]
    if copies > 1:
        filters.append(f"[norm]asplit={copies}" + "".join(f"[a{i}]" for i in range(copies)))
        previous = "a0"
        for i in range(1, copies):
            target = f"mix{i}"
            filters.append(f"[{previous}][a{i}]acrossfade=d={overlap}:c1=tri:c2=tri[{target}]")
            previous = target
    else:
        previous = "norm"
    fade = min(1.0, length / 4)
    filters.append(f"[{previous}]atrim=duration={length},asetpts=PTS-STARTPTS,volume={args.volume},"
                   f"afade=t=in:d={fade},afade=t=out:st={length - fade}:d={fade}[music]")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    handle, partial = tempfile.mkstemp(prefix=".tour-audio-", suffix=".mp4", dir=args.output.parent)
    os.close(handle)
    try:
        subprocess.run([
            "ffmpeg", "-y", "-v", "error", "-i", str(args.video), "-i", str(args.music),
            "-filter_complex", ";".join(filters), "-map", "0:v:0", "-map", "[music]",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-t", str(length),
            "-movflags", "+faststart", partial,
        ], check=True)
        os.replace(partial, args.output)
    finally:
        Path(partial).unlink(missing_ok=True)
    print(f"Wrote {args.output} ({length:.2f}s, {copies} music passes, {overlap:g}s crossfades)")


if __name__ == "__main__":
    main()
