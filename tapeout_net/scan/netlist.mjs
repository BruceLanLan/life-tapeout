// TapeOut netlist format, decoder, encoder and simulator.
// Ported from the tapeout.net front end (assets/netlist-*.js and tapeoutChain-*.js).
//
// Signals: 0 = constant 0, 1 = constant 1, 2..2+nIn-1 = inputs, then every element
// appends its outputs in order. The circuit's outputs are the LAST nOut signals.
//   NAND  (0x00) a:u24 b:u24                     -> 1 signal
//   LATCH (0x01) d:u24                           -> 1 signal (value from the previous beat)
//   REF   (0x02) cpu:addr20 id:u64 nIns:u8 nOut:u8 ins:u24*nIns -> nOut signals
// NAND/REF inputs must refer to earlier signals; LATCH d may refer forward (feedback).

export const OP = { NAND: 0, LATCH: 1, REF: 2 };

export function decode(bytes, nIn) {
  let p = 0;
  const u8 = () => bytes[p++];
  const u24 = () => ((bytes[p++] << 16) | (bytes[p++] << 8) | bytes[p++]) >>> 0;
  const els = [];
  let next = 2 + nIn;
  while (p < bytes.length) {
    const op = u8();
    if (op === OP.NAND) {
      const a = u24(), b = u24();
      els.push({ op, a, b, out: next++ });
    } else if (op === OP.LATCH) {
      els.push({ op, d: u24(), out: next++ });
    } else if (op === OP.REF) {
      const cpu = "0x" + Buffer.from(bytes.slice(p, p + 20)).toString("hex");
      p += 20;
      let id = 0n;
      for (let i = 0; i < 8; i++) id = (id << 8n) | BigInt(bytes[p++]);
      const ni = u8(), no = u8();
      const ins = [];
      for (let i = 0; i < ni; i++) ins.push(u24());
      const outs = [];
      for (let i = 0; i < no; i++) outs.push(next++);
      els.push({ op, cpu, id, ins, nOut: no, outs });
    } else throw new Error(`bad opcode ${op} at ${p - 1}`);
  }
  return els;
}

export function encode(els) {
  const out = [];
  const u24 = (v) => out.push((v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  for (const e of els) {
    if (e.op === OP.NAND) { out.push(0); u24(e.a); u24(e.b); }
    else if (e.op === OP.LATCH) { out.push(1); u24(e.d); }
    else {
      out.push(2);
      for (let i = 2; i < 42; i += 2) out.push(parseInt(e.cpu.slice(i, i + 2), 16));
      for (let i = 7; i >= 0; i--) out.push(Number((BigInt(e.id) >> BigInt(i * 8)) & 0xffn));
      out.push(e.ins.length, e.nOut);
      e.ins.forEach(u24);
    }
  }
  return Uint8Array.from(out);
}

// resolve(cpu, id) -> compiled sub-circuit (needed only for netlists containing REF)
export function compile(bytes, nIn, nOut, resolve) {
  const els = decode(bytes, nIn);
  let nSignals = 2 + nIn, nState = 0, nNand = 0, nLatch = 0, totalGates = 0;
  for (const e of els) {
    if (e.op === OP.NAND) { nSignals++; nNand++; totalGates++; }
    else if (e.op === OP.LATCH) { e.st = nState++; nSignals++; nLatch++; totalGates++; }
    else {
      e.sub = resolve(e.cpu, e.id);
      e.st = nState;
      nState += e.sub.nState;
      nSignals += e.nOut;
      totalGates += e.sub.totalGates;
    }
  }
  return { nIn, nOut, els, nSignals, nState, nNand, nLatch, totalGates };
}

// One beat. state: Uint8Array(nState) of 0/1, inputs: array of 0/1.
export function step(c, state, inputs) {
  const a = new Uint8Array(c.nSignals);
  a[1] = 1;
  for (let i = 0; i < c.nIn; i++) a[2 + i] = inputs[i] ? 1 : 0;
  const ns = new Uint8Array(c.nState);
  let m = 2 + c.nIn;
  for (const e of c.els) {
    if (e.op === OP.NAND) a[m++] = a[e.a] & a[e.b] ? 0 : 1;
    else if (e.op === OP.LATCH) a[m++] = state[e.st];
    else {
      const r = step(e.sub, state.subarray(e.st, e.st + e.sub.nState), e.ins.map((i) => a[i]));
      ns.set(r.state, e.st);
      for (const v of r.outputs) a[m++] = v;
    }
  }
  for (const e of c.els) if (e.op === OP.LATCH) ns[e.st] = a[e.d];
  return { state: ns, outputs: Array.from(a.subarray(c.nSignals - c.nOut)) };
}

// little-endian bit packing used by the contract's eval/step
export const packBits = (bits) => {
  const b = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((v, i) => { if (v) b[i >> 3] |= 1 << (i & 7); });
  return b;
};
export const unpackBits = (bytes, n) => Array.from({ length: n }, (_, i) => (bytes[i >> 3] >> (i & 7)) & 1);
