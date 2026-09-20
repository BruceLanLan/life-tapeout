# Life on tapeout.net

[tapeout.net](https://tapeout.net)（TapeOut Protocol，BSC 链上）把电路做成 NFT：画布上只有 5 种原语 —— 输入引脚、输出引脚、常量 0/1、**NAND**、**LATCH**（1 位状态，每拍更新）。每个 NAND/LATCH 消耗一个"晶体管" token，"流片"时 token 被销毁、铸出电路 NFT。

本目录是对这个协议的逆向记录，以及在它上面实现 Conway's Game of Life 的完整设计。**全部为只读分析：没有连接钱包，没有发送任何交易，没有花费任何资金。**

## 1. 协议逆向

### 网表格式（逆向自前端 `assets/netlist-*.js`）

信号编号：`0` = 常量 0，`1` = 常量 1，`2 .. 2+nIn-1` = 输入引脚，之后每个元件按顺序追加自己的输出信号。**电路的输出 = 最后 nOut 个信号。**

| 操作码 | 编码 | 产生信号 |
|---|---|---|
| `NAND` 0x00 | `a:u24 b:u24` | 1 |
| `LATCH` 0x01 | `d:u24` | 1（值为上一拍的 d） |
| `REF` 0x02 | `cpu:address20 circuitId:u64 nIns:u8 nOut:u8 ins:u24[]` | nOut |

- NAND 和 REF 的输入只能引用**更早**的信号；**LATCH 的 d 可以引用后面的信号**，时序反馈就靠这一条。
- `REF` 可以引用**任何项目的任何已流片电路**，跨项目复用，这是成本优化的关键。

### 合约接口（BSC 主网，只读部分）

| 函数 | 用途 |
|---|---|
| `circuitInfo(id) -> (nIn, nOut, nState, gateCount)` | 电路元信息 |
| `netlist(id) -> bytes` | 取网表 |
| `eval(id, bytes) view -> bytes` | 跑组合逻辑，免费 |
| `step(id, state, inputs) view -> (newState, outputs)` | 跑一拍时序逻辑，免费，状态由调用者给 |
| `beat(cpu, id, inputs) -> outputs` | 上链跑一拍，状态存在链上（`heartOf(who,cpu,id)`），要花 gas |
| `tapeout(netlist, nIn, nOut) payable -> id` | 流片，销毁 token |

输入输出按**小端位序**打包成 bytes。

### 计费规则

- 流片销毁的是**本层**的 NAND/LATCH 数量，**REF 引用的子电路不再收费**（项目页的"电路累计门数（含复用）"只是统计）。
- 画布编译器会给每个输出脚插入 2 个 NAND 的缓冲（前端里的 `burnNand = nand + nOut*2`）。**直接生成网表可以省掉这部分**。
- 全网 931 个项目里有 393 个 mintPrice 为 0，其中部分仍有剩余供应量。协议费为每次 mint 0.0001 BNB、流片 0.0002 BNB，外加 gas。
- 画布支持导入 **BLIF**，所以 Yosys 综合的结果可以直接拖进去。

## 2. 链上现有电路普查

`scan_info.mjs` 扫了全部 931 个项目共 **27,671 个电路**（累计 967 万门）。`classify.mjs` 把其中的小型组合电路下载下来，在本地跑真值表，和参考函数逐一比对，识别出它们到底算什么。

结果见 [scan/data/classified.json](scan/data/classified.json)，各功能的**最小已知实现**：

| 功能 | 最小门数 | 项目 / 电路号 |
|---|---|---|
| NAND | 1 | Genesis CPU #4255 |
| AND | 2 | Blonskr_No1 #47 |
| OR | 3 | Blonskr_No1 #48 |
| NOR | 4 | Blonskr_No1 #49 |
| XOR | 4 | Blonskr_No1 #50 |
| MUX2 | 4 | Genesis CPU #4263 |
| XNOR | 5 | Genesis CPU #4259 |
| 半加器 | 5 | Genesis CPU #4265 |
| 全加器 | 9 | Blonskr_No1 #145 |
| 4+4 位加法 | 32 | TapeOut #2118 |
| 4+4+cin 位加法 | 36 | Genesis CPU #4269 |
| 8 位 popcount | 58 | Blonskr_No1 #2194 |

对 Life 有用的是全加器（9 门，和手工最优一致）和 8 位 popcount。但现成的 popcount 是 58 门，比我们整条规则（56 门）还贵 —— **直接手工做规则电路更划算**，因为 Life 只需要判断"邻居数是否为 2 或 3"，不需要完整的计数结果。

链上没有找到现成的 Life 规则电路。

## 3. 我们的设计

### 规则电路：56 个 NAND

[scan/build_life.mjs](scan/build_life.mjs) `buildRule()`，10 输入（8 邻居 + 自身 + seed）→ 1 输出：

- 用 3 个全加器 + 1 个半加器把 8 个邻居加起来（41 门）；
- 判定用 `(s | self) == 3` 这个技巧：只需 `!(s≥4) & s1 & (s0 | self)`，不用算完整的 4 位计数；
- `seed` 输入直接 OR 进结果，用来注入初始图案，只花 2 门（复用了取反后的中间信号）。

**1024 种输入穷举验证通过。** 作为对比，Yosys + ABC 综合同样的功能是 63 门。

### 网格电路：顶层 0 个 NAND

`buildGrid(N)`：顶层放 N² 个 LATCH 存棋盘，每个细胞用 REF 引用规则电路，LATCH 的 d 接到 REF 的输出（利用 LATCH 可以前向引用）。

| 网格 | 流片消耗（本层） | 含复用的总门数 | 网表大小 |
|---|---|---|---|
| 4×4 | 0 NAND + 16 LATCH | 912 | 1,040 B |
| 8×8 | 0 NAND + 64 LATCH | 3,648 | 4,160 B |
| 16×16 | 0 NAND + 256 LATCH | 14,592 | 16,640 B |

加上规则电路本身一次性的 56 个 NAND：**8×8 的 Life 总共只要 120 个晶体管**。对比不用 REF 的平铺写法（Yosys 综合，见下）是 3,579 个 —— **省 30 倍**。

验证：滑翔机在 4×4 / 8×8 / 16×16 上分别跑 4N 拍，每一拍都和 numpy 风格的参考模型逐位一致。本地模拟器本身也和链上的 `eval()` 对拍过（Standard Cell Library #1，6/6 一致）。

```sh
cd scan
node build_life.mjs                    # 构建 + 验证，输出网表
node demo.mjs 8 24                     # 在终端里看滑翔机跑
node verify_chain.mjs 0xFAc299310ca53DB70De49F5e11D3B14A41B1Ef75 1 6   # 模拟器对拍链上 eval
node scan_info.mjs && node classify.mjs   # 重跑普查（约 1 小时，受公共 RPC 限流）
```

### 对照：不用 REF 的平铺写法

[life_core.v](life_core.v) 用 Yosys 综合成纯 NAND，每个细胞约 55 个 NAND + 1 个 LATCH：

| 网格 | NAND | LATCH | 合计 |
|---|---|---|---|
| 4×4 | 854 | 16 | 870 |
| 8×8 | 3,515 | 64 | 3,579 |
| 16×16 | 14,208 | 256 | 14,464 |
| 32×32 | 57,096 | 1,024 | 58,120 |

### 关于 oimo 那个无限递归

一个 OTCA metapixel 是 2048×2048 ≈ 420 万个细胞，即使按 REF 方案也要 420 万个 LATCH。链上不现实，结论和硅片流片一致：**递归缩放是渲染技巧，不是可综合的计算**。

## 4. 没做 / 待确认

- 没有连钱包、没有发交易。真要上链，需要你自己 mint token 并调用 `tapeout(netlist, nIn, nOut)`。
- 每拍 `beat` 的 gas 成本没有实测（合约里有 `runGasFor(gateCount, cycles)` 和 `maxRunGas` 限制，8×8 是 3,648 门，需要先确认没有超上限）。
- 协议还有一套"挖矿"机制（`getMiner`/`registerCounterexample`/`passesQuality`），看起来是给标准函数的最小电路发奖励，没有深入。
