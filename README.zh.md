# life-tapeout

[English](README.md) · **中文** · [展示页](https://brucelanlan.github.io/life-tapeout/) · [Playground](https://brucelanlan.github.io/life-tapeout/playground.html)

一个学习项目：研究 Conway 的生命游戏，并在两种完全不同的"流片"上把它重新搭起来。

| 方向 | 是什么 | 这里有什么 |
|---|---|---|
| **[tapeout.net](https://tapeout.net)** | BSC 链上协议：电路只由两种按 token 计价的元件组成 —— NAND 和 LATCH；任何已流片的电路都可以被别人用 `REF` 复用 | 从公开的前端和合约整理出协议的工作方式；把链上公开的电路读了一遍作为参考（看了 **27,671** 个，**12,015** 个对上了已知功能）；一个用 `REF` 复用把 8×8 做到 **120 个晶体管** 的 Life 设计（不复用约 3,579 个） |
| **[Tiny Tapeout](https://tinytapeout.com)** | 真实硅片：很多小设计拼在一颗 sky130 芯片上 | Verilog Life 引擎，640×480 VGA 输出，显示器式测试平台 + 金模型比对，已综合估面积 |

起点是阅读 oimo 的 [Life Universe](https://oimo.io/works/life)（"无限递归"的生命游戏）公开的源码，想弄明白它是怎么做到的。一句话：这是一件很漂亮的工程作品 —— 对一个 OTCA metapixel 做 HashLife 预计算，再用着色器遍历生成的四叉树；正因为重活都在离线阶段做完了，它并不适合直接搬到芯片或链上。学习笔记见 [docs/research.md](docs/research.md)。

![RTL 仿真截取的 VGA 输出](docs/life_vga.gif)

本仓库没有任何东西上过链。所有链上交互都是只读调用，没有连接钱包，没有花任何钱。

## 亮点

- **弄清了网表格式并对拍。** 根据平台公开的前端代码写出 tapeout.net 二进制网表（`NAND` / `LATCH` / `REF`）的解码器、编码器和模拟器，用链上已部署电路的 `eval()` 验证过，包括一个用了 `REF` 的电路。
- **链上公开电路的学习整理。** 通过公开的 `netlist()` 接口读取已上链的电路（原始数据不入库，`npm run survey` 可重新生成），小型组合电路跑真值表，和 39 个参考函数比对。加法器、乘法器、译码器、比较器、popcount 里找到的最小实现列成了表，并注明出自哪个项目。`REF` 在链上目前用得还不多（13,401 个候选里 4 个），这正是它值得研究的地方。
- **56 门的 Life 规则电路，穷举验证**（同一功能 Yosys+ABC 综合为 63 门）。另一个变体建立在链上现成的 55 门 popcount 之上，自己只需要 12 个 NAND。
- **顶层零门的棋盘。** N² 个 LATCH 存状态，每个细胞是一个指向规则电路的 `REF`。为什么这些 LATCH 省不掉，文档里有论证。
- **可直接发送的 calldata**，对链空跑验证过：模拟的 `tapeout()` 调用恰好 revert 在销毁 token 那一步（`ERC1155InsufficientBalance`），说明编码确实到达了正确的函数。
- **两种提交方式。** 把规则电路导出成 BLIF 导入官方画布，能导入、能过自检；画布通用的 BLIF 编译器会把每个 2 输入 `.names` 展开成 3 个门（对这份网表是 170 对 56），所以对于手工优化过的纯 NAND 网表，直接调用 `tapeout()` 更省。
- **两个交互页面。** [playground](docs/playground.html) 在浏览器里跑同一份网表，可以实时探测单个细胞的 56 个门；还有一个中英双语的[展示页](docs/index.html)。

## 目录结构

```
tapeout_net/            tapeout.net 方向
  README.md / README.en.md   完整报告（中文 / English）
  scan/                 脚本：网表编解码 + 模拟器、电路整理、Life 构建、calldata、BLIF 导出
  scan/out/             生成的网表（.hex）、BLIF、calldata.json
  scan/data/            整理缓存（已忽略；只提交了复用的 popcount8 网表）
  life_core.v           不用 REF 的基线，用于 Yosys 数 NAND
src/                    Tiny Tapeout Verilog（tt_um_brucelanlan_life）
test/                   Icarus 测试平台 + 金模型比对 / GIF 渲染
synth/                  Yosys 脚本，sky130 面积估算
docs/                   GitHub Pages：展示页、playground、研究笔记、VGA 截图
info.yaml               Tiny Tapeout 项目元数据（草稿）
```

## 快速开始

Node 22+，无依赖。

```sh
cd tapeout_net/scan
npm test                 # 构建两个版本的规则电路和网格并验证（穷举 + 滑翔机）
npm run demo             # 在终端里看滑翔机在网表模拟器里爬
npm run calldata         # 打印规则电路的 mint / tapeout calldata（不发送）
npm run survey           # 重新读取链上公开电路（公共 RPC 上约一小时）
```

Verilog 方向（`iverilog`、Python 3 + numpy、`ffmpeg`）：

```sh
mkdir -p sim
iverilog -g2012 -o sim/tb.vvp test/tb.v src/tt_um_brucelanlan_life.v
cd sim && vvp -n tb.vvp && python3 ../test/check_and_render.py 16
```

16×16 全量在 Icarus 里约 22 分钟（288 帧；266 次代际转换，0 不一致）。给 `vvp` 加 `+short` 可以快速跑；或者用 `-Ptb.N=8 -Ptb.CSH=5` 编译并给 Python 脚本传 `8` 跑 8×8。

面积估算：

```sh
./synth/fetch_lib.sh && yosys -s synth/synth_16.ys
```

| 网格 | 单元数 | 面积（sky130_fd_sc_hd） | Tiny Tapeout 格数（估计） |
|---|---|---|---|
| 8×8 | 1,723 | 1.62 万 µm² | 1×2 |
| 16×16 | 5,955 | 5.46 万 µm² | 3×2 |

## Tiny Tapeout 引脚

| 引脚 | 功能 |
|---|---|
| `ui_in[0]` | 运行 |
| `ui_in[1]` | 单步（上升沿 = 一代） |
| `ui_in[2]` | 装载预设（上升沿） |
| `ui_in[4:3]` | 预设：0 滑翔机，1 R-pentomino，2 LWSS，3 随机 |
| `ui_in[7:5]` | 速度：每 2^speed 帧一代 |
| `uo_out` | TinyVGA PMOD `{hsync, B0, G0, R0, vsync, B1, G1, R1}` |
| `uio_out` | 代数计数器 |

时钟 25.175 MHz（25 MHz 在大多数显示器上也能用）。

## 状态，以及有意没做的事

- 两个方向都没有真正流片。tapeout.net 的 calldata 已生成并空跑验证，mint 和发送由仓库所有者决定；Tiny Tapeout 的 GDS 流程（OpenLane）没有跑，格数是估计值。
- 链上 `beat()` 的真实 gas 是从 `eval()` 实测外推的（约每门 2,468 gas）；挖矿合约的 1,200 万 `maxRunGas` 是否也约束 `beat()`，没能确认。

## 致谢

- [saharan](https://github.com/saharan)：Life Universe 及其公开源码，本项目只是学习它。
- [tapeout.net](https://tapeout.net) 团队：协议本身，以及把电路做成可公开读取；还有参考表里出现的每一个项目。
- [Tiny Tapeout](https://tinytapeout.com)：让真实流片变得触手可及。

## 许可

[MIT](LICENSE)。
