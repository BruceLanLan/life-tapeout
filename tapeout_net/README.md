# Life on tapeout.net（NAND + LATCH）

[tapeout.net](https://tapeout.net) 是一个链上电路协议：画布上只有 5 种原语 —— 输入引脚、输出引脚、常量 0/1、与非门 NAND、LATCH（1 位状态，每次心跳更新）。每个 NAND/LATCH 消耗一个“晶体管” token；“流片”时 token 被销毁、铸出一个电路 NFT。已做好的电路可以当黑盒复用。

## 估算：用纯 NAND + LATCH 搭 Life 需要多少晶体管

[life_core.v](life_core.v)：N×N 环面，每次心跳前进一代；`load=1` 时改为装入 `seed`。无 VGA（画布没有显示器原语，输出就是 N² 个引脚）。

```sh
yosys -p "read_verilog tapeout_net/life_core.v; chparam -set N 8 life_core; synth -top life_core -flatten; abc -g NAND; opt_clean; stat"
```

NOT 按一个输入短接的 NAND 计。

| 网格 | NAND | LATCH | 合计晶体管 | 每细胞 NAND |
|---|---|---|---|---|
| 4×4 | 854 | 16 | 870 | 53.4 |
| 8×8 | 3,515 | 64 | 3,579 | 54.9 |
| 16×16 | 14,208 | 256 | 14,464 | 55.5 |
| 32×32 | 57,096 | 1,024 | 58,120 | 55.8 |

规律：每个细胞约 **55 个 NAND + 1 个 LATCH**。适合先做一个“细胞”子电路（8 个邻居输入 + load/seed → 1 个状态输出），再当黑盒平铺。

一个 OTCA metapixel（2048² ≈ 420 万细胞）需要约 2.35 亿个 NAND —— oimo 那种无限递归在这里同样不现实。

## 未验证的点

- LATCH 的精确语义（是否带使能、初值）、复用黑盒是否再次消耗 token、链上每次心跳的 gas 成本 —— 均未确认。
- 网表字节格式未逆向；要自动生成可导入画布的网表，需要先弄清它。
