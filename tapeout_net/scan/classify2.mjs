// Second-pass survey: includes circuits that use REF (resolved recursively) and a
// wider library of reference functions. Read-only.
import fs from "node:fs";
import { batchCall, callData, decodeBytes, SEL } from "./rpc.mjs";
import { compile, decode, step } from "./netlist.mjs";

const MAX_IN = 14, MAX_GATES = 6000;
const bits = (v, n) => Array.from({ length: n }, (_, i) => (v >> i) & 1);
const num = (a) => a.reduce((s, b, i) => s + (b << i), 0);
const pop = (a) => a.reduce((s, b) => s + b, 0);

const REFS = [
  ["half adder", 2, 2, (i) => [i[0] ^ i[1], i[0] & i[1]]],
  ["full adder", 3, 2, (i) => [i[0] ^ i[1] ^ i[2], (i[0] & i[1]) | (i[1] & i[2]) | (i[0] & i[2])]],
  ["and", 2, 1, (i) => [i[0] & i[1]]],
  ["or", 2, 1, (i) => [i[0] | i[1]]],
  ["xor", 2, 1, (i) => [i[0] ^ i[1]]],
  ["nand", 2, 1, (i) => [i[0] & i[1] ? 0 : 1]],
  ["nor", 2, 1, (i) => [i[0] | i[1] ? 0 : 1]],
  ["xnor", 2, 1, (i) => [i[0] ^ i[1] ? 0 : 1]],
  ["mux2", 3, 1, (i) => [i[2] ? i[1] : i[0]]],
  ["mux4", 6, 1, (i) => [i[num(i.slice(4, 6))]]],
  ["majority3", 3, 1, (i) => [pop(i) >= 2 ? 1 : 0]],
  ["parity8", 8, 1, (i) => [pop(i) & 1]],
  ["popcount4", 4, 3, (i) => bits(pop(i), 3)],
  ["popcount8", 8, 4, (i) => bits(pop(i), 4)],
  ["popcount9", 9, 4, (i) => bits(pop(i), 4)],
  ["popcount9", 9, 5, (i) => bits(pop(i), 5)],
  ["popcount12", 12, 4, (i) => bits(pop(i), 4)],
  ["life rule (8nb+self)", 9, 1, (i) => [pop(i.slice(0, 8)) === 3 || (i[8] && pop(i.slice(0, 8)) === 2) ? 1 : 0]],
  ["life rule (self first)", 9, 1, (i) => [pop(i.slice(1)) === 3 || (i[0] && pop(i.slice(1)) === 2) ? 1 : 0]],
  ["add4+4", 8, 5, (i) => bits(num(i.slice(0, 4)) + num(i.slice(4)), 5)],
  ["add4+4 (no carry out)", 8, 4, (i) => bits((num(i.slice(0, 4)) + num(i.slice(4))) & 15, 4)],
  ["add4+4+cin", 9, 5, (i) => bits(num(i.slice(0, 4)) + num(i.slice(4, 8)) + i[8], 5)],
  ["add6+6", 12, 7, (i) => bits(num(i.slice(0, 6)) + num(i.slice(6)), 7)],
  ["sub4-4", 8, 4, (i) => bits((num(i.slice(0, 4)) - num(i.slice(4))) & 15, 4)],
  ["inc4", 4, 5, (i) => bits(num(i) + 1, 5)],
  ["inc8", 8, 9, (i) => bits(num(i) + 1, 9)],
  ["inc8 (wrap)", 8, 8, (i) => bits((num(i) + 1) & 255, 8)],
  ["not8", 8, 8, (i) => i.map((b) => b ^ 1)],
  ["eq4", 8, 1, (i) => [num(i.slice(0, 4)) === num(i.slice(4)) ? 1 : 0]],
  ["gt4", 8, 1, (i) => [num(i.slice(0, 4)) > num(i.slice(4)) ? 1 : 0]],
  ["gte4", 8, 1, (i) => [num(i.slice(0, 4)) >= num(i.slice(4)) ? 1 : 0]],
  ["mul2x2", 4, 4, (i) => bits(num(i.slice(0, 2)) * num(i.slice(2)), 4)],
  ["mul3x3", 6, 6, (i) => bits(num(i.slice(0, 3)) * num(i.slice(3)), 6)],
  ["mul4x4", 8, 8, (i) => bits(num(i.slice(0, 4)) * num(i.slice(4)), 8)],
  ["decode3to8", 3, 8, (i) => Array.from({ length: 8 }, (_, k) => (k === num(i) ? 1 : 0))],
  ["decode2to4", 2, 4, (i) => Array.from({ length: 4 }, (_, k) => (k === num(i) ? 1 : 0))],
  ["7-segment", 4, 7, null],  // shape-only marker, decoded variants differ
  ["shift4 left by 2bit", 6, 4, (i) => bits((num(i.slice(0, 4)) << num(i.slice(4))) & 15, 4)],
  ["shift4 right by 2bit", 6, 4, (i) => bits(num(i.slice(0, 4)) >> num(i.slice(4)), 4)],
];

