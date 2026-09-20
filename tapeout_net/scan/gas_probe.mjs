// Where do beat()/evaluate() live, and what do they actually cost?
// Read-only: eth_getCode + eth_estimateGas from the zero address.
import fs from "node:fs";
import { RPCS } from "./rpc.mjs";

const SEL = { beat: "1fc0021d", evaluate: "136ade26", maxRunGas: "4ca6bde2", eval: "934d06ea" };
const MINING = "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46";
const CIRCUITS = "0xFAc299310ca53DB70De49F5e11D3B14A41B1Ef75";   // Standard Cell Library
const BLONSKR = "0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C";

async function rpc(method, params) {
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = await r.json();
      if (j.error) return { error: j.error.message };
      return { result: j.result };
    } catch {}
  }
  return { error: "all rpcs failed" };
}

const pad = (n) => BigInt(n).toString(16).padStart(64, "0");
const bytesArg = (hexBody, byteLen, offsetWords) =>
  pad(offsetWords * 32) + pad(byteLen) + hexBody.padEnd(Math.ceil(byteLen / 32) * 64, "0");

for (const [name, addr] of [["mining", MINING], ["circuits(project)", CIRCUITS]]) {
  const { result: code } = await rpc("eth_getCode", [addr, "latest"]);
  const has = Object.entries(SEL).filter(([, s]) => code && code.includes(s)).map(([k]) => k);
  console.log(`${name.padEnd(18)} ${addr}  code ${code ? (code.length - 2) / 2 : 0} B  selectors present: ${has.join(", ") || "none"}`);
}

const { result: mrg } = await rpc("eth_call", [{ to: MINING, data: "0x" + SEL.maxRunGas }, "latest"]);
console.log(`mining.maxRunGas() = ${mrg && mrg.length > 2 ? Number(BigInt(mrg)).toLocaleString() : mrg}`);

// estimateGas for evaluate(cpu, id, inputs) on circuits of different sizes
const infos = JSON.parse(fs.readFileSync("data/infos.json"));
const pick = (cpu, want) => infos.filter((x) => x.cpu === cpu && x.nState === 0 && x.nIn <= 16)
  .sort((a, b) => Math.abs(a.gates - want) - Math.abs(b.gates - want))[0];

for (const target of [65, 1204, 3552]) {
  for (const cpu of [BLONSKR, CIRCUITS]) {
    const c = pick(cpu, target);
    if (!c || Math.abs(c.gates - target) > target) continue;
    const inBytes = "00".repeat(Math.ceil(c.nIn / 8));
    for (const [where, to, data] of [
      ["mining.evaluate", MINING, "0x" + SEL.evaluate + pad(BigInt(cpu)) + pad(c.id) + bytesArg(inBytes, inBytes.length / 2, 3)],
      ["mining.beat", MINING, "0x" + SEL.beat + pad(BigInt(cpu)) + pad(c.id) + bytesArg(inBytes, inBytes.length / 2, 3)],
      ["project.eval", cpu, "0x" + SEL.eval + pad(c.id) + bytesArg(inBytes, inBytes.length / 2, 2)],
    ]) {
      const r = await rpc("eth_estimateGas", [{ from: "0x0000000000000000000000000000000000000000", to, data }]);
      const g = r.result ? Number(BigInt(r.result)) : null;
      console.log(`${where.padEnd(16)} circuit #${String(c.id).padEnd(5)} gates=${String(c.gates).padEnd(6)} -> ${g ? g.toLocaleString() + " gas" : (r.error || "").slice(0, 90)}`);
    }
  }
}

// how big can a read-only eval() get before the node's gas cap bites?
for (const want of [6000, 14000, 30000]) {
  const c = infos.filter((x) => x.nState === 0 && x.nIn <= 16 && x.gates > 0)
    .sort((a, b) => Math.abs(a.gates - want) - Math.abs(b.gates - want))[0];
  const inBytes = "00".repeat(Math.ceil(c.nIn / 8));
  const data = "0x" + SEL.eval + pad(c.id) + bytesArg(inBytes, inBytes.length / 2, 2);
  const est = await rpc("eth_estimateGas", [{ from: "0x0000000000000000000000000000000000000000", to: c.cpu, data }]);
  const call = await rpc("eth_call", [{ to: c.cpu, data }, "latest"]);
  console.log(`gates=${String(c.gates).padEnd(7)} estimateGas ${est.result ? Number(BigInt(est.result)).toLocaleString() : (est.error || "").slice(0, 60)}` +
    `   eth_call ${call.result ? "OK" : (call.error || "").slice(0, 60)}`);
}
