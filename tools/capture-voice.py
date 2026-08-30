"""Capture a local 16 kHz mono WAV suitable for Jarvis voice enrollment."""

from __future__ import annotations

import argparse
import math
import wave
import winsound
from pathlib import Path

import numpy as np
import sounddevice as sd


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--seconds", type=float, default=12.0)
    parser.add_argument("--device", type=int, default=None)
    args = parser.parse_args()

    sample_rate = 16_000
    args.output.parent.mkdir(parents=True, exist_ok=True)
    print("Speak naturally after the beep. Suggested phrase:")
    print('"Jarvis, this is my voice. Please remember me and use my personal context."')
    winsound.Beep(880, 220)

    audio = sd.rec(
        int(args.seconds * sample_rate),
        samplerate=sample_rate,
        channels=1,
        dtype="int16",
        device=args.device,
    )
    sd.wait()
    winsound.Beep(660, 180)

    with wave.open(str(args.output), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(audio.tobytes())

    normalized = audio.astype(np.float32) / 32768.0
    rms = float(np.sqrt(np.mean(normalized * normalized)))
    peak = float(np.max(np.abs(normalized)))
    rms_db = 20.0 * math.log10(max(rms, 1e-9))
    print(f"Saved {args.output} ({args.seconds:.1f}s, RMS {rms_db:.1f} dBFS, peak {peak:.2f})")
    if rms_db < -42.0:
        print("WARNING: The capture is very quiet; move closer to the microphone and retry.")
        return 2
    if peak > 0.99:
        print("WARNING: The capture clipped; move farther from the microphone and retry.")
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
