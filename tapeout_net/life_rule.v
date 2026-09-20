// Combinational Life rule for one cell, for use as a REF sub-circuit.
// in[7:0] neighbours, in[8] self, in[9] load, in[10] seed -> next state
module life_rule (input wire [10:0] in, output wire out);
  wire [3:0] s = in[0] + in[1] + in[2] + in[3] + in[4] + in[5] + in[6] + in[7];
  wire life = (s == 4'd3) | (in[8] & (s == 4'd2));
  assign out = in[9] ? in[10] : life;
endmodule
module life_rule9 (input wire [8:0] in, output wire out);
  wire [3:0] s = in[0] + in[1] + in[2] + in[3] + in[4] + in[5] + in[6] + in[7];
  assign out = (s == 4'd3) | (in[8] & (s == 4'd2));
endmodule
