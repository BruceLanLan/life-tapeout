// Life rule built on top of an EXISTING on-chain popcount8 circuit via REF.
// REF'd sub-circuits cost no transistors at tapeout, so this version burns only
// the handful of NANDs we add ourselves.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { encode, compile, step } from "./netlist.mjs";
import { Builder, buildGrid } from "./build_life.mjs";

// smallest popcount8 found on chain: 55 NAND (see data/classified.json)
export const POPCOUNT8 = { cpu: "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C", id: 3151 };

const netlists = JSON.parse(fs.readFileSync("data/netlists.json"));
const popBytes = Buffer.from(netlists[`${POPCOUNT8.cpu}:${POPCOUNT8.id}`], "hex");
const popC = compile(popBytes, 8, 4, () => { throw new Error("nested ref"); });

// which output bit is the LSB? (probe with a single 1)
const probe = (v) => step(popC, new Uint8Array(0), [v, 0, 0, 0, 0, 0, 0, 0]).outputs;
const LSB_FIRST = probe(1)[0] === 1;

export function buildRuleRef() {
  const b = new Builder(10);
  const n = [...Array(8).keys()].map((i) => b.input(i));
  const self = b.input(8), seed = b.input(9);
  const o = b.ref(POPCOUNT8.cpu, POPCOUNT8.id, n, 4);
  const [b0, b1, b2, b3] = LSB_FIRST ? o : [...o].reverse();

  // live iff !(b3|b2) & b1 & (b0|self), then OR in the seed
  const nge4 = b.not(b.nand(b.not(b3), b.not(b2)));  // !(b3|b2) = !b3 & !b2
  const orv = b.nand(b.not(b0), b.not(self));     // b0 | self
  const x = b.not(b.nand(b1, orv));               // b1 & (b0|self)
  const nlife = b.nand(x, nge4);                  // !life
  b.nand(nlife, b.not(seed));                     // life | seed
  return b;
}

const lifeRef = (nb, self) => {
  const s = nb.reduce((x, y) => x + y, 0);
  return s === 3 || (self && s === 2) ? 1 : 0;
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`popcount8 ${POPCOUNT8.cpu} #${POPCOUNT8.id}: ${popC.nNand} NAND, LSB first: ${LSB_FIRST}`);
  // sanity-check the sub-circuit itself
  for (let v = 0; v < 256; v++) {
    const inp = [...Array(8).keys()].map((i) => (v >> i) & 1);
    const got = step(popC, new Uint8Array(0), inp).outputs;
    const bitsOut = LSB_FIRST ? got : [...got].reverse();
    const want = [...Array(4).keys()].map((i) => (inp.reduce((a, c) => a + c, 0) >> i) & 1);
    if (bitsOut.join("") !== want.join("")) throw new Error(`popcount8 mismatch at ${v}`);
  }
  console.log("popcount8: 256/256 OK");

  const rule = buildRuleRef();
  const bytes = encode(rule.els);
  const ruleC = compile(bytes, 10, 1, () => popC);
  for (let v = 0; v < 1024; v++) {
    const inp = [...Array(10).keys()].map((i) => (v >> i) & 1);
    const want = lifeRef(inp.slice(0, 8), inp[8]) | inp[9];
    if (step(ruleC, new Uint8Array(0), inp).outputs[0] !== want) throw new Error(`rule mismatch at ${v}`);
  }
  console.log(`rule via REF: ${rule.nNand} own NAND (+ ${popC.nNand} reused for free), ` +
    `${ruleC.totalGates} gates total — exhaustive 1024/1024 OK`);

  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync("out/life_rule_ref.hex", "0x" + Buffer.from(bytes).toString("hex") + "\n");

  for (const N of [4, 8]) {
    const g = buildGrid(N, "0x0000000000000000000000000000000000000001", 1);
    const gc = compile(encode(g.els), N * N, N * N, () => ruleC);
    // glider check through the REF-based rule
    let state = new Uint8Array(gc.nState);
    const seed = new Array(N * N).fill(0);
    for (const [r, c] of [[0, 1], [1, 2], [2, 0], [2, 1], [2, 2]]) seed[r * N + c] = 1;
    let out = step(gc, state, seed);
    state = out.state;
    let board = out.outputs;
    for (let t = 1; t <= 4 * N; t++) {
      out = step(gc, state, new Array(N * N).fill(0));
      const want = board.map((v, i) => {
        const r = Math.floor(i / N), c = i % N, nb = [];
        for (const dr of [-1, 0, 1]) for (const dc of [-1, 0, 1])
          if (dr || dc) nb.push(board[((r + dr + N) % N) * N + ((c + dc + N) % N)]);
        return lifeRef(nb, v);
      });
      if (out.outputs.join("") !== want.join("")) throw new Error(`grid mismatch at beat ${t}`);
      board = out.outputs;
      state = out.state;
    }
    console.log(`grid ${N}x${N} on the REF rule: burn ${g.nLatch} LATCH + ${rule.nNand} NAND (rule, once), ` +
      `${gc.totalGates} gates/beat — glider ${4 * N} beats OK`);
  }
}
