// Find on-chain circuits that use REF, then check our simulator against eval() on one.
import fs from "node:fs";
import { batchCall, callData, decodeBytes, SEL } from "./rpc.mjs";
import { decode } from "./netlist.mjs";

const infos = JSON.parse(fs.readFileSync("data/infos.json"));
const pool = infos.filter((x) => x.nState === 0 && x.nIn >= 2 && x.nIn <= 12 && x.gates >= 10 && x.gates <= 5000);
console.error(`probing ${Math.min(pool.length, 600)} circuits for REF usage`);

const found = [];
for (let i = 0; i < Math.min(pool.length, 600) && found.length < 10; i += 40) {
  const chunk = pool.slice(i, i + 40);
  const res = await batchCall(chunk.map((j) => ({ to: j.cpu, data: callData(SEL.netlist, j.id) })));
  chunk.forEach((j, k) => {
    if (!res[k]) return;
    try {
      const b = decodeBytes(res[k]);
      const refs = decode(b, j.nIn).filter((e) => e.op === 2);
      if (refs.length) found.push({ ...j, refs: refs.length, first: `${refs[0].cpu} #${refs[0].id}` });
    } catch {}
  });
}
for (const f of found) console.log(`${f.cpu} #${f.id}  nIn=${f.nIn} nOut=${f.nOut} gates=${f.gates}  REFs=${f.refs}  -> ${f.first}`);
if (!found.length) console.log("no REF circuits in this sample");
