# Life on tapeout.net

[English](README.en.md) · **中文**

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

第二轮（[scan/classify2.mjs](scan/classify2.mjs)）把含 REF 的电路也递归解析进来，参考函数库扩到 39 个：**13,401 个候选里识别出 12,015 个**。仍有限制：只覆盖无状态、输入不超过 14 位、形状匹配参考函数表的电路。所以下表是"已识别范围内的最小实现"，不是全网最优；"链上没有 Life 规则电路"这句话同样只在这个范围内成立。

一个意外发现：13,401 个候选里**只有 4 个真的用了 REF**。跨电路复用这个机制链上几乎没人在用，而它恰恰是省 token 的关键。

普查原始数据不入库（`npm run census` 重新生成，约一小时）。识别结果汇总如下：

| 功能 | 最小门数 | 项目 / 电路号 |
|---|---|---|
| NAND / AND / OR | 1 / 2 / 3 | Genesis #4255、Blonskr_No1 #47 #48 |
| NOR / XOR / MUX2 | 4 | Blonskr_No1 #49 #50、Genesis #4263 |
| XNOR / 半加器 | 5 | Genesis #4259 #4265 |
| 三输入多数表决 | 6 | Genesis #4262 |
| 全加器 | 9 | Blonskr_No1 #145 |
| 2-4 译码器 / MUX4 | 10 / 11 | Genesis #4267、TapeOut #1060 |
| 2×2 乘法 / 4 位加一 | 15 / 16 | Blonskr_No1 #533、TapeOut #924 |
| 4 位大于比较 / 4 位 popcount | 18 / 21 | Blonskr_No1 #1112、TapeOut #1799 |
| 4 位移位（左/右） | 23 | Blonskr_No1 #1146 #1153 |
| 3-8 译码器 / 4 位相等 | 25 / 26 | Blonskr_No1 #607 #152 |
| 8 位奇偶校验 | 28 | Genesis #4264 |
| 4+4 位加法（含进位） | 32 | TapeOut #2118 |
| 8 位加一 / 3×3 乘法 | 36 / 45 | TapeOut #925、Blonskr_No1 #2469 |
| 6+6 位加法 | 50 | Blonskr_No1 #1881 |
| **8 位 popcount** | **55** | **TapeOut #3151** |
| 4×4 乘法 | 114 | TapeOut #8709 |

其中 **TapeOut #3151 的 55 门 8 位 popcount 直接可用**：Life 每个细胞要做的第一件事就是数 8 个邻居。因为 REF 引用不花 token，把它当子模块之后，我们自己只需要再补 12 个 NAND 做判定（见下）。

链上没有找到现成的 Life 规则电路，所以这部分得自己做。

## 3. 我们的设计

### 方案 A：自制规则电路，56 个 NAND

[scan/build_life.mjs](scan/build_life.mjs) `buildRule()`，10 输入（8 邻居 + 自身 + seed）→ 1 输出：

- 用 3 个全加器 + 1 个半加器把 8 个邻居加起来（41 门）；
- 判定用 `(s | self) == 3` 这个技巧：只需 `!(s≥4) & s1 & (s0 | self)`，不用算完整的 4 位计数；
- `seed` 输入直接 OR 进结果，用来注入初始图案，只花 2 门（复用了取反后的中间信号）。

**1024 种输入穷举验证通过。** 作为对比，Yosys + ABC 综合同样的功能是 63 门。

### 方案 B：复用链上的 popcount8，自己只花 12 个 NAND

[scan/build_life_ref.mjs](scan/build_life_ref.mjs)：REF 引用 TapeOut #3151（55 门 popcount8），拿到 4 位邻居计数后，用 12 个 NAND 完成 `!(b3|b2) & b1 & (b0|self)` 判定和 seed 注入。同样 1024 种输入穷举验证通过。

代价是每拍的门数从 57/细胞涨到 68/细胞（popcount 给出完整计数，比 Life 需要的多）。**token 更省，gas 更贵。**

### 为什么顶层的 LATCH 省不掉

REF 的输入只能引用更早的信号，只有 LATCH 的 d 可以前向引用。这意味着**任何跨细胞的反馈环都必须经过一个顶层 LATCH**：

