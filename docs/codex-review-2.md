# Codex 复审报告（gpt-6.1-sol, reasoning=medium）

## 结论（通过 / 有条件通过 / 不通过）

**不通过。** 图集采样、指定冷启动场景、传送带基础玩法、撑杆越障、弹丸命中顺序和射击重播均有实测改善；但 **1-10 可达的 Chomper 仍完全不可见，旗帜预警仍未等待 750 tick**，不能关闭全部 P1。另有 Reanim 插值跳变、菜单调试闭包残留等 P2。

复审日期：2026-11-15。使用现有 `http://127.0.0.1:5188/`，没有停止或重启服务器、另开服务端口，也没有修改 src/、data/、tools/。本次仅写本报告、`docs/shots/codex2-*.png`，以及获准的构建产物 dist/。行号按本次工作树。

方法与证据边界：所有浏览器测试由现有 `tools/shot.mjs` 启动独立 Chrome profile，冷启动不借用其他关卡的动画缓存。实际鼠标输入与 CDP evaluate 受控调用分别标注。隔离 Board 通过现有 `Board.create()` 创建，没有重写游戏函数；为局部测试可以设置实体位置、计时器、HP 或随机数。加速调用 update 的胜负测试证明模拟路径，不代表正常阳光、自然时长的平衡验收。`ERRORS: none` 不包含 warning，也不证明画面完整。

## P1 逐项复核（id、上一轮问题、是否修复、证据）

### P1-1 图集采样 — 已修复（本轮采样与画面范围）

上一轮把逻辑宽高直接作为纹理采样范围，导致跨切片采样。

- `src/assets.ts:240-262` 的 view 按 `sw=invScale×dw`、`sh=invScale×dh` 返回源尺寸，cel 偏移同样乘 invScale；目标仍为逻辑尺寸。`src/reanim.ts:167,218,237`、过滤缓存 `src/assets.ts:302` 和 HUD 的直接 drawImage 路径均使用这套源/目标分离结果。
- 浏览器内遍历 manifest 全部 **1876 切片，0 越界**：检查 `x+w×invScale<=atlas.w`、`y+h×invScale<=atlas.h`，同时检查非负坐标；该全切片范围也覆盖每个合法 cel。
- 实际鼠标冒烟：1-1，9999 阳光、3 倍速，点击 `(40,46)`、`(280,330)` 后运行 20 秒，实测 sun=9899、wave=2/4、plants=1、tick≈6784。人工查看 [战斗截图](shots/codex2-run.png)：阳光不再夹杂绿色字形，僵尸身体可辨，小车不再采入相邻图块。另见 [坚果关截图](shots/codex2-wallnut.png)。没有把这些截图扩大为全部动画逐帧还原通过。

### P1-2 非 Spine 植物与冷启动加载闭包 — 指定场景通过，整体部分修复

- **真实输入、独立冷启动 1-4**：点击第四张卡 `(40,277)`，在 `(280,330)` 种植 Wallnut。阳光 9999→9949，画面有坚果身体，`reanim=true`；动画时间实测 0.50588→0.57647（额外调用 update(0.1) 取样）。见 [Wallnut](shots/codex2-wallnut.png)。不是仅扣费占位。
- **真实输入、独立冷启动 1-8**：点击首卡种 Peashooter，sun=9899，`spine=true,current=idle,trackTime≈4.93`，身体可见。见 [1-8](shots/codex2-level8.png)。
- 静态检查 `src/game/board.ts:326-415`：resolveLoadout 同时供预加载和卡组初始化；覆盖 fixed packets、playerChosen 前 N 个 offers、conveyor initialCards/cardPool、special 预置植物。`plantReanimName()` 已按非 Spine resourcePath、Spine legacy fallback 解析。1-5 的预置豌豆也实测有 Spine。
- **闭包包含种子不等于可绘制资源完整**：冷启动 1-10 的七种可达卡中，Chomper 的 Spine 加载失败，fallback 虽有 Reanim 对象但全部图像缺失。详见下文新发现 P1；因此整体资源可见性不能判为全部修复。README 已承认 fallback 缺图，不能覆盖当前实际可发出的传送带卡。

### P1-3 传送带、预置植物与特殊攻击 — 部分修复

