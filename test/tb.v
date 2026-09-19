// Testbench: behaves like a monitor. It locks onto hsync/vsync from uo_out,
// captures every 2nd pixel of every 2nd line (320x240) into frames.bin, and
// dumps the cell grid after each generation into cells.txt for the golden check.
`timescale 1ns / 1ps
`default_nettype none

module tb;
  parameter N = 16;
  parameter CSH = 4;

  reg        clk = 0;
  reg        rst_n = 0;
  reg  [7:0] ui_in = 8'b000_00_001;  // run, speed 0
  wire [7:0] uo_out, uio_out, uio_oe;

  tt_um_life #(.N(N), .CSH(CSH)) dut (
      .ui_in(ui_in), .uo_out(uo_out), .uio_in(8'h00), .uio_out(uio_out),
      .uio_oe(uio_oe), .ena(1'b1), .clk(clk), .rst_n(rst_n));

  always #20 clk = ~clk;  // 25 MHz

  wire hsync = uo_out[7];
  wire vsync = uo_out[3];
  wire [1:0] R = {uo_out[0], uo_out[4]};
  wire [1:0] G = {uo_out[1], uo_out[5]};
  wire [1:0] B = {uo_out[2], uo_out[6]};

  // ---- monitor: recover pixel coordinates from the sync pulses only
  reg hs_d = 1, vs_d = 1;
  integer hcnt = 0, line = 0, frames = 0, fd, cd, errors = 0;
  integer x, y, nframes;
  always @(posedge clk) begin
    hs_d <= hsync;
    vs_d <= vsync;
    hcnt <= (hs_d && !hsync) ? 1 : hcnt + 1;
    if (hs_d && !hsync) line <= line + 1;
    if (vs_d && !vsync) begin
      line   <= 0;
      frames <= frames + 1;
    end
  end
  // hsync falls at hpos 656 -> hpos 0 is 144 clocks later; vsync falls at line 490 -> line 0 is 35 lines later
  always @(*) begin
    x = hcnt - 144;
    y = line - 35;
  end

  always @(posedge clk) begin
    if (frames >= 1 && x >= 0 && x < 640 && y >= 0 && y < 480) begin
      if (x != dut.hpos || y != dut.vpos) begin
        if (errors < 5) $display("SYNC MISMATCH x=%0d hpos=%0d y=%0d vpos=%0d", x, dut.hpos, y, dut.vpos);
        errors = errors + 1;
      end
      if (x[0] == 0 && y[0] == 0) $fwrite(fd, "%c", {2'b01, R, G, B});
    end
  end

  // ---- dump grid once per generation (one clock after the update)
  reg [7:0] last_gen = 8'hff;
  integer i;
  always @(posedge clk) begin
    if (rst_n && uio_out != last_gen) begin
      last_gen <= uio_out;
      #1;
      $fwrite(cd, "%0d ", uio_out);
      for (i = 0; i < N * N; i = i + 1) $fwrite(cd, "%0d", dut.cells[i]);
      $fwrite(cd, "\n");
    end
  end

  task press(input integer bit_idx);
    begin
      ui_in[bit_idx] = 1;
      repeat (4) @(posedge clk);
      ui_in[bit_idx] = 0;
      repeat (4) @(posedge clk);
    end
  endtask

  task load(input [1:0] p);
    begin
      ui_in[4:3] = p;
      press(2);
      $fwrite(cd, "LOAD %0d\n", p);
    end
  endtask

  task wait_frames(input integer n);
    integer f0;
    begin
      f0 = frames;
      wait (frames == f0 + n);
    end
  endtask

  initial begin
    fd = $fopen("frames.bin", "wb");
    cd = $fopen("cells.txt", "w");
    repeat (10) @(posedge clk);
    rst_n = 1;

    if ($test$plusargs("short")) begin
      wait_frames(10);
      load(3); wait_frames(10);
    end else begin
      wait_frames(64);   // glider, 60 gen/s
      load(2); wait_frames(40);  // LWSS
      load(1); wait_frames(80);  // R-pentomino
      load(3); wait_frames(80);  // random soup
    end

    // speed=3 -> one generation every 8 frames
    begin : speedcheck
      reg [7:0] g0;
      ui_in[7:5] = 3'd3;
      wait_frames(2);
      g0 = uio_out;
      wait_frames(16);
      if (uio_out != g0 + 8'd2) begin
        $display("SPEED FAIL: 16 frames at speed 3 gave %0d generations", uio_out - g0);
        errors = errors + 1;
      end
      ui_in[7:5] = 3'd0;
    end

    // single-step check: pause, press step twice -> exactly two generations
    ui_in[0] = 0;
    wait_frames(2);
    begin : stepcheck
      reg [7:0] g0;
      g0 = uio_out;
      press(1); wait_frames(2);
      press(1); wait_frames(2);
      if (uio_out != g0 + 8'd2) begin
        $display("STEP FAIL: gen %0d -> %0d", g0, uio_out);
        errors = errors + 1;
      end
    end

    $display("frames=%0d errors=%0d", frames, errors);
    $fclose(fd);
    $fclose(cd);
    $finish;
  end
endmodule