- 想把"棋盘存储"也做成一个可复用的子电路（比如 REF 一个别人做的 64 位寄存器）是不行的 —— 寄存器 REF 要放在规则 REF 前面才能输出当前状态，但它的输入（下一状态）又依赖规则 REF 的输出，成环。
- 所以 N² 个 LATCH 是结构上无法避免的，**120 个晶体管（64 LATCH + 56 NAND）基本就是 8×8 的下限**，除非有人已经把整块 Life 棋盘流片过（目前没有）。

### 网格电路：顶层 0 个 NAND

`buildGrid(N)`：顶层放 N² 个 LATCH 存棋盘，每个细胞用 REF 引用规则电路，LATCH 的 d 接到 REF 的输出（利用 LATCH 可以前向引用）。

| 网格 | 流片消耗（本层） | 含复用的总门数 | 网表大小 |
|---|---|---|---|
| 4×4 | 0 NAND + 16 LATCH | 912 | 1,040 B |
| 8×8 | 0 NAND + 64 LATCH | 3,648 | 4,160 B |
| 16×16 | 0 NAND + 256 LATCH | 14,592 | 16,640 B |

三种做法在 8×8 上的对比：

| 做法 | 流片消耗的晶体管 | 每拍门数 | 单拍 gas（实测外推） |
|---|---|---|---|
| Yosys 平铺，不用 REF | 3,579 | 3,515 | ~905 万 |
| 方案 A：自制规则 56 门 + REF | **120**（64 LATCH + 56 NAND） | 3,648 | ~940 万 |
| 方案 B：复用 #3151 + 12 门 | **76**（64 LATCH + 12 NAND） | 4,352 | ~1,115 万 |

gas 数字的来源（[scan/gas_probe.mjs](scan/gas_probe.mjs)，`eth_estimateGas`，只读）：

- 对已上链的三个不同大小的电路实测 `eval()`：65 门 → 201,058 gas；1,204 门 → 2,960,378；2,584 门 → 6,419,057。拟合出 **约 2,468 gas/门 + 4 万**，上表按此外推。
- 协议自己的预算公式是 `runGasFor(gates, 1) = 3000×门数 + 50000`，`maxRunGas()` = 12,000,000。但这两个是**挖矿合约**（0x7E2E…7b46）上的参数，我没能证明普通的 `beat()` 也受它约束 —— 该合约是代理，`beat`/`evaluate` 直接调用都 revert（大概需要先注册）。所以 **"8×8 会不会超协议上限"这个问题目前无法定论**，方案选择只能按实测 gas 和 BSC 的区块 gas 上限（约 1.4 亿）来判断，两个方案都在区块上限内。
- 只读调用能跑多大：6,020 门的电路 `eth_estimateGas` 正常（1,428 万），9,632 门时 estimateGas 失败但 `eth_call` 仍返回结果，30,736 门两者都失败。**16×16（14,592 门）用只读 `step()` 大概率可以跑，上链 `beat` 则未知。**

验证：滑翔机在 4×4 / 8×8 / 16×16 上分别跑 4N 拍，每一拍都和参考模型逐位一致。本地模拟器与链上 `eval()` 对拍过两次：Standard Cell Library #1（65 门，6/6 一致），以及 Blonskr_No1 #30（1,204 门、**含 REF**，8/8 一致）—— 后者确认了 REF 的语义，整个网格方案都建立在它上面。

```sh
cd scan
node build_life.mjs                    # 方案 A：构建 + 验证，输出网表
node build_life_ref.mjs                # 方案 B：复用链上 popcount8
node find_refs.mjs                     # 找链上在用 REF 的电路
node demo.mjs 8 24                     # 在终端里看滑翔机跑（N 不限于 2 的幂，7 也可以）
node gas_probe.mjs                     # 实测链上 eval 的 gas
node verify_chain.mjs 0xFAc299310ca53DB70De49F5e11D3B14A41B1Ef75 1 6   # 模拟器对拍链上 eval
node scan_info.mjs && node classify.mjs   # 重跑普查（约 1 小时，受公共 RPC 限流）
```

### 对照：不用 REF 的平铺写法（Yosys）

[life_core.v](life_core.v) 用 Yosys 综合成纯 NAND，每个细胞约 55 个 NAND + 1 个 LATCH：

