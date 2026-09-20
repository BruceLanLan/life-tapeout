// Minimal read-only JSON-RPC helpers for TapeOut circuit contracts on BSC.
export const RPCS = (process.env.RPC ? [process.env.RPC] : [
  "https://bsc-rpc.publicnode.com",
  "https://bsc-dataseed.bnbchain.org",
  "https://bsc-dataseed2.bnbchain.org",
  "https://1rpc.io/bnb",
  "https://bsc-mainnet.public.blastapi.io",
  "https://bsc.meowrpc.com",
]);
let rr = 0;

export const SEL = {
  nextId: "61b8ce8c",
  circuitInfo: "084d60f1", // circuitInfo(uint256) -> (nIn, nOut, nState, gateCount)
  netlist: "3fc4be56",     // netlist(uint256) -> bytes
};

const u256 = (n) => BigInt(n).toString(16).padStart(64, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function callData(sel, ...args) {
  return "0x" + sel + args.map(u256).join("");
}

// calls: [{to, data}] -> array of hex results (null on revert)
export async function batchCall(calls, tries = 10) {
  const body = calls.map((c, i) => ({
    jsonrpc: "2.0", id: i, method: "eth_call", params: [{ to: c.to, data: c.data }, "latest"],
  }));
  for (let t = 0; t < tries; t++) {
    const RPC = RPCS[rr++ % RPCS.length];  // spread load across public endpoints
    try {
      const res = await fetch(RPC, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!Array.isArray(json)) throw new Error(JSON.stringify(json).slice(0, 200));
      const out = new Array(calls.length).fill(null);
      let rateLimited = false;
      for (const r of json) {
        if (r.error && /limit|rate|too many/i.test(r.error.message)) rateLimited = true;
        out[r.id] = r.result ?? null;
      }
      if (rateLimited) throw new Error("rate limited");
      return out;
    } catch (e) {
      await sleep(500 * Math.min(2 ** t, 16));
      if (t === tries - 1) throw e;
    }
  }
}

export function decodeWords(hex) {
  const h = hex.slice(2);
  const w = [];
  for (let i = 0; i < h.length; i += 64) w.push(BigInt("0x" + h.slice(i, i + 64)));
  return w;
}

export function decodeBytes(hex) {
  const h = hex.slice(2);
  const off = Number(BigInt("0x" + h.slice(0, 64))) * 2;
  const len = Number(BigInt("0x" + h.slice(off, off + 64)));
  return Buffer.from(h.slice(off + 64, off + 64 + len * 2), "hex");
}
