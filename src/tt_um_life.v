/*
 * tt_um_life — Conway's Game of Life on an N x N torus, VGA 640x480 output.
 * Tiny Tapeout pinout.
 *
 *   ui_in[0]   run        1 = advance generations automatically
 *   ui_in[1]   step       rising edge = advance exactly one generation
 *   ui_in[2]   load       rising edge = load preset selected by ui_in[4:3]
 *   ui_in[4:3] preset     0 glider, 1 R-pentomino, 2 LWSS, 3 random (xorshift)
 *   ui_in[7:5] speed      one generation every 2^speed frames (0 = 60 gen/s)
 *
 *   uo_out     TinyVGA PMOD: {hsync, B0, G0, R0, vsync, B1, G1, R1}
 *   uio_out    generation counter [7:0] (all outputs)
 *
 * clk must be ~25.175 MHz (25 MHz works on most monitors).
 * The grid is updated only at the start of vblank, so there is no tearing.
 */
`default_nettype none

module tt_um_life #(
    parameter N   = 16,  // grid is N x N (power of two, >= 8), wraps around (torus)
    parameter CSH = 4    // each cell is 2^CSH pixels wide on screen
) (
    input  wire [7:0] ui_in,
    output wire [7:0] uo_out,
    input  wire [7:0] uio_in,
    output wire [7:0] uio_out,
    output wire [7:0] uio_oe,
    input  wire       ena,
    input  wire       clk,
    input  wire       rst_n
);
  localparam NN = N * N;

  // ---------------------------------------------------------------- inputs
  reg [7:0] ui_s1, ui_s2, ui_s3;  // 2-FF synchronizer + edge-detect stage
  always @(posedge clk) begin
    ui_s1 <= ui_in;
    ui_s2 <= ui_s1;
    ui_s3 <= ui_s2;
  end
  wire       run       = ui_s2[0];
  wire       step_rise = ui_s2[1] & ~ui_s3[1];
  wire       load_rise = ui_s2[2] & ~ui_s3[2];
  wire [1:0] preset    = ui_s2[4:3];
  wire [2:0] speed     = ui_s2[7:5];

  // ------------------------------------------------------------ VGA timing
  // 640x480@60: h 640+16+96+48 = 800, v 480+10+2+33 = 525, both syncs active low
  reg [9:0] hpos, vpos;
  wire h_end = (hpos == 10'd799);
  wire v_end = (vpos == 10'd524);
  always @(posedge clk) begin
    if (!rst_n) begin
      hpos <= 0;
      vpos <= 0;
    end else begin
      hpos <= h_end ? 10'd0 : hpos + 10'd1;
      if (h_end) vpos <= v_end ? 10'd0 : vpos + 10'd1;
    end
  end
  wire hsync   = ~(hpos >= 10'd656 && hpos < 10'd752);
  wire vsync   = ~(vpos >= 10'd490 && vpos < 10'd492);
  wire visible = (hpos < 10'd640) && (vpos < 10'd480);
  wire frame_tick = (hpos == 10'd0) && (vpos == 10'd480);  // first line of vblank

  // --------------------------------------------------------- the cell grid
  // cells[r*N + c] is the cell at row r, column c
  reg  [NN-1:0] cells;
  wire [NN-1:0] next;

  genvar r, c;
  generate
    for (r = 0; r < N; r = r + 1) begin : row
      for (c = 0; c < N; c = c + 1) begin : col
        localparam RU = (r + N - 1) % N, RD = (r + 1) % N;
        localparam CL = (c + N - 1) % N, CR = (c + 1) % N;
        wire [3:0] sum = cells[RU*N+CL] + cells[RU*N+c] + cells[RU*N+CR]
                       + cells[r*N+CL]                  + cells[r*N+CR]
                       + cells[RD*N+CL] + cells[RD*N+c] + cells[RD*N+CR];
        // B3/S23
        assign next[r*N+c] = (sum == 4'd3) | (cells[r*N+c] & (sum == 4'd2));
      end
    end
  endgenerate

  // --------------------------------------------------------------- presets
  function [NN-1:0] put(input [NN-1:0] g, input integer rr, input integer cc);
    begin
      put = g;
      put[rr * N + cc] = 1'b1;
    end
  endfunction

  localparam M = N / 2;
  function [NN-1:0] pattern(input [1:0] sel);
    reg [NN-1:0] g;
    begin
      g = {NN{1'b0}};
      case (sel)
        2'd0: begin  // glider
          g = put(g, 1, 2); g = put(g, 2, 3);
          g = put(g, 3, 1); g = put(g, 3, 2); g = put(g, 3, 3);
        end
        2'd1: begin  // R-pentomino
          g = put(g, M-1, M); g = put(g, M-1, M+1);
          g = put(g, M, M-1); g = put(g, M, M);
          g = put(g, M+1, M);
        end
        default: begin  // LWSS
          g = put(g, M-1, 1); g = put(g, M-1, 4);
          g = put(g, M, 5);
          g = put(g, M+1, 1); g = put(g, M+1, 5);
          g = put(g, M+2, 2); g = put(g, M+2, 3); g = put(g, M+2, 4); g = put(g, M+2, 5);
        end
      endcase
      pattern = g;
    end
  endfunction

  // xorshift32 for the random preset; free-runs so each press differs
  reg  [31:0] rng;
  wire [31:0] x1 = rng ^ (rng << 13);
  wire [31:0] x2 = x1 ^ (x1 >> 17);
  wire [31:0] rng_next = x2 ^ (x2 << 5);

  // random fill shifts one fresh row in per clock for N clocks
  reg [$clog2(N+1)-1:0] fill_cnt;
  wire filling = (fill_cnt != 0);

  // ------------------------------------------------------------ generation
  reg [7:0] frame_div;
  reg [7:0] gen;
  reg       step_pending;
  wire      auto_step = run && frame_tick && ((frame_div & ((8'd1 << speed) - 8'd1)) == 8'd0);

  always @(posedge clk) begin
    if (!rst_n) begin
      cells        <= pattern(2'd0);
      rng          <= 32'h2545F491;
      fill_cnt     <= 0;
      frame_div    <= 0;
      gen          <= 0;
      step_pending <= 0;
    end else begin
      rng <= rng_next;
      if (frame_tick) frame_div <= frame_div + 8'd1;
      if (step_rise) step_pending <= 1'b1;

      if (load_rise) begin
        gen <= 0;
        if (preset == 2'd3) begin
          cells    <= {NN{1'b0}};
          fill_cnt <= N;
        end else begin
          cells <= pattern(preset);
        end
      end else if (filling) begin
        cells    <= {cells[NN-N-1:0], rng[N-1:0]};
        fill_cnt <= fill_cnt - 1'b1;
      end else if (auto_step || (step_pending && frame_tick)) begin
        cells        <= next;
        gen          <= gen + 8'd1;
        step_pending <= 1'b0;
      end
    end
  end

  // ---------------------------------------------------------------- pixels
  localparam W  = N << CSH;
  localparam X0 = (640 - W) / 2;
  localparam Y0 = (480 - W) / 2;
  wire [9:0] gx = hpos - X0[9:0];
  wire [9:0] gy = vpos - Y0[9:0];
  wire in_grid  = visible && (hpos >= X0) && (hpos < X0 + W) && (vpos >= Y0) && (vpos < Y0 + W);
  localparam LN = $clog2(N);
  wire [9:0] gxs = gx >> CSH;
  wire [9:0] gys = gy >> CSH;
  wire [LN-1:0] cx = gxs[LN-1:0];  // only meaningful inside the grid
  wire [LN-1:0] cy = gys[LN-1:0];
  wire on_line  = (gx[CSH-1:0] == 0) || (gy[CSH-1:0] == 0);
  wire alive    = cells[{cy, cx}];  // N is a power of two

  // colour drifts across the grid, a tiny nod to oimo's hue field
  wire [1:0] cr = {1'b1, cx[LN-1]};
  wire [1:0] cg = {cy[LN-1], cx[LN-2]};
  wire [1:0] cb = {~cx[LN-1], 1'b1};

  reg [1:0] R, G, B;
  always @(*) begin
    if (!in_grid)      {R, G, B} = 6'b00_00_00;
    else if (alive)    {R, G, B} = {cr, cg, cb};
    else if (on_line)  {R, G, B} = 6'b01_01_01;
    else               {R, G, B} = 6'b00_00_00;
  end

  assign uo_out  = {hsync, B[0], G[0], R[0], vsync, B[1], G[1], R[1]};
  assign uio_out = gen;
  assign uio_oe  = 8'hff;

  wire _unused = &{ena, uio_in, 1'b0};

endmodule