- **1-5 真实鼠标输入**：开局 sun=0，无普通购买卡栏；预置 Peashooter 坐标准确为 `(5,1),(7,2),(6,3)`，全部有可见身体。点击传送带 `(175,530)` 后点 `(280,330)`，新增 Wallnut，sun 仍为 0，消费一张卡。见 [1-5 开局与免费种植](shots/codex2-level5-start.png)。
- **1-5 受控推进**：另一次运行调用原 update 2500 次，`sunsFallen=0,suns=0`，传送带继续补出 Wallnut/ExplodeONut。不是仅修改 UI 文案。池权重 85/15，与 loadout 一致。见 [推进后截图](shots/codex2-level5.png)。
- **1-10 权重分支受控验证**：池为 Peashooter/Cherrybomb/Wallnut/Repeater/Snowpea/Chomper/Potatomine，权重 20/20/15/20/10/5/10。暂时把 Math.random 固定为 0、0.1、0.3、0.5、0.7、0.9、0.99999，pickConveyorCard 依次返回豌豆、豌豆、樱桃、坚果、双发、Chomper、土豆雷，随后恢复随机函数。证明按累计权重分支选择，未声称做了随机分布统计。
- **Chomper 逻辑可触发**：受控 addPlant 在 col=2,row=2，同行普通僵尸放到 plant.x；调用 updatePlants，先进入 windup=70；70 次后进入 digest=4000，目标 270→-99729、state=die。但全过程 80 次 draw 的图像绘制次数为 **0**，植物身体不可见，不能按完整玩法验收。见 [不可见 Chomper 吞噬后的画面](shots/codex2-chomper.png)。
- **ExplodeONut 死亡爆炸可触发**：受控在 1-5 隔离 Board 种爆炸坚果，设 hp=4，将普通僵尸放在其啃食范围，调用 updateZombies。由啃食触发死亡，植物格清空，目标 270→-1530、state=die，explosions=1。没有直接调用 explodePlant 冒充触发。
- README 已明确不做原版滚坚果保龄球。本轮只认可其声明的传送带简化范围，不认可“原版 1-5 完整复刻”。

### P1-4 撑杆僵尸 — 核心行为已修复；Tall-nut 仅分支验证

真实冷启动使用 `level=6&spawn=Polevaulter&row=1` 加载对应动画，然后受控种 Wallnut 并把僵尸移到其右侧。

- 起始速度约 0.66；调用 updateZombies，第 23 次进入 vault，x=279.738、播放 anim_jump，坚果 HP 仍为 4000（先跳而非先啃）。
- 第 63 次落地，`state=walk,vaulted=true,x=220,speed=0.29177`；坚果 x=280，已越过它且 HP 不变。验证了 40 tick 跳跃与落地降速。
- 本项目 assets.plants 没有 Tallnut 定义。因此使用 Wallnut 定义副本，只把 seedType 设成 Tallnut 来验证条件分支；100 次 updateZombies 后 `state=eat,vaulted=false`、植物 HP=3920，未越过。**这不是实际 Tall-nut 资源/卡片/完整动画验收**，该项边界保留在未验证项。
- 实现位置 `src/game/board.ts:893-935`。没有把瞬移实体的测试称为玩家自然遇敌。

### P1-5 弹丸命中顺序 — 已修复

浏览器隔离 Board 内，同行两只普通僵尸分别位于 x=300、290；弹丸 x=320、damage=20，调用一次 updateProjectiles。

- 数组顺序 `[300,290]`：HP 分别 `[270,250]`。
- 数组顺序 `[290,300]`：HP 分别 `[250,270]`。

两种出生顺序均先伤害路径上较近的 x=290，远者不受伤。`src/game/board.ts:1003-1012` 已由 find 改为候选最小 x。本轮验证当前固定右行弹速 3.33 与碰撞盒重叠场景，未声称实现任意高速扫掠碰撞。

### P1-6 Spine 射击重播与回 idle — 原阻断已修复，仍有 P2 截断

受控种 Peashooter，把同行目标置于 x=700，令首次 timer=0，连续调用原 updatePlants 550 次（未调用伤害/弹丸移动，以保留目标）。

- 四次发射发生在 tick 0、149、295、438；每次 Spine 都新进入 shooting，trackTime=0，而非沿用已结束 track。
- 清除目标后再推进 120 次，current=idle、trackTime≈2.02。`src/spine.ts:96-99` 强制重启与 `src/game/board.ts:811-819` 回 idle 确实在运行时工作。
- 但 shooting 实际 duration=1 秒，fireTimer=29 tick。另一次实测发射后 29 tick 已切回 idle：动画只播放约 0.29 秒，不能把“回 idle”描述成“完整射击动画结束”。作为 P2 单列，不再按原来的停末帧/无法重播 P1 计。

