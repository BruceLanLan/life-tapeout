// Hand-built Game of Life netlists in the TapeOut format, verified locally.
//
//   rule  : 10 inputs (n0..n7, self, seed) -> 1 output, next = life(n, self) | seed
//   grid  : N*N inputs (seed per cell) -> N*N outputs; N*N top-level LATCHes hold the
//           board and each cell REFs the rule circuit, so only the rule's NANDs and the
//           board's LATCHes cost transistors.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { OP, encode, compile, step } from "./netlist.mjs";

export class Builder {
  constructor(nIn) { this.nIn = nIn; this.els = []; this.next = 2 + nIn; }
  input(i) { return 2 + i; }
  nand(a, b) { this.els.push({ op: OP.NAND, a, b, out: this.next }); return this.next++; }
  not(a) { return this.nand(a, a); }
  latch() {
    const el = { op: OP.LATCH, d: 0, out: this.next++ };
    this.els.push(el);
    return { q: el.out, setD: (d) => { el.d = d; } };
  }
  ref(cpu, id, ins, nOut) {
    const outs = Array.from({ length: nOut }, () => this.next++);
    this.els.push({ op: OP.REF, cpu, id, ins, nOut, outs });
    return outs;
  }
  // a xor b, also returns nand(a,b) for reuse
  xor(a, b) {
    const t = this.nand(a, b);
    return { x: this.nand(this.nand(a, t), this.nand(b, t)), nab: t };
  }
  // full adder: 9 NAND
  fa(a, b, c) {
    const { x: p, nab: t1 } = this.xor(a, b);
    const { x: s, nab: t2 } = this.xor(p, c);
    return { s, c: this.nand(t1, t2) };
  }
  // half adder: 5 NAND
  ha(a, b) {
    const { x, nab } = this.xor(a, b);
    return { s: x, c: this.not(nab) };
  }
  // move the given signals to the end so they become the outputs (costs nothing if already last)
  get nNand() { return this.els.filter((e) => e.op === OP.NAND).length; }
  get nLatch() { return this.els.filter((e) => e.op === OP.LATCH).length; }
}

// ---------------------------------------------------------------- rule circuit
// Live next iff neighbours s in {2,3} and (s == 3 or self): with s = 8*b3 + 4*b2 + 2*b1 + b0
// that is  !(s >= 4) & b1 & (b0 | self)  — the "(s | self) == 3" trick.
export function buildRule() {
  const b = new Builder(10);
  const n = [...Array(8).keys()].map((i) => b.input(i));
  const self = b.input(8), seed = b.input(9);

  const f1 = b.fa(n[0], n[1], n[2]);
  const f2 = b.fa(n[3], n[4], n[5]);
  const h3 = b.ha(n[6], n[7]);
  const f4 = b.fa(f1.s, f2.s, h3.s);          // b0 = f4.s, carries have weight 2
  const f5 = b.fa(f1.c, f2.c, h3.c);          // (p, q) = count of the first three carries
  // weight-2 total = p + f4.c + 2q  ->  b1 = p ^ f4.c,  ge4 = q | (p & f4.c)
  const { x: b1, nab: t } = b.xor(f5.s, f4.c);
  const ge4 = b.nand(b.not(f5.c), t);
  const orv = b.nand(b.not(f4.s), b.not(self)); // b0 | self
  const x = b.not(b.nand(b1, orv));             // b1 & (b0|self)
  const nlife = b.nand(x, b.not(ge4));          // !life
  b.nand(nlife, b.not(seed));                   // out = life | seed  (last signal = output)
  return b;
}

const lifeRef = (nb, self) => {
  const s = nb.reduce((x, y) => x + y, 0);
  return s === 3 || (self && s === 2) ? 1 : 0;
};

export function verifyRule(c) {
  for (let v = 0; v < 1024; v++) {
    const bits = [...Array(10).keys()].map((i) => (v >> i) & 1);
    const want = lifeRef(bits.slice(0, 8), bits[8]) | bits[9];
    const got = step(c, new Uint8Array(0), bits).outputs[0];
    if (got !== want) throw new Error(`rule mismatch at input ${v}: got ${got}, want ${want}`);
  }
}

// ---------------------------------------------------------------- grid circuit
export function buildGrid(N, ruleCpu, ruleId) {
  const b = new Builder(N * N);
  const cells = Array.from({ length: N * N }, () => b.latch());
  const at = (r, c) => cells[((r + N) % N) * N + ((c + N) % N)].q;
  const outs = [];
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) {
      const nb = [at(r - 1, c - 1), at(r - 1, c), at(r - 1, c + 1), at(r, c - 1),
                  at(r, c + 1), at(r + 1, c - 1), at(r + 1, c), at(r + 1, c + 1)];
      const [o] = b.ref(ruleCpu, ruleId, [...nb, at(r, c), b.input(r * N + c)], 1);
      cells[r * N + c].setD(o);
      outs.push(o);
    }
  // outputs are the last N*N signals = the REF outputs in row-major order = the new board
  return b;
}

function lifeStepRef(g, N) {
  return g.map((v, i) => {
    const r = Math.floor(i / N), c = i % N;
    const nb = [];
    for (const dr of [-1, 0, 1]) for (const dc of [-1, 0, 1])
      if (dr || dc) nb.push(g[((r + dr + N) % N) * N + ((c + dc + N) % N)]);
    return lifeRef(nb, v);
  });
}

export function verifyGrid(gridC, N, beats = 64) {
  let state = new Uint8Array(gridC.nState);
  const seed = new Array(N * N).fill(0);
  for (const [r, c] of [[0, 1], [1, 2], [2, 0], [2, 1], [2, 2]]) seed[r * N + c] = 1; // glider
  let r = step(gridC, state, seed);         // beat 0: seed ORs the glider in
  let board = r.outputs;
  state = r.state;
  for (let t = 1; t <= beats; t++) {
    r = step(gridC, state, new Array(N * N).fill(0));
    const want = lifeStepRef(board, N);
    if (r.outputs.join("") !== want.join("")) throw new Error(`grid mismatch at beat ${t}`);
    board = r.outputs;
    state = r.state;
  }
  return board;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rule = buildRule();
  const ruleBytes = encode(rule.els);
  const ruleC = compile(ruleBytes, 10, 1);
  verifyRule(ruleC);
  console.log(`rule: ${rule.nNand} NAND, ${rule.nLatch} LATCH, ${ruleBytes.length} bytes — exhaustive 1024/1024 OK`);

  const LOCAL = "0x0000000000000000000000000000000000000001"; // placeholder until the rule is taped out
  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync("out/life_rule.hex", "0x" + Buffer.from(ruleBytes).toString("hex") + "\n");
  for (const N of [4, 8, 16]) {
    const g = buildGrid(N, LOCAL, 1);
    const bytes = encode(g.els);
    const gc = compile(bytes, N * N, N * N, () => ruleC);
    verifyGrid(gc, N, 4 * N);
    console.log(`grid ${N}x${N}: top-level ${g.nNand} NAND + ${g.nLatch} LATCH, ${gc.totalGates} gates incl. REFs, ` +
      `${bytes.length} bytes — glider ${4 * N} beats OK`);
  }
}
