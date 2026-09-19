"""Golden-model check of cells.txt + turn frames.bin (captured VGA) into a GIF."""
import os
import subprocess
import sys

import numpy as np

N = int(sys.argv[1]) if len(sys.argv) > 1 else 16
SIM = os.path.join(os.path.dirname(__file__), "..", "sim")


def life_torus(g):
    s = sum(np.roll(np.roll(g, dy, 0), dx, 1)
            for dy in (-1, 0, 1) for dx in (-1, 0, 1) if (dy, dx) != (0, 0))
    return ((s == 3) | (g & (s == 2))).astype(np.uint8)


def check():
    prev, checked, bad = None, 0, 0
    for line in open(os.path.join(SIM, "cells.txt")):
        if line.startswith("LOAD"):
            prev = None
            continue
        gen, bits = line.split()
        gen = int(gen)
        grid = np.array([int(b) for b in bits], dtype=np.uint8).reshape(N, N)
        if prev is not None and gen == (prev[0] + 1) % 256:
            checked += 1
            if not np.array_equal(life_torus(prev[1]), grid):
                bad += 1
                print("MISMATCH at gen", gen)
        prev = (gen, grid)
    print(f"golden check: {checked} transitions, {bad} mismatches")
    return bad == 0


def render():
    W, H = 320, 240
    raw = np.fromfile(os.path.join(SIM, "frames.bin"), dtype=np.uint8)
    n = len(raw) // (W * H)
    px = raw[: n * W * H].reshape(n, H, W)
    lut = np.array([0, 85, 170, 255], dtype=np.uint8)
    rgb = np.stack([lut[(px >> 4) & 3], lut[(px >> 2) & 3], lut[px & 3]], axis=-1)
    out = os.path.join(SIM, "frames")
    os.makedirs(out, exist_ok=True)
    for i in range(n):
        with open(os.path.join(out, f"f{i:04d}.ppm"), "wb") as f:
            f.write(f"P6 {W} {H} 255\n".encode())
            f.write(rgb[i].tobytes())
    gif = os.path.join(SIM, "life_vga.gif")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "20",
                    "-i", os.path.join(out, "f%04d.ppm"),
                    "-vf", "scale=640:480:flags=neighbor,split[a][b];[a]palettegen[p];[b][p]paletteuse",
                    gif], check=True)
    print(f"rendered {n} frames -> {gif}")


if __name__ == "__main__":
    ok = check()
    render()
    sys.exit(0 if ok else 1)
