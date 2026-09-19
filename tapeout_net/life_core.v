// Pure Life core for NAND+LATCH targets: no VGA, grid advances every tick.
// load=1 copies the input row-parallel seed into the grid instead.
module life_core #(parameter N = 8) (
  input  wire          clk,
  input  wire          load,
  input  wire [N*N-1:0] seed,
  output reg  [N*N-1:0] cells
);
  wire [N*N-1:0] next;
  genvar r, c;
  generate for (r = 0; r < N; r = r + 1) begin : row
    for (c = 0; c < N; c = c + 1) begin : col
      localparam RU = (r+N-1)%N, RD = (r+1)%N, CL = (c+N-1)%N, CR = (c+1)%N;
      wire [3:0] sum = cells[RU*N+CL] + cells[RU*N+c] + cells[RU*N+CR]
                     + cells[r*N+CL] + cells[r*N+CR]
                     + cells[RD*N+CL] + cells[RD*N+c] + cells[RD*N+CR];
      assign next[r*N+c] = (sum == 4'd3) | (cells[r*N+c] & (sum == 4'd2));
    end
  end endgenerate
  always @(posedge clk) cells <= load ? seed : next;
endmodule
