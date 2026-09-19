# life-tapeout

Conway's Game of Life as a [Tiny Tapeout](https://tinytapeout.com) chip, plus a reverse-engineering study of oimo's [Life Universe](https://oimo.io/works/life).

![VGA output captured from RTL simulation](docs/life_vga.gif)

- **Research (中文)**: [docs/research.md](docs/research.md) — how the infinite zoom works, Turing completeness, and whether it can be taped out.
- **RTL**: [src/tt_um_life.v](src/tt_um_life.v) — N×N torus, every cell updated in parallel during vblank, 640×480 VGA on the TinyVGA PMOD pinout.
- **Tiny Tapeout metadata (draft)**: [info.yaml](info.yaml)

## Pins

| Pin | Function |
|---|---|
| `ui_in[0]` | run |
| `ui_in[1]` | step (rising edge = one generation) |
| `ui_in[2]` | load preset (rising edge) |
| `ui_in[4:3]` | preset: 0 glider, 1 R-pentomino, 2 LWSS, 3 random |
| `ui_in[7:5]` | speed: one generation every 2^speed frames |
| `uo_out` | TinyVGA PMOD `{hsync, B0, G0, R0, vsync, B1, G1, R1}` |
| `uio_out` | generation counter |

Clock: 25.175 MHz (25 MHz works on most monitors).

## Simulate

Needs `iverilog`, Python 3 with numpy, and `ffmpeg`. The testbench acts like a monitor: it locks onto hsync/vsync, captures frames, and dumps the grid every generation for a golden-model check.

```sh
mkdir -p sim
iverilog -g2012 -o sim/tb.vvp test/tb.v src/tt_um_life.v
cd sim && vvp -n tb.vvp && python3 ../test/check_and_render.py 16
```

The full run takes ~18 minutes in Icarus. Add `+short` to `vvp` for a quick run, or build with `-Ptb.N=8 -Ptb.CSH=5` and pass `8` to the Python script for an 8×8 grid.

## Synthesize (area estimate)

```sh
./synth/fetch_lib.sh
yosys -s synth/synth_16.ys
```

| Grid | Cells | Area (sky130_fd_sc_hd) | Tiny Tapeout tiles (estimate) |
|---|---|---|---|
| 8×8 | 1723 | 16.2k µm² | 1×2 |
| 16×16 | 5955 | 54.6k µm² | 3×2 |
