// Cross-check the local netlist simulator against the contract's own eval().
// Read-only: eth_call only, no wallet, no transaction.
import { batchCall, callData, decodeBytes, SEL } from "./rpc.mjs";
import { compile, step, packBits, unpackBits } from "./netlist.mjs";

const SELECTORS = { eval: "934d06ea" };
const hex = (b) => Buffer.from(b).toString("hex");

function evalCallData(id, inBytes) {
  const idHex = BigInt(id).toString(16).padStart(64, "0");
  const off = (64).toString(16).padStart(64, "0");
  const len = inBytes.length.toString(16).padStart(64, "0");
  const body = hex(inBytes).padEnd(Math.ceil(inBytes.length / 32) * 64, "0") || "";
  return "0x" + SELECTORS.eval + idHex + off + len + body;
}

const cache = new Map();
async function fetchNetlist(cpu, id) {
  const key = `${cpu.toLowerCase()}:${id}`;
  if (cache.has(key)) return cache.get(key);
  const [nl, info] = await batchCall([
    { to: cpu, data: callData(SEL.netlist, id) },
    { to: cpu, data: callData(SEL.circuitInfo, id) },
  ]);
  const words = info.slice(2).match(/.{64}/g).map((w) => Number(BigInt("0x" + w)));
  const out = { bytes: decodeBytes(nl), nIn: words[0], nOut: words[1], nState: words[2], gates: words[3] };
  cache.set(key, out);
  return out;
}

export async function loadCircuit(cpu, id) {
  const { bytes, nIn, nOut } = await fetchNetlist(cpu, id);
  const subs = new Map();
  // REFs are resolved by pre-loading them (compile() needs a synchronous resolver)
  const scan = async (b, nIn) => {
    const { decode } = await import("./netlist.mjs");
    for (const e of decode(b, nIn)) {
      if (e.op !== 2) continue;
      const k = `${e.cpu.toLowerCase()}:${e.id}`;
      if (subs.has(k)) continue;
      const s = await fetchNetlist(e.cpu, Number(e.id));
      subs.set(k, s);
      await scan(s.bytes, s.nIn);
    }
  };
  await scan(bytes, nIn);
  const resolve = (cpu2, id2) => {
    const s = subs.get(`${cpu2.toLowerCase()}:${id2}`);
    return compile(s.bytes, s.nIn, s.nOut, resolve);
  };
  return compile(bytes, nIn, nOut, resolve);
}

if (process.argv[2]) {
  const [cpu, id, n = "8"] = process.argv.slice(2);
  const c = await loadCircuit(cpu, Number(id));
  console.log(`circuit ${id}: nIn=${c.nIn} nOut=${c.nOut} nState=${c.nState} gates=${c.totalGates}`);
  if (c.nState !== 0) { console.log("has state, eval() not applicable"); process.exit(0); }
  const vectors = Array.from({ length: Number(n) }, () =>
    Array.from({ length: c.nIn }, () => (Math.random() < 0.5 ? 0 : 1)));
  const res = await batchCall(vectors.map((v) => ({ to: cpu, data: evalCallData(id, packBits(v)) })));
  let ok = 0;
  vectors.forEach((v, i) => {
    const chain = unpackBits(decodeBytes(res[i]), c.nOut).join("");
    const local = step(c, new Uint8Array(0), v).outputs.join("");
    if (chain === local) ok++;
    else console.log(`MISMATCH\n  in    ${v.join("")}\n  chain ${chain}\n  local ${local}`);
  });
  console.log(`${ok}/${vectors.length} vectors match the on-chain eval()`);
}