### P1-7 波次调度 — 未修复完整，仍为 P1

- **血量加速分支工作**：隔离 Board 设 waveIndex=1、waveStartTick=0、tickCount=401、waveCountdown=2000、nextWaveHealthThreshold=100、无存活僵尸；调用 updateWaves 后 countdown=199，即压到200后在同次调用递减。初始倒计时已从 level 配置读取，healthToNextWaveFractionRange 参与阈值计算。`initialDelay` 在 src 中已无匹配。
- **旗帜预警仍错误**：1-10 隔离 Board 设 waveIndex=9（下一波为旗波）、waveCountdown=6。第一次 updateWaves 得 `{wave:9,count:1,warning:750,zombies:0}`；下一次就变 `{wave:10,count:2788,zombies:14}`。即预警后 **1 tick 就出生**，不是等待750 tick。这里直接调用 updateWaves，所以 warning 数值未由 update 顶部递减；不影响已证实的提前出生结论。
- 根因：`src/game/board.ts:595-597` 在 countdown=5 时立即置1，hugeWaveTimer 只是显示倒计时，没有门控出生。应在预警计时结束后才把波次倒计时置1。`docs/spec-levels.md:153-155` 与原 C# `Lawn/Board.cs:7330-7334,7392-7397` 均明确这点。
- 字段消费仍不完整：`hugeWaveCountDownTicks`、`healthShortcut.minCountDownTicks` 没有被读取，使用硬编码750/200；flagWaveCountDownTicks 被用于判断下一波，和 JSON 的“刚出生旗波后”说明不一致。1-5 因 flagWaveCountDownTicks=null 又直接跳过旗波预警条件。这里指出当前实现与项目数据/声明不一致；原源码 `IsFlagWave(mCurrentWave)` 的索引语义还需同步修订数据说明，不能只照上一轮文字机械改位置。

## 新发现问题（P0/P1/P2；无则写无）

无 P0。以下含修复后新暴露的问题与上一轮未完全关闭的问题，不重复累计为不同 P1 数量。

1. **P1：Chomper 在实际 1-10 卡池可达，但完全不可见（关联 P1-2/P1-3）。**
   - 冷启动稳定警告 `[spine] failed to load chomper`。独立重新加载同一资源捕获的错误对象为 `data/spanim/chomper_2.png: Couldn't load image`；`data/spanim/chomper.atlas:271` 引用了第二页，data/spanim 只有 chomper.png，没有 chomper_2.png。原安装目录存在第二页文件，但本次没有复制或修复它。
   - fallback `data/reanim/Chomper.json` 的380个不同图像 ID 全部无法在 manifest sprites/images 命中。受控测试80次 drawImage 调用数合计0，仍可以无形吞噬僵尸。状态里的 `visual:"reanim"` 仅证明持有对象，不能当可见性断言。
   - 应补完整 Spine atlas 页，并以实际绘制/引用完整性检查可达卡片，而非只查动画句柄非空。截图见上。

2. **P1：旗帜预警未门控出生（P1-7 复现）。** 750 tick 显示计时不能替代实际等待；实测1 tick即出14只僵尸。应保留为未关闭项。

3. **P2：新增 Reanim 插值在半帧跳前、整帧倒跳。**
   - `src/reanim.ts:92-95` 组合 `before=Math.round(t)` 与 `frac=t-floor(t)`，插值基准不一致。受控三帧 tx=[0,10,20]，浏览器调用现有 frameSample：t=0.49/0.51/0.99/1.01 得插值 tx=4.9/15.1/19.9/10.1；存在明显跳变。
   - **规范本身也有误**：`docs/spec-reanim.md:350` 写 round(t)。本轮只读核对原 `D:/逆向/output/PlantGirlsVsZombies/decompiled/Lawn/Sexy/TodLib/Reanimation.cs:601-604`：先把 num2 转 int 得 num3，再 `(short)(num3+0.5)`；非负帧轴等效 floor(t)，不是 round(t)。开发者确实照了当前规范，但效果仍错误；需连同规范纠正。本轮未修改规范。
   - draw 已加入 tx/ty/scale/skew/alpha 的 lerp，故“完全未插值”已改善；不能据此宣称完整正确。还未按 doc.interpolate 控制插值。

4. **P2：菜单状态清理遗漏 `__getState` 闭包。**
   - `src/shell.ts:146-150` 只删除 __board、__SHOT_STATE__；`src/game/board.ts:1356` 的函数仍捕获旧 Board。
   - 受控调用实际菜单按钮 `pointerDown(850,20)` 后，__board 与 __SHOT_STATE__ 都 undefined，但 __getState 仍是 function，返回旧局 playing/1株植物/1只僵尸。见 [菜单画面](shots/codex2-menu.png)，shot 自己随后输出的 STATE 仍是旧局。旧对象仍有引用，采集仍可能误判。