const shapeIndex = new Map();
for (const r of REFS) {
  if (!r[3]) continue;
  const k = `${r[1]}:${r[2]}`;
  if (!shapeIndex.has(k)) shapeIndex.set(k, []);
  shapeIndex.get(k).push(r);
}

function classify(c) {
  const cands = (shapeIndex.get(`${c.nIn}:${c.nOut}`) || []).slice();
  if (!cands.length) return null;
  for (let v = 0; v < (1 << c.nIn); v++) {
    const inp = bits(v, c.nIn);
    const out = step(c, new Uint8Array(0), inp).outputs.join("");
    for (let k = cands.length - 1; k >= 0; k--) if (cands[k][3](inp).join("") !== out) cands.splice(k, 1);
    if (!cands.length) return null;
  }
  return cands[0][0];
}

// ------------------------------------------------------------- netlist cache
const cacheFile = "data/netlists.json";
const cache = new Map(Object.entries(fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile)) : {}));
const key = (cpu, id) => `${cpu}:${id}`;
const infos = JSON.parse(fs.readFileSync("data/infos.json"));
const infoOf = new Map(infos.map((x) => [key(x.cpu, x.id).toLowerCase(), x]));

async function fetchNetlists(items) {
  const B = 40;
  for (let i = 0; i < items.length; i += B) {
    const chunk = items.slice(i, i + B);
    const res = await batchCall(chunk.map((j) => ({ to: j.cpu, data: callData(SEL.netlist, j.id) })));
    chunk.forEach((j, k) => { if (res[k]) cache.set(key(j.cpu, j.id), Buffer.from(decodeBytes(res[k])).toString("hex")); });
    if (i % 800 === 0) {
      console.error(`netlists ${i}/${items.length}`);
      fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(cache)));
    }
  }
  fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(cache)));
}

const getBytes = (cpu, id) => {
  const hit = cache.get(key(cpu, id)) ??
    [...cache].find(([k]) => k.toLowerCase() === key(cpu, id).toLowerCase())?.[1];
  return hit ? Buffer.from(hit, "hex") : null;
};

const cands = infos.filter((x) => x.nState === 0 && x.nIn >= 2 && x.nIn <= MAX_IN &&
  x.gates <= MAX_GATES && shapeIndex.has(`${x.nIn}:${x.nOut}`));
console.error(`${cands.length} candidates (incl. REF users)`);
await fetchNetlists(cands.filter((j) => !getBytes(j.cpu, j.id)));

// pull in referenced sub-circuits, repeatedly until closed
for (let round = 0; round < 4; round++) {
  const missing = new Map();
  for (const j of cands) {
    const b = getBytes(j.cpu, j.id);
    if (!b) continue;
    try {
      for (const e of decode(b, j.nIn)) {
        if (e.op !== 2) continue;
        if (!getBytes(e.cpu, Number(e.id))) missing.set(key(e.cpu, Number(e.id)), { cpu: e.cpu, id: Number(e.id) });
      }
    } catch {}
  }
  if (!missing.size) break;
  console.error(`round ${round}: fetching ${missing.size} referenced sub-circuits`);
  await fetchNetlists([...missing.values()]);
}

const results = [];
let refUsers = 0, unresolved = 0;
for (const j of cands) {
  const b = getBytes(j.cpu, j.id);
  if (!b) continue;
  try {
    const els = decode(b, j.nIn);
    const usesRef = els.some((e) => e.op === 2);
    const resolve = (cpu, id) => {
      const sb = getBytes(cpu, Number(id));
      if (!sb) throw new Error("unresolved");
      const si = infoOf.get(key(cpu, Number(id)).toLowerCase());
      if (!si) throw new Error("no info");
      return compile(sb, si.nIn, si.nOut, resolve);
    };
    const c = compile(b, j.nIn, j.nOut, resolve);
    if (usesRef) refUsers++;
    const what = classify(c);
    if (what) results.push({ ...j, what, nand: c.nNand, totalGates: c.totalGates, usesRef });
  } catch { unresolved++; }
}

fs.writeFileSync("data/classified2.json", JSON.stringify(results, null, 1));
const best = new Map();
for (const r of results) {
  const cur = best.get(r.what);
  if (!cur || r.totalGates < cur.totalGates) best.set(r.what, r);
}
console.log(`\nidentified ${results.length} circuits (${refUsers} of the candidates used REF, ${unresolved} unresolved)\n`);
console.log("function                     gates   project                                      id   REF");
for (const [name, r] of [...best].sort((a, b) => a[1].totalGates - b[1].totalGates))
  console.log(`${name.padEnd(26)} ${String(r.totalGates).padStart(6)}   ${r.cpu}  ${String(r.id).padStart(5)}   ${r.usesRef ? "yes" : ""}`);
