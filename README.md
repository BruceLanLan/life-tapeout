# life-tapeout

**English** · [中文](README.zh.md) · [Showcase](https://brucelanlan.github.io/life-tapeout/) · [Playground](https://brucelanlan.github.io/life-tapeout/playground.html)

A learning project: Conway's Game of Life, studied and rebuilt for two very different kinds of "tapeout".

| Track | What it is | What's here |
|---|---|---|
| **[tapeout.net](https://tapeout.net)** | An on-chain protocol (BSC) where circuits are built from two token-priced parts, NAND and LATCH, and any taped-out circuit can be reused by others via `REF` | Notes on how the protocol works (from its public front end and contracts), a survey of the public circuits on chain for reference (**27,671** looked at, **12,015** matched to a known function), and a Life design that uses `REF` to bring an 8×8 board down to **120 transistors** (about 3,579 without reuse) |
| **[Tiny Tapeout](https://tinytapeout.com)** | Real silicon: many small designs share one sky130 chip | Verilog Life engine with 640×480 VGA output, monitor-style testbench with golden-model check, synthesized for area |

It started from reading the public source of oimo's [Life Universe](https://oimo.io/works/life), the "infinitely recursive" Game of Life, to understand how it works. Short version: it is a beautiful piece of engineering — HashLife pre-computation over one OTCA metapixel plus a shader that walks the resulting quadtree — and precisely because the heavy lifting is done ahead of time, it is not something that maps onto a chip or a chain directly. The notes are in [docs/research.md](docs/research.md).

![VGA output captured from RTL simulation](docs/life_vga.gif)

Nothing in this repository has been sent on-chain. Every on-chain interaction is a read-only call; no wallet was connected and no funds were spent.

## Highlights

- **Netlist format understood and cross-checked.** A decoder, encoder and simulator for tapeout.net's binary netlist (`NAND` / `LATCH` / `REF`), written from the platform's public front-end code and validated against the contract's own `eval()` on deployed circuits, including one that uses `REF`.
- **A survey of public circuits, for reference.** The circuits already on chain were read through the public `netlist()` call (the raw data is not committed — `npm run survey` regenerates it), and the small combinational ones were run through truth tables against a library of 39 reference functions. The smallest implementations found for adders, multipliers, decoders, comparators and popcounts are tabulated with credit to their projects. `REF` is still rarely used on chain (4 of 13,401 candidates), which is what makes it interesting.
- **A 56-NAND Life rule, verified exhaustively** (Yosys+ABC gives 63 for the same function). A second variant builds on an existing on-chain 55-NAND popcount and needs only 12 NANDs of its own.
- **A board with zero top-level gates.** N² LATCHes hold the state; each cell is one `REF` to the rule. Why the LATCHes cannot be factored out is argued in the docs.
- **Ready-to-send calldata**, dry-run against the chain: the simulated `tapeout()` call reverts exactly at the token burn (`ERC1155InsufficientBalance`), proving the encoding reaches the right function.
- **Two ways to submit.** Importing the rule as BLIF into the official canvas works and passes its self-check; the canvas's general-purpose BLIF compiler expands each 2-input `.names` into three gates (170 vs 56 for this particular netlist), so for a hand-optimised NAND netlist, calling `tapeout()` directly is the leaner route.
- **Two interactive pages.** A [playground](docs/playground.html) that runs the identical netlist in a browser with a live probe into the 56 gates of one cell, and a bilingual [showcase page](docs/index.html).

## Repository layout

```
tapeout_net/            tapeout.net track
  README.md / README.en.md   the full write-up (中文 / English)
  scan/                 scripts: netlist codec + simulator, circuit survey, Life builders, calldata, BLIF export
  scan/out/             generated netlists (.hex), BLIF files, calldata.json
  scan/data/            survey cache (git-ignored; only the reused popcount8 netlist is committed)
  life_core.v           no-REF baseline for the Yosys NAND count
src/                    Tiny Tapeout Verilog (tt_um_brucelanlan_life)
test/                   Icarus testbench + golden-model check / GIF renderer
synth/                  Yosys scripts for the sky130 area estimate
docs/                   GitHub Pages: showcase page, playground, research notes, VGA capture
info.yaml               Tiny Tapeout project metadata (draft)
```

## Quick start

Node 22+, no dependencies.

```sh
cd tapeout_net/scan
npm test                 # build both Life rules + grids and verify them (exhaustive + glider)
npm run demo             # watch a glider crawl through the netlist simulator in the terminal
npm run calldata         # print mint/tapeout calldata for the rule circuit (sends nothing)
npm run survey           # re-read the public circuits on chain (about an hour on public RPCs)
```

Verilog track (`iverilog`, Python 3 + numpy, `ffmpeg`):

```sh
mkdir -p sim
iverilog -g2012 -o sim/tb.vvp test/tb.v src/tt_um_brucelanlan_life.v
cd sim && vvp -n tb.vvp && python3 ../test/check_and_render.py 16
```

The full 16×16 run takes about 22 minutes in Icarus (288 frames; 266 generation transitions, 0 mismatches). Add `+short` to `vvp` for a quick run, or build with `-Ptb.N=8 -Ptb.CSH=5` and pass `8` to the Python script.

Area estimate:

```sh
./synth/fetch_lib.sh && yosys -s synth/synth_16.ys
```

| Grid | Cells | Area (sky130_fd_sc_hd) | Tiny Tapeout tiles (estimate) |
|---|---|---|---|
| 8×8 | 1,723 | 16.2k µm² | 1×2 |
| 16×16 | 5,955 | 54.6k µm² | 3×2 |

CI runs the netlist tests, an 8×8 short simulation with the golden check, and the sky130 synthesis on every push.

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

## Status and what is deliberately not done

- Not taped out on either track. For tapeout.net the calldata is generated and dry-run; minting and sending is the owner's decision. For Tiny Tapeout the GDS flow (OpenLane) has not been run, so the tile count is an estimate.
- The real gas of an on-chain `beat()` is extrapolated from `eval()` measurements (≈2,468 gas per gate); whether the mining contract's 12M `maxRunGas` also applies to `beat()` could not be confirmed.

## Acknowledgements

- [saharan](https://github.com/saharan) for Life Universe and for publishing its source; this project only studied it.
- The [tapeout.net](https://tapeout.net) team for the protocol and for making circuits publicly readable, and every project whose circuits appear in the reference table.
- [Tiny Tapeout](https://tinytapeout.com) for making real silicon approachable.

## License

[MIT](LICENSE).
