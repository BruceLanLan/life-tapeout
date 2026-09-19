#!/bin/sh
# Download the sky130_fd_sc_hd typical-corner liberty file used by the synth scripts.
cd "$(dirname "$0")" && curl -L -o sky130_hd_tt.lib \
  https://raw.githubusercontent.com/The-OpenROAD-Project/OpenROAD-flow-scripts/master/flow/platforms/sky130hd/lib/sky130_fd_sc_hd__tt_025C_1v80.lib
