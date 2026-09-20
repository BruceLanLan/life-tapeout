# Life on tapeout.net

**English** · [中文](README.md)

[tapeout.net](https://tapeout.net) (TapeOut Protocol, on BSC) turns circuits into NFTs. The canvas has five primitives — input pin, output pin, constant 0/1, **NAND**, and **LATCH** (one bit of state, updated every beat). Each NAND or LATCH costs one "transistor" token; "taping out" burns the tokens and mints a circuit NFT.

This directory holds study notes on that protocol and a complete design of Conway's Game of Life on top of it. **Everything here is read-only analysis: no wallet was connected, no transaction was sent, no money was spent.**

## 1. How the protocol works

### Netlist format (as read from the public front-end code, `assets/netlist-*.js`)

Signal numbering: `0` = constant 0, `1` = constant 1, `2 .. 2+nIn-1` = input pins, then every element appends its own output signals in order. **The circuit's outputs are the last nOut signals.**

| Opcode | Encoding | Signals produced |
|---|---|---|
| `NAND` 0x00 | `a:u24 b:u24` | 1 |
| `LATCH` 0x01 | `d:u24` | 1 (the value of d at the previous beat) |
| `REF` 0x02 | `cpu:address20 circuitId:u64 nIns:u8 nOut:u8 ins:u24[]` | nOut |

- NAND and REF inputs may only reference **earlier** signals; **a LATCH's d may reference later ones** — this is the only way to build sequential feedback.
- `REF` can reference **any taped-out circuit of any project**. Cross-project reuse is the key to cost optimisation.

### Contract interface (BSC mainnet, read-only part)

| Function | Purpose |
|---|---|
| `circuitInfo(id) -> (nIn, nOut, nState, gateCount)` | circuit metadata |
| `netlist(id) -> bytes` | fetch the netlist |
| `eval(id, bytes) view -> bytes` | run combinational logic, free |
| `step(id, state, inputs) view -> (newState, outputs)` | run one beat of sequential logic, free, caller supplies the state |
| `beat(cpu, id, inputs) -> outputs` | run one beat on chain, state stored on chain (`heartOf(who,cpu,id)`), costs gas |
| `tapeout(netlist, nIn, nOut) payable -> id` | tape out, burns tokens |

Inputs and outputs are packed into bytes **little-endian bit order**.

### Pricing rules

- Tapeout burns the **top-level** NAND/LATCH count only; **sub-circuits reached through REF are not charged again** (the "cumulative gates incl. reuse" on a project page is just a statistic).
- The canvas compiler inserts a 2-NAND buffer per output pin (`burnNand = nand + nOut*2` in the front end). **Generating the netlist directly avoids that.**
- 393 of the 931 projects have a mint price of 0, some with supply left. Protocol fees: 0.0001 BNB per mint call, 0.0002 BNB per tapeout, plus gas.
- The canvas can import **BLIF**, so Yosys output can be dragged in — but see §4 for what that costs.

## 2. A survey of the public circuits on chain

`scan_info.mjs` scanned all 931 projects: **27,671 circuits** (9.67 million gates in total). `classify.mjs` downloads the small combinational ones, runs their truth tables locally and matches them against reference functions.

The second pass ([scan/classify2.mjs](scan/classify2.mjs)) resolves circuits that use REF recursively and widens the library to 39 functions: **12,015 of 13,401 candidates identified**. Limits remain: only stateless circuits with at most 14 inputs whose shape matches the reference table. So the table below lists "the smallest implementation within the identified range", not a global optimum, and "there is no Life rule on chain" holds only within that range.

One observation: 4 of the 13,401 candidates use REF today. Cross-circuit reuse is still early on the platform, and it is exactly the mechanism this design leans on.

The raw data is not committed (`npm run survey` regenerates it in about an hour). Summary of what was identified, with credit to the projects:

| Function | Smallest gate count | Project / circuit id |
|---|---|---|
| NAND / AND / OR | 1 / 2 / 3 | Genesis #4255, Blonskr_No1 #47 #48 |
| NOR / XOR / MUX2 | 4 | Blonskr_No1 #49 #50, Genesis #4263 |
| XNOR / half adder | 5 | Genesis #4259 #4265 |
| 3-input majority | 6 | Genesis #4262 |
| full adder | 9 | Blonskr_No1 #145 |
| 2-to-4 decoder / MUX4 | 10 / 11 | Genesis #4267, TapeOut #1060 |
| 2×2 multiplier / 4-bit increment | 15 / 16 | Blonskr_No1 #533, TapeOut #924 |
| 4-bit greater-than / 4-bit popcount | 18 / 21 | Blonskr_No1 #1112, TapeOut #1799 |
| 4-bit shift (left / right) | 23 | Blonskr_No1 #1146 #1153 |
| 3-to-8 decoder / 4-bit equality | 25 / 26 | Blonskr_No1 #607 #152 |
| 8-bit parity | 28 | Genesis #4264 |
| 4+4-bit adder (with carry) | 32 | TapeOut #2118 |
| 8-bit increment / 3×3 multiplier | 36 / 45 | TapeOut #925, Blonskr_No1 #2469 |
| 6+6-bit adder | 50 | Blonskr_No1 #1881 |
| **8-bit popcount** | **55** | **TapeOut #3151** |
| 4×4 multiplier | 114 | TapeOut #8709 |

**TapeOut #3151, a 55-gate 8-bit popcount, is directly usable**: the first thing every Life cell does is count its 8 neighbours. Since REF is free, after plugging it in we only need 12 more NANDs for the decision (see below).

No ready-made Life rule was found on chain, so that part has to be built.

## 3. The design

### Variant A: a hand-built rule circuit, 56 NAND

[scan/build_life.mjs](scan/build_life.mjs) `buildRule()`, 10 inputs (8 neighbours + self + seed) → 1 output:

- three full adders and one half adder sum the 8 neighbours (41 gates);
- the decision uses the `(s | self) == 3` identity: only `!(s≥4) & s1 & (s0 | self)` is needed, not the full 4-bit count;
- the `seed` input is ORed into the result to inject an initial pattern, costing 2 gates (reusing an inverted intermediate).

**Verified exhaustively over all 1,024 inputs.** For comparison, Yosys + ABC synthesises the same function to 63 gates.

### Variant B: reuse the on-chain popcount8, spend only 12 NANDs

[scan/build_life_ref.mjs](scan/build_life_ref.mjs): REF TapeOut #3151 (55-gate popcount8), take the 4-bit neighbour count, and finish `!(b3|b2) & b1 & (b0|self)` plus seed injection in 12 NANDs. Also verified exhaustively.

The price is more gates per beat (68 per cell instead of 57 — the popcount produces a full count, more than Life needs). **Fewer tokens, more gas per beat.**

### Why the top-level LATCHes cannot be avoided

REF inputs may only reference earlier signals; only a LATCH's d may reference forward. So **every feedback loop across cells must pass through a top-level LATCH**:

- Making the "board storage" a reusable sub-circuit (say, REF-ing someone's 64-bit register) does not work — the register REF would have to come before the rule REFs to expose the current state, but its inputs (the next state) depend on the rule REFs' outputs. That is a cycle.
- So N² LATCHes are structurally unavoidable, and **120 transistors (64 LATCH + 56 NAND) is essentially the floor for 8×8**, unless a whole Life board has already been taped out for reuse (none was found).

### The grid: zero NANDs at the top level

`buildGrid(N)`: N² LATCHes hold the board; every cell REFs the rule circuit; each LATCH's d is wired to its REF's output (using the forward reference).

| Grid | Burned at tapeout (top level) | Total gates incl. reuse | Netlist size |
|---|---|---|---|
| 4×4 | 0 NAND + 16 LATCH | 912 | 1,040 B |
| 8×8 | 0 NAND + 64 LATCH | 3,648 | 4,160 B |
| 16×16 | 0 NAND + 256 LATCH | 14,592 | 16,640 B |

Three approaches compared on 8×8:

| Approach | Transistors burned | Gates per beat | Gas per beat (extrapolated) |
|---|---|---|---|
| Yosys flat tiling, no REF | 3,579 | 3,515 | ~9.05M |
| A: own 56-gate rule + REF | **120** (64 LATCH + 56 NAND) | 3,648 | ~9.40M |
| B: reuse #3151 + 12 gates | **76** (64 LATCH + 12 NAND) | 4,352 | ~11.15M |

Where the gas numbers come from ([scan/gas_probe.mjs](scan/gas_probe.mjs), `eth_estimateGas`, read-only):

- `eval()` measured on three deployed circuits of different sizes: 65 gates → 201,058 gas; 1,204 → 2,960,378; 2,584 → 6,419,057. That fits **≈2,468 gas per gate + 40k**; the table extrapolates from it.
- The protocol's own budget formula is `runGasFor(gates, 1) = 3000×gates + 50000` with `maxRunGas()` = 12,000,000 — but those live on the **mining** contract (0x7E2E…7b46) and I could not show that a plain `beat()` is bound by them (the contract is a proxy; `beat`/`evaluate` revert when called directly, presumably needing registration). So **whether 8×8 exceeds a protocol limit is undecided**; both variants are well inside BSC's block gas limit (~140M).
- How big a read-only call can be: a 6,020-gate circuit `eth_estimateGas` fine (14.28M); at 9,632 gates estimateGas fails but `eth_call` still returns; at 30,736 gates both fail. **16×16 (14,592 gates) can probably be run through read-only `step()`; on-chain `beat` is unknown.**

Verification: a glider on 4×4 / 8×8 / 16×16 for 4N beats, every beat bit-identical to a reference implementation. The local simulator was cross-checked against the chain's `eval()` twice: Standard Cell Library #1 (65 gates, 6/6 match) and Blonskr_No1 #30 (1,204 gates, **uses REF**, 8/8 match) — the latter confirms the REF semantics the whole grid design rests on.

```sh
cd scan
node build_life.mjs                    # variant A: build + verify, write netlists
node build_life_ref.mjs                # variant B: reuse the on-chain popcount8
node find_refs.mjs                     # find on-chain circuits that use REF
node demo.mjs 8 24                     # watch a glider in the terminal (N need not be a power of two)
node gas_probe.mjs                     # measure on-chain eval() gas
node verify_chain.mjs 0xFAc299310ca53DB70De49F5e11D3B14A41B1Ef75 1 6   # simulator vs on-chain eval
node scan_info.mjs && node classify2.mjs   # redo the survey (~1 hour, public RPCs rate-limit)
```

### Baseline: flat tiling without REF (Yosys)

[life_core.v](life_core.v) synthesised to pure NAND, about 55 NAND + 1 LATCH per cell:

| Grid | NAND | LATCH | Total |
|---|---|---|---|
| 4×4 | 854 | 16 | 870 |
| 8×8 | 3,515 | 64 | 3,579 |
| 16×16 | 14,208 | 256 | 14,464 |
| 32×32 | 57,096 | 1,024 | 58,120 |

### About oimo's infinite recursion

One OTCA metapixel is 2048×2048 ≈ 4.2 million cells; even with REF that is 4.2 million LATCHes. Not realistic on chain, same conclusion as for silicon: **the recursive zoom is a pre-computation and rendering achievement, not something to synthesise gate by gate.**

## 4. If you do decide to tape out

[scan/make_calldata.mjs](scan/make_calldata.mjs) produces calldata you can paste into a wallet; it sends nothing itself:

```sh
node make_calldata.mjs 8                                   # mint + tapeout calldata for the rule circuit
node make_calldata.mjs 8 <projectCircuitsAddress> <ruleId> # after the rule is taped out, the grid
```

Order: mint 56 NAND → `tapeout(ruleNetlist, 10, 1)` → read the circuitId from the `TapedOut` event → mint 64 LATCH → `tapeout(gridNetlist, 64, 64)`.

Read-only preflight the script performs:

- exhaustive 1,024-input self-test of the rule;
- encode → decode → encode round-trip of the netlist;
- reads `TAPEOUT_FEE()` on chain (0.0002 BNB measured) and the project's circuit count;
- **a dry run of the tapeout via `eth_call`** from an address with no tokens: it reverts with `ERC1155InsufficientBalance` (OpenZeppelin custom error `0x03dee4c5`). Selector, offsets and length fields are all correct — the call reaches the token burn and only the tokens are missing.

### Canvas or calldata?

[scan/blif.mjs](scan/blif.mjs) exports the rule as BLIF (`out/life_rule.blif`), which the official canvas can import. Tested in the canvas (front end only, no wallet): **it imports and passes the self-check**, but the canvas compiles each 2-input `.names` NAND into three NANDs (AND + NOT), so **56 gates become 168**, plus the fixed 2 output buffers = 170 transistors. The on-set form (`0- 1 / -0 1`) is worse at 252.

The BLIF importer only accepts flat netlists (`.inputs/.outputs/.names/.latch`, no `.subckt`), so the REF structure cannot be expressed either.

| Route | Rule circuit | 8×8 grid | Note |
|---|---|---|---|
| canvas BLIF import | 170 | ~3,776 (`out/life_grid_8.blif`, flat) | you see the drawing; 3× the cost |
| raw `tapeout()` calldata | **56** | **64** | cheapest; the canvas can later render the design from the on-chain netlist |

One more hard limit confirmed from the front end: **a single tapeout transaction tops out around 40,000 netlist bytes**. The 8×8 grid (4,160 B) and 16×16 (16,640 B) are both within it.

## 5. Browser playground

[docs/playground.html](../docs/playground.html) (live: https://brucelanlan.github.io/life-tapeout/playground.html) runs the same netlist in a browser: watch the board, click a cell to see its 3×3 neighbourhood and the 56 NANDs flipping live. The rule code embedded in the page was re-checked with node and is identical to the repository's (56 gates, 392 bytes, 0 mismatches over 1,024 inputs).

## 6. Not done / unconfirmed

- No wallet, no transactions. To go on chain you mint tokens yourself and call `tapeout(netlist, nIn, nOut)`.
- The real gas of `beat()` and whether `maxRunGas` bounds it could not be confirmed (proxy contract, direct calls revert). The gas figures above are extrapolated from `eval()`.
- The grid circuit itself has not been taped out, so there is no real on-chain `step()` result to compare against; the simulator's correctness is established indirectly through deployed circuits (including the one with REF).
- The protocol also has a "mining" mechanism (`getMiner` / `registerCounterexample` / `passesQuality`) that appears to reward minimal circuits for standard functions; not explored.
