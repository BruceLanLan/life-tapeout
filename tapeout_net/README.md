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
| 8 位 popcount | **55** | **TapeOut #3151** |

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

### 网格电路：顶层 0 个 NAND

`buildGrid(N)`：顶层放 N² 个 LATCH 存棋盘，每个细胞用 REF 引用规则电路，LATCH 的 d 接到 REF 的输出（利用 LATCH 可以前向引用）。

| 网格 | 流片消耗（本层） | 含复用的总门数 | 网表大小 |
|---|---|---|---|
| 4×4 | 0 NAND + 16 LATCH | 912 | 1,040 B |
| 8×8 | 0 NAND + 64 LATCH | 3,648 | 4,160 B |
| 16×16 | 0 NAND + 256 LATCH | 14,592 | 16,640 B |

三种做法在 8×8 上的对比：

| 做法 | 流片消耗的晶体管 | 每拍门数 | 单拍 gas（3000/门 + 50k） |
|---|---|---|---|
| Yosys 平铺，不用 REF | 3,579 | 3,515 | 1,055 万 |
| 方案 A：自制规则 56 门 + REF | **120**（64 LATCH + 56 NAND） | 3,648 | 1,099 万 ✅ |
| 方案 B：复用 #3151 + 12 门 | **76**（64 LATCH + 12 NAND） | 4,352 | 1,311 万 ❌ 超限 |

协议的 `maxRunGas()` 是 **12,000,000**，`runGasFor(gates, 1)` = 3000×门数 + 50000（实测自链上）。所以：

- **8×8 用方案 A**，1,099 万 gas，卡在上限内；
- 方案 B 更省 token，但 8×8 超 gas 上限，适合 7×7 及以下（7×7 = 3,332 门，1,005 万 gas，可行）；
- 16×16 两种方案都远超上限，链上跑不动，只能用 `step()` 这种免费的只读调用在链下跑。

验证：滑翔机在 4×4 / 8×8 / 16×16 上分别跑 4N 拍，每一拍都和参考模型逐位一致。本地模拟器与链上 `eval()` 对拍过两次：Standard Cell Library #1（65 门，6/6 一致），以及 Blonskr_No1 #30（1,204 门、**含 REF**，8/8 一致）—— 后者确认了 REF 的语义，整个网格方案都建立在它上面。

```sh
cd scan
node build_life.mjs                    # 方案 A：构建 + 验证，输出网表
node build_life_ref.mjs                # 方案 B：复用链上 popcount8
node find_refs.mjs                     # 找链上在用 REF 的电路
node demo.mjs 8 24                     # 在终端里看滑翔机跑
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

## 4. 没做 / 待确认

- 没有连钱包、没有发交易。真要上链，需要你自己 mint token 并调用 `tapeout(netlist, nIn, nOut)`。
- gas 数字来自链上的 `runGasFor` / `maxRunGas`（挖矿合约 0x7E2E…7b46），是协议自己的预算公式；实际 `beat` 交易的 gas 没有实测（需要先流片）。
- 协议还有一套"挖矿"机制（`getMiner`/`registerCounterexample`/`passesQuality`），看起来是给标准函数的最小电路发奖励，没有深入。
