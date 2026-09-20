// Run the Life grid netlist in the local TapeOut simulator and print the board.
// node demo.mjs [N] [beats]
import { pathToFileURL } from "node:url";
import { encode, compile, step } from "./netlist.mjs";
import { buildRule, buildGrid } from "./build_life.mjs";

const N = Number(process.argv[2] || 8);
const BEATS = Number(process.argv[3] || 24);

const ruleC = compile(encode(buildRule().els), 10, 1);
const grid = buildGrid(N, "0x0000000000000000000000000000000000000001", 1);
const gc = compile(encode(grid.els), N * N, N * N, () => ruleC);

const seed = new Array(N * N).fill(0);
for (const [r, c] of [[0, 1], [1, 2], [2, 0], [2, 1], [2, 2]]) seed[r * N + c] = 1; // glider

let state = new Uint8Array(gc.nState);
let inputs = seed;
for (let t = 0; t <= BEATS; t++) {
  const r = step(gc, state, inputs);
  state = r.state;
  inputs = new Array(N * N).fill(0);
  const rows = [];
  for (let y = 0; y < N; y++)
    rows.push(r.outputs.slice(y * N, y * N + N).map((v) => (v ? "██" : "··")).join(""));
  console.log(`beat ${t}  (alive ${r.outputs.reduce((a, b) => a + b, 0)})`);
  console.log(rows.join("\n") + "\n");
}
