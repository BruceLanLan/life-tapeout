// Export our circuits as flat BLIF, the format the tapeout.net canvas imports
// (.inputs/.outputs/.names/.latch only — no .subckt, so REF cannot be expressed).
//
//   out/life_rule.blif      the 56-NAND rule (10 in -> 1 out)
//   out/life_grid_N.blif    a fully flattened N x N board: N² latches + N² copies of the rule
import fs from "node:fs";
import { OP } from "./netlist.mjs";
import { buildRule, Builder } from "./build_life.mjs";

function toBlif(model, b, inNames, outNames, outSignals) {
  const name = new Map();
  name.set(0, "zero"); name.set(1, "one");
  inNames.forEach((n, i) => name.set(2 + i, n));
  const lines = [`.model ${model}`, `.inputs ${inNames.join(" ")}`, `.outputs ${outNames.join(" ")}`];
  let usesConst = { zero: false, one: false };
  let k = 0;
  const sig = (s) => { const n = name.get(s); if (n === "zero" || n === "one") usesConst[n] = true; return n; };
  const latches = [];
  for (const e of b.els) {
    if (e.op === OP.NAND) {
      const o = `g${k++}`; name.set(e.out, o);
      lines.push(`.names ${sig(e.a)} ${sig(e.b)} ${o}`, "11 0");
    } else if (e.op === OP.LATCH) {
      const o = `q${k++}`; name.set(e.out, o);
      latches.push(e);
    } else throw new Error("REF cannot be expressed in flat BLIF");
  }
  for (const e of latches) lines.push(`.latch ${name.get(e.d)} ${name.get(e.out)} re clk 0`);
  // output pins are aliases of internal signals
  outNames.forEach((o, i) => lines.push(`.names ${name.get(outSignals[i])} ${o}`, "1 1"));
  if (usesConst.zero) lines.splice(3, 0, ".names zero", "");
  if (usesConst.one) lines.splice(3, 0, ".names one", "1");
  if (latches.length) lines[1] += " clk";
  lines.push(".end");
  return lines.join("\n") + "\n";
}

// flat N x N board: every cell gets its own copy of the rule gates
function buildFlatGrid(N) {
  const b = new Builder(N * N);
  const cells = Array.from({ length: N * N }, () => b.latch());
  const at = (r, c) => cells[((r + N) % N) * N + ((c + N) % N)].q;
  const outs = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const n = [at(r - 1, c - 1), at(r - 1, c), at(r - 1, c + 1), at(r, c - 1),
               at(r, c + 1), at(r + 1, c - 1), at(r + 1, c), at(r + 1, c + 1)];
    const self = at(r, c), seed = b.input(r * N + c);
    // same construction as buildRule(), inlined
    const f1 = b.fa(n[0], n[1], n[2]), f2 = b.fa(n[3], n[4], n[5]), h3 = b.ha(n[6], n[7]);
    const f4 = b.fa(f1.s, f2.s, h3.s), f5 = b.fa(f1.c, f2.c, h3.c);
    const { x: b1, nab: t } = b.xor(f5.s, f4.c);
    const ge4 = b.nand(b.not(f5.c), t);
    const orv = b.nand(b.not(f4.s), b.not(self));
    const x = b.not(b.nand(b1, orv));
    const nlife = b.nand(x, b.not(ge4));
    const o = b.nand(nlife, b.not(seed));
    cells[r * N + c].setD(o);
    outs.push(o);
  }
  return { b, outs };
}

fs.mkdirSync("out", { recursive: true });

const rule = buildRule();
const ruleOut = rule.els[rule.els.length - 1].out;
const ruleBlif = toBlif("life_rule", rule,
  ["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7", "self", "seed"], ["next"], [ruleOut]);
fs.writeFileSync("out/life_rule.blif", ruleBlif);
console.log(`out/life_rule.blif: ${rule.nNand} NAND, ${ruleBlif.length} chars`);

for (const N of [4, 8]) {
  const { b, outs } = buildFlatGrid(N);
  const ins = Array.from({ length: N * N }, (_, i) => `seed${i}`);
  const os = Array.from({ length: N * N }, (_, i) => `cell${i}`);
  const blif = toBlif(`life_${N}x${N}`, b, ins, os, outs);
  fs.writeFileSync(`out/life_grid_${N}.blif`, blif);
  console.log(`out/life_grid_${N}.blif: ${b.nNand} NAND + ${b.nLatch} LATCH (flat, no REF)`);
}
