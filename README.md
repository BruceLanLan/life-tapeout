# life-tapeout

Conway's Game of Life on two kinds of "tapeout", plus a reverse-engineering study of oimo's [Life Universe](https://oimo.io/works/life):

1. **[tapeout.net](https://tapeout.net)** — the on-chain NAND/LATCH circuit protocol. Protocol reverse-engineered, all 27,671 existing circuits surveyed and functionally classified, and a Life design that burns 120 transistors for an 8×8 board (naive: 3,579). See **[tapeout_net/](tapeout_net/README.md)**.
2. **[Tiny Tapeout](https://tinytapeout.com)** — real silicon (sky130). Verilog Life engine with VGA output, simulated and synthesized.

![VGA output captured from RTL simulation](docs/life_vga.gif)

- **tapeout.net (中文)**: [tapeout_net/README.md](tapeout_net/README.md) — netlist format, circuit census, the Life design with verification, ready-to-send `tapeout()` calldata, and why the canvas BLIF import costs 3× more
- **Playground**: [tapeout_net/nand-life-bench.html](tapeout_net/nand-life-bench.html) — the same netlist running in a browser, with a live probe into the 56 gates that decide one cell
- **Research (中文)**: [docs/research.md](docs/research.md) — how the infinite zoom works, Turing completeness, and whether it can be taped out
- **RTL**: [src/tt_um_brucelanlan_life.v](src/tt_um_brucelanlan_life.v) — N×N torus, every cell updated in parallel during vblank, 640×480 VGA on the TinyVGA PMOD pinout
- **Tiny Tapeout metadata (draft)**: [info.yaml](info.yaml)

## Tiny Tapeout pins

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

## Simulate the Verilog

Needs `iverilog`, Python 3 with numpy, and `ffmpeg`. The testbench acts like a monitor: it locks onto hsync/vsync, captures frames, and dumps the grid every generation for a golden-model check.

```sh
mkdir -p sim
iverilog -g2012 -o sim/tb.vvp test/tb.v src/tt_um_brucelanlan_life.v
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