| 网格 | NAND | LATCH | 合计 |
|---|---|---|---|
| 4×4 | 854 | 16 | 870 |
| 8×8 | 3,515 | 64 | 3,579 |
| 16×16 | 14,208 | 256 | 14,464 |
| 32×32 | 57,096 | 1,024 | 58,120 |

### 关于 oimo 那个无限递归

一个 OTCA metapixel 是 2048×2048 ≈ 420 万个细胞，即使按 REF 方案也要 420 万个 LATCH。链上不现实，结论和硅片流片一致：**递归缩放是渲染技巧，不是可综合的计算**。

## 4. 真要上链时怎么做

[scan/make_calldata.mjs](scan/make_calldata.mjs) 生成可以直接用钱包发送的 calldata，自己不发任何交易：

```sh
node make_calldata.mjs 8                                   # 先出规则电路的 mint + tapeout calldata
node make_calldata.mjs 8 <项目的Circuits地址> <规则电路id>   # 规则流片后，再出网格的
```

顺序是：mint 56 个 NAND → `tapeout(ruleNetlist, 10, 1)` → 从 `TapedOut` 事件里拿到 circuitId → mint 64 个 LATCH → `tapeout(gridNetlist, 64, 64)`。

脚本会做这些只读的预检：

- 规则电路 1024 种输入穷举自检；
- 网表编码 → 解码 → 再编码的往返一致性；
- 读链上的 `TAPEOUT_FEE()`（实测 0.0002 BNB）和项目已有电路数；
- **用 `eth_call` 空跑一次 tapeout**：从一个没有 token 的地址发，结果 revert 在 `ERC1155InsufficientBalance`（OpenZeppelin 的自定义错误 `0x03dee4c5`）。这说明 selector、偏移量、长度字段全部正确，调用一路走到了销毁 token 那一步，只差 token。

### 走官网画布还是走 calldata？

[scan/blif.mjs](scan/blif.mjs) 把规则电路导出成 BLIF（`out/life_rule.blif`），官网画布的"导入 BLIF"能读。我在画布里实测过（纯前端，不连钱包）：**导入成功、自检通过**，但画布把每个 `.names` 2 输入 NAND 编译成 3 个 NAND（AND + NOT），**56 门变成 168 门**，再加固定的 2 个输出缓冲 = 170 个晶体管。换成 on-set 写法（`0- 1 / -0 1`）更糟，252 门。

画布的 BLIF 导入只支持扁平网表（`.inputs/.outputs/.names/.latch`，不支持 `.subckt`），所以 REF 结构也表达不了。结论：

| 路线 | 规则电路消耗 | 8×8 网格消耗 | 备注 |
|---|---|---|---|
| 官网画布导入 BLIF | 170 | 约 3,776（`out/life_grid_8.blif`，扁平） | 能看图，贵 3 倍 |
| 直接发 `tapeout()` calldata | **56** | **64** | 省 token，画布事后可以从链上取回网表还原成图 |

前端确认的另一条硬限制：**单笔流片的网表上限约 4 万字节**。8×8 网格 4,160 字节、16×16 网格 16,640 字节都在限内。

## 5. 浏览器里的 playground

[docs/playground.html](../docs/playground.html)（在线：https://brucelanlan.github.io/life-tapeout/playground.html）：把同一份网表搬进浏览器，可以看棋盘跑，点某个细胞会显示它的 3×3 邻域和那 56 个 NAND 的实时翻转。页面里的规则电路代码经 node 复核，与仓库里的完全一致（56 门、392 字节、1024 种输入 0 不一致）。

## 6. 没做 / 待确认

- 没有连钱包、没有发交易。真要上链，需要你自己 mint token 并调用 `tapeout(netlist, nIn, nOut)`。
- `beat()` 的真实 gas 和它是否受 `maxRunGas` 约束，没能确认（合约是代理，直接调用 revert）。上表的 gas 是用 `eval()` 实测外推的。
- 网格电路本身没有流片，所以没有真实的链上 `step()` 结果可对拍；本地模拟器的正确性是通过已上链的电路（含 REF 的那个）间接验证的。
- 协议还有一套"挖矿"机制（`getMiner`/`registerCounterexample`/`passesQuality`），看起来是给标准函数的最小电路发奖励，没有深入。
