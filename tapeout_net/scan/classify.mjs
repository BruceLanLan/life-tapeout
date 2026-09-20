// Identify what the existing on-chain circuits actually compute, by running their
// netlists locally over a truth table and matching against a library of reference
// functions. Read-only.
import fs from "node:fs";
import { batchCall, callData, decodeBytes, SEL } from "./rpc.mjs";
import { compile, decode, step } from "./netlist.mjs";

const MAX_IN = 12;          // 4096 rows is cheap; bigger circuits get random sampling
const MAX_GATES = 2000;

const bits = (v, n) => Array.from({ length: n }, (_, i) => (v >> i) & 1);
const num = (a) => a.reduce((s, b, i) => s + (b << i), 0);
const pop = (a) => a.reduce((s, b) => s + b, 0);

// reference functions: name -> (inputs) => outputs, for a given (nIn, nOut)
const REFS = [
  ["half adder", 2, 2, (i) => [i[0] ^ i[1], i[0] & i[1]]],
  ["full adder", 3, 2, (i) => [i[0] ^ i[1] ^ i[2], (i[0] & i[1]) | (i[1] & i[2]) | (i[0] & i[2])]],
  ["popcount8", 8, 4, (i) => bits(pop(i), 4)],
  ["popcount9", 9, 4, (i) => bits(pop(i), 4)],
  ["popcount9", 9, 5, (i) => bits(pop(i), 5)],
  ["popcount16", 16, 5, (i) => bits(pop(i), 5)],
  ["life rule (8 nb + self)", 9, 1, (i) => [pop(i.slice(0, 8)) === 3 || (i[8] && pop(i.slice(0, 8)) === 2) ? 1 : 0]],
  ["life rule (self first)", 9, 1, (i) => [pop(i.slice(1)) === 3 || (i[0] && pop(i.slice(1)) === 2) ? 1 : 0]],
  ["add4+4", 8, 5, (i) => bits(num(i.slice(0, 4)) + num(i.slice(4)), 5)],
  ["add4+4+cin", 9, 5, (i) => bits(num(i.slice(0, 4)) + num(i.slice(4, 8)) + i[8], 5)],
  ["add8+8", 16, 9, (i) => bits(num(i.slice(0, 8)) + num(i.slice(8)), 9)],
  ["add8+8+cin", 17, 9, (i) => bits(num(i.slice(0, 8)) + num(i.slice(8, 16)) + i[16], 9)],
  ["mux2", 3, 1, (i) => [i[2] ? i[1] : i[0]]],
  ["xor", 2, 1, (i) => [i[0] ^ i[1]]],
  ["and", 2, 1, (i) => [i[0] & i[1]]],
  ["or", 2, 1, (i) => [i[0] | i[1]]],
  ["nand", 2, 1, (i) => [i[0] & i[1] ? 0 : 1]],
  ["nor", 2, 1, (i) => [i[0] | i[1] ? 0 : 1]],
  ["xnor", 2, 1, (i) => [i[0] ^ i[1] ? 0 : 1]],
];

function classify(c) {
  const cands = REFS.filter((r) => r[1] === c.nIn && r[2] === c.nOut);
  if (!cands.length) return null;
  const rows = 1 << c.nIn;
  for (let v = 0; v < rows; v++) {
    const inp = bits(v, c.nIn);
    const out = step(c, new Uint8Array(0), inp).outputs;
    for (let k = cands.length - 1; k >= 0; k--) {
      const want = cands[k][3](inp);
      if (want.join("") !== out.join("")) cands.splice(k, 1);
    }
    if (!cands.length) return null;
  }
  return cands[0][0];
}

async function fetchMany(items) {
  const out = new Map();
  const B = 40;
  for (let i = 0; i < items.length; i += B) {
    const chunk = items.slice(i, i + B);
    const res = await batchCall(chunk.map((j) => ({ to: j.cpu, data: callData(SEL.netlist, j.id) })));
    chunk.forEach((j, k) => { if (res[k]) out.set(`${j.cpu}:${j.id}`, decodeBytes(res[k])); });
    if (i % 400 === 0) console.error(`netlists ${i}/${items.length}`);
  }
  return out;
}

const infos = JSON.parse(fs.readFileSync("data/infos.json"));
const cands = infos.filter((x) => x.nState === 0 && x.nIn <= MAX_IN && x.nIn >= 2 &&
  x.gates <= MAX_GATES && REFS.some((r) => r[1] === x.nIn && r[2] === x.nOut));
console.error(`${cands.length} candidate circuits of ${infos.length}`);

const nlCache = fs.existsSync("data/netlists.json")
  ? new Map(Object.entries(JSON.parse(fs.readFileSync("data/netlists.json"))).map(([k, v]) => [k, Buffer.from(v, "hex")]))
  : new Map();
const missing = cands.filter((j) => !nlCache.has(`${j.cpu}:${j.id}`));
const fetched = await fetchMany(missing);
for (const [k, v] of fetched) nlCache.set(k, v);
fs.writeFileSync("data/netlists.json",
  JSON.stringify(Object.fromEntries([...nlCache].map(([k, v]) => [k, Buffer.from(v).toString("hex")]))));

const results = [];
for (const j of cands) {
  const b = nlCache.get(`${j.cpu}:${j.id}`);
  if (!b) continue;
  try {
    if (decode(b, j.nIn).some((e) => e.op === 2)) continue;  // skip REF circuits for now
    const c = compile(b, j.nIn, j.nOut, () => { throw new Error("ref"); });
    const what = classify(c);
    if (what) results.push({ ...j, what, nand: c.nNand });
  } catch { /* undecodable or needs REF resolution */ }
}
fs.writeFileSync("data/classified.json", JSON.stringify(results, null, 1));

const byName = new Map();
for (const r of results) {
  const cur = byName.get(r.what);
  if (!cur || r.nand < cur.nand) byName.set(r.what, r);
}
console.log(`\nidentified ${results.length} circuits\n`);
console.log("smallest known implementation of each function:");
for (const [name, r] of [...byName].sort((a, b) => a[1].nand - b[1].nand))
  console.log(`  ${name.padEnd(24)} ${String(r.nand).padStart(5)} NAND   ${r.cpu} #${r.id}`);
