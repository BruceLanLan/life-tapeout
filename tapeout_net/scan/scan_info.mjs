// Fetch circuitInfo for every circuit of every project -> data/infos.json
import fs from "node:fs";
import { batchCall, callData, decodeWords, SEL } from "./rpc.mjs";

fs.mkdirSync("data", { recursive: true });
const procs = await (await fetch("https://tapeout.net/processors.json")).json();
fs.writeFileSync("data/processors.json", JSON.stringify(procs));

const jobs = [];
for (const p of procs.cpus)
  for (let id = 1; id <= p.circuitCount; id++) jobs.push({ cpu: p.address, id });
console.error(`${procs.cpus.length} projects, ${jobs.length} circuits`);

// resumable: skip circuits already fetched
const infos = fs.existsSync("data/infos.json") ? JSON.parse(fs.readFileSync("data/infos.json")) : [];
const have = new Set(infos.map((x) => x.cpu + ":" + x.id));
const todo = jobs.filter((j) => !have.has(j.cpu + ":" + j.id));
jobs.length = 0;
jobs.push(...todo);
const BATCH = 50, CONC = 3;
let next = 0, done = 0;
async function worker() {
  while (next < jobs.length) {
    const chunk = jobs.slice(next, next + BATCH);
    next += BATCH;
    const res = await batchCall(chunk.map((j) => ({ to: j.cpu, data: callData(SEL.circuitInfo, j.id) })));
    chunk.forEach((j, i) => {
      if (!res[i] || res[i].length < 2 + 64 * 4) return;
      const [nIn, nOut, nState, gates] = decodeWords(res[i]).map(Number);
      infos.push({ cpu: j.cpu, id: j.id, nIn, nOut, nState, gates });
    });
    done += chunk.length;
    if (done % 2000 < BATCH) {
      console.error(`${done}/${jobs.length}`);
      fs.writeFileSync("data/infos.json", JSON.stringify(infos));
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
fs.writeFileSync("data/infos.json", JSON.stringify(infos));
console.error(`saved ${infos.length} infos`);