5. **P2：射击动画提前截断。** 如 P1-6，真实1秒轨道在29 tick切 idle。重播修复属实，但“射击动画结束后回 idle”的描述不准确，应按轨道完成事件或合理事件映射处理。

## 回归检查

- **类型与构建**：单独执行 `npx tsc --noEmit`，以及 `npm run build`，均通过；Vite 7.3.8、60模块。构建包含 index.html、两份 JS、dist/data。逐文件 SHA-256 比较 **data 下212个文件与 dist/data 全部一致，0缺失/差异**。自包含复制声明属实；源 data 自身缺 Chomper 第二页的问题也被原样带进 dist。
- **浏览器控制台**：实际1-1、1-4、1-5、1-6、1-8及1-10导航和局部测试未收集到 console error、Runtime exception 或 Log error。1-10有真实 Spine warning，已列P1。诊断时额外请求不存在的测试资源产生的 warning 不计产品缺陷；对真实 chomper 的独立重载已确认缺页根因。
- **1-1胜利**：9999初始阳光，调用 pointerDown 种五行豌豆，每株间原 update 750次等待冷却；再调用原 update，tick=6738得到 won、plants=5。没有直接设置胜负/波次/敌人HP。再推进1000次，尸体1→0。见 [胜利](shots/codex2-win.png)。这是受控输入/加速模拟。
- **1-1失败**：不种植物，受控额外放入三只普通僵尸到同一行，再按原 update 推进。tick=9791得到 lost，突破者 x≈-36，小车已耗尽；见 [失败](shots/codex2-loss.png)。另一次隔离实例增两只同排僵尸也得到 lost。一次未增怪的随机1-1被小车全部清完而 won，故没有把它误写为失败证据。
- **铁桶别名**：受控生成 Pail，调用 damageZombie(1100)，helm=0、bodyHP=270、hidden 新增 anim_bucket；通过。TrafficCone 分支静态核对存在，未逐帧实测其脱落美术。
- **HUD**：代码与截图核对225px填充、横幅y=565、按钮45高、末15 tick线性alpha均已改；铲子有底座及输入分支。剩余进度仍只用 waveIndex/总波数（board.ts:1602-1605），没有波内倒计时/血量插值、旗帜标记；packetAt 仍为top..top+52。原版金色阳光板/标题布局/教学行限制等仍是README明确限制，没有把全部HUD判为像素还原通过。
- **缓存**：小车持有相同Reanim实例，10次update前后animTime=0.83529→0.95294，证明实例复用且时间连续；预览已由选卡时buildGhost持有，drawGhost不再new Spine。预览未在update里推进（静态预览），不等于动画预览完整实现。调试状态采样已尝试降频，但使用tickCount%20条件，不是严格的独立采样时钟。
- **点击盒/落阳/双发**：受控落阳token中心右侧70px点击进入collect，143×143范围生效。落阳倒计时已改为先按旧sunsFallen计算再递增。Repeater已排队延迟第二发而非同tick两弹；只静态核对排队消费，不宣称其全部植物死亡/铲除边界通过。
- **状态清理**：胜利尸体退场通过；菜单清理只部分通过，遗漏函数见P2。

## 未验证项

- 未逐关正常阳光、自然时间通关1-1～1-10，未做传送带关胜率/平衡统计；尚未验收原版滚坚果玩法。
- Tall-nut 实际定义不在当前植物数据中，仅验证注入别名的阻挡分支；未验证其真实资源、独有动画及失杆行为。
- 未逐帧比对原游戏全部动画/截图，未对1876切片每一种cel进行视觉检视；越界是全量算术检查，画面是关键场景抽查。
- 未将dist另启服务器或部署到外部静态托管；本轮验证实际构建写盘及212个数据文件哈希一致，不保证源资产自身完整。
- 未进行移动端、触屏、多浏览器、高DPI矩阵、长时heap/帧率基准或主观音频验收。
- 未全面测试Chomper目标移出范围/被其他攻击杀死、Repeater植物被铲除后待发弹、所有寒冰/撑杆组合。特殊攻击通过仅限文中明确构造的场景。
- 目录没有.git，不能给出git差异清单；本轮未运行生成资产/关卡的工具，也未改动被审查源文件或数据。
