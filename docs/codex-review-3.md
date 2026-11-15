# Codex 复审报告（gpt-6.1-sol, reasoning=medium）— 第三轮

## 结论（通过 / 有条件通过 / 不通过）

**不通过。** 第二轮 Chomper 不可见的 P1 已修复，三项重点 P2（Reanim 插值、菜单旧状态闭包、射击动画 29 tick 截断）已修复；但旗波预警只在单独调用 `updateWaves()` 时通过，实际 `update()` 每 tick 重复递减预警，750 tick 变成 375 tick，仍有 **1 项 P1**。另新发现 **1 项 P2：小车击倒最后一只僵尸后，胜利分支无法清理其尸体**。

复审日期：2026-11-15。沿用 `http://127.0.0.1:5188/`，未终止或重启 dev server，未另启服务端口。仅写本报告、`docs/shots/codex3-*.png` 及获准的 dist 构建产物；未修改 src/、data/、tools/。

测试方法：通过现有 `tools/shot.mjs` 的独立 Chrome profile 冷启动、CDP evaluate 和鼠标事件测试。下文明确区分实际点击、受控注入与隔离 Board。隔离实例使用现有 `Board.create()`；没有替换游戏更新函数。运行时修改配置副本、计时器、HP、位置及加速调用原函数，只证明相应路径，不代表正常资源与自然时长下的平衡验收。数值证据来自 `EVAL` 输出；隔离 Board 的探针截图通常仍是主局画面，不能把工具自动输出的主局 `STATE` 当成隔离实例的结果。

## 逐项复核（P1/P2：是否修复 + 证据）

### 1. P1：Chomper 完全不可见 — 已修复

独立冷启动 `?autostart=1&level=10`，等待 6000 ms。控制台正常记录 `[spine] chomper: 10 animations ...`，没有 `[spine] failed to load chomper`，也没有 console error、Runtime exception 或资源加载 error。

受控调用主局 `addPlant(Chomper,2,2)`，确认 `spine=true`，动画列表包含 idle、bite、chew、swallow。新建透明的 1000×600 离屏 canvas，只调用一次现有 `drawPlant(ctx,p)`；临时包裹 `CanvasRenderingContext2D.prototype.drawImage`，在 finally 恢复。结果：

- **drawImage=1903 次，非透明像素=4186 个**。计数与像素均不含背景、HUD、阴影或其他实体，证明植物本体实际绘制。
- 受控生成同行 Normal，放到植物 x；`updatePlants()` 后进入 `windup, timer=70`。
- 再调用 70 次：进入 `digest, timer=4000`，目标 HP `270→-99729`、`state=die`。没有直接调用伤害函数冒充吞噬触发。

人工检查 [Chomper 吞噬后画面](shots/codex3-chomper.png)，植物身体可见。截图为暂停后的受控场景。第二页文件与构建复制校验见回归检查。

### 2. P1：旗帜预警未门控出生 — 部分修复，仍未关闭

在冷启动 1-10 的 assets/audio 上创建隔离 Board，设 `waveIndex=9,waveCountdown=6`，其他预警状态保持初始值。以触发预警的那次调用为 n=0，随后连续执行原函数。

**单独调用 `updateWaves()`：符合本轮要求。**

- n=0：`wave=9,count=5,warning=750,zombies=0`。
- n=1：`wave=9,count=5,warning=749,zombies=0`。
- n=749：`wave=9,count=5,warning=1,zombies=0`。
- n=750：`wave=9,count=1,warning=0,zombies=0`。
- n=751：`wave=10,count=4500,warning=0,zombies=14`。

**同样初始条件改为调用正常入口 `update()`：失败。**

- n=0：`wave=9,count=5,warning=750,zombies=0`。
- n=1：`wave=9,count=5,warning=748,zombies=0`。
- n=374：`wave=9,count=5,warning=2,zombies=0`。
- n=375：`wave=9,count=1,warning=0,zombies=0`。
- n=376：`wave=10,count=4500,warning=0,zombies=14`。

根因是 `src/game/board.ts:512` 的旧递减仍存在，同时新增 `board.ts:579-582` 在 `updateWaves()` 内再次递减。实际 shell 每次固定步进调用 `board.update()`（`src/shell.ts:182` 附近），故不是仅测试入口的差异：预警只维持约 **3.75 秒**，不是数据规定的 7.5 秒。旧版“仅等 1 tick”已改善，但不能据局部函数通过就关闭 P1。修复方向是明确预警计时的唯一更新位置，并保留完整入口的回归测试；本轮未改代码。

对照 `docs/spec-levels.md:153-155` 和本机 `D:/逆向/output/PlantGirlsVsZombies/decompiled/Lawn/Lawn/Board.cs`：原版预警计数由 `UpdateZombieSpawning()` 的一个分支递减，零时置波次倒计时为 1，没有网页当前这两个递减点。源码边界补充：原 C# 在预警归零后还会继续执行下方普通倒计时，所以其整次调用边界与本轮明确要求的“置1、下一 tick 出生”并非完全相同；此处按本轮要求验收该边界，**重复递减导致 375 tick 的问题在两种解释下都成立**。

健康加速没有失效：隔离 Board 设 `waveIndex=1,waveStartTick=0,tickCount=401,waveCountdown=2000,nextWaveHealthThreshold=100`，一只普通僵尸受控设为 HP=50。调用 `updateWaves()` 后 countdown=200。另测 age=400 时仅降至1999，age=401 时压到200，严格大于400的门槛仍有效。

### 3. P2：Reanim 插值跳变 — 已修复

浏览器导入现有 `/src/reanim.ts`，构造仅一轨三帧的合成文档 `tx=[0,10,20]`，`animStart=0,animCount=3,loop=loop`，设 `animTime=t/2` 后调用运行时可访问的 `frameSample()`，按现有 draw 中相同的 lerp 公式计算 tx。

- t=0.49 / 0.51 / 0.99 / 1.01 / 1.99 / 2。
- interpolate=true：tx=**4.9 / 5.1 / 9.9 / 10.1 / 19.9 / 20**，before=0/0/0/1/1/2。
- 同一文档改为 interpolate=false：frac 全为0，tx=**0 / 0 / 0 / 10 / 10 / 20**。

开启插值时单调且跨半帧/整帧无旧版跳变；关闭时按整帧阶梯采样。`src/reanim.ts:100-112` 已统一 floor(t) 与小数余量，并读取 `doc.interpolate`。直接读取反编译 `Sexy/TodLib/Reanimation.cs:601-604`：先 `(int)num2`，再将整数值加0.5后转short，对非负帧轴等效 floor，修复与该语义一致。`docs/spec-reanim.md:350` 的公式也已纠正；但该文档开头第29行仍残留 round 的旧概述，建议同步文字，未列为运行时缺陷。

### 4. P2：菜单状态清理遗漏 __getState — 已修复

实际 CDP 鼠标输入：冷启动 1-1、URL指定9999阳光，点击 `(40,46)` 选豌豆、`(280,330)` 种植，截图确认主局已有植物；随后点击真实菜单按钮 `(850,20)`，等待500 ms，再检查全局。

结果：`typeof __board / __SHOT_STATE__ / __getState` 均为 `undefined`，对三者 `Object.hasOwn(window,key)` 均为 false，shell 的 board 为空。页面已回主菜单，shot 未再输出旧局 STATE。见 [点击前主局](shots/codex3-hud.png)、[菜单](shots/codex3-menu.png)。`src/shell.ts:146-151` 已统一删除三项全局，toMenu/toLevelSelect 均调用该清理。

### 5. P2：射击动画提前截断 — 已修复

隔离 Board 种 Peashooter，同行 Normal 放在x=700，plant.timer=0，连续调用原 `updatePlants()` 550次，保留目标，不推进弹丸伤害以维持连续攻击。

- 发射发生于 i=0/148/297/442，均以 `shooting,trackTime=0` 重启轨道。
- shooting duration=1秒；i=29 时仍为 shooting、trackTime=0.29，即使 fireTimer 已归零也没有提前切 idle。
- i=99 仍为 shooting、trackTime=0.99；i=100 才回 idle。后续每轮亦在发射后100 tick回idle。
- 清除目标后再推进120次，最终 idle。

追加 1-10 三种 Spine 射手探针：Peashooter、Snowpea 连续发射后分别约100、111 tick完成回idle；Repeater 的实际轨道长 **1.500000119秒**，持续有目标时新攻击会重启同名 shooting，550 tick内不必出现idle间隙。单发后移除目标的独立测试中，Repeater 在29、100、149、150 tick仍为shooting，随后完成并回idle，250 tick为idle。没有把同名动画持续不变误判为轨道不重播。双发的延迟子弹不属于这次仅推进 updatePlants 的探针断言。

`src/game/board.ts:830-841` 改由 `currentComplete()` 决定 Spine 回idle；fireTimer归零只控制非Spine路径，修复已落实。

### 6. 波次字段消费 — 指定字段通过，完整更新的预警时长仍受上述 P1 影响

使用 `structuredClone(level)` 创建隔离实例，所有配置哨兵值只写运行时副本，未改 levels.json：

- `hugeWaveCountDownTicks`：真实数据750；副本改13后，在countdown从6变5时得到warning=13，证明读取配置。
- `healthShortcut.minCountDownTicks`：真实数据200；副本改37后，401 tick低血量分支得到countdown=37，证明已消除固定200的唯一来源。
- `flagWaveCountDownTicks`：1-10即将出生的普通第9波后得到2945（在2500..3099范围），刚出生的第10旗波后得到4500，阈值同时由123置0。副本设4321后得到4321。
- 旗波出生后连续401次局部波次更新得到countdown=4099、threshold=0，健康加速没有把它压到200。
- 1-5 flagWaveCountDownTicks=null 的隔离实例，设下一波为最后旗波、countdown=6，仍触发 `count=5,warning=750`，不再把旗波后间隔例外误用为“跳过预警”。其正常 update 同样受重复递减P1影响。

源码对应 `src/game/board.ts:587-588,606,624-635`。本条仅关闭要求核对的三个字段及健康阈值语义，不宣称消费了 levels.json 所有规则字段。

## 新发现问题（无则写无）

### P2：最后一只僵尸被小车击倒后，胜利分支永久保留尸体

**触发与影响：** 小车击倒最后一只存活僵尸会立即满足胜利条件。结果画面继续更新动画，但该僵尸停在死亡末帧，运行中的小车也停在草地上。没有阻断won/返回路径，但不符合第二轮已改善的“胜利后尸体退场”整体表述。

首先在本轮1-1胜利回归中自然触发：只用输入种五行豌豆与原update加速，未注入波次/敌人HP/胜利状态。tick=7491时won，留有一只 `mowed,x≈-7`；再推进1000 tick，仍有同一实体，截图可见尸体与停住的小车。见 [胜利结果](shots/codex3-win.png)。

进一步做确定性隔离复现：运行时关卡副本只保留一波Normal，倒计时设1让原update出生；将该僵尸移至row=2,x=25，小车设running,x=20；下一次原update触发碾压和胜利。结果：

- 进入won：`state=mowed,dieTimer=25,reanim.loop=hold,finished=false,animTime=0`，小车x=23.33。
- 再调用1000次update：仍为mowed、dieTimer=25、finished=false、animTime=1，小车x仍为23.33。

根因：`src/game/board.ts:1083-1087` 给mowed使用hold轨道并依靠25 tick死亡计时；正常分支 `board.ts:905-907` 会递减该计时并移除，但won/lost分支 `board.ts:497-501` 只检查 `reanim.finished`，既不递减计时也不检查其归零。`Reanim.update()` 对hold只钳制animTime，不置dead，所以该尸体永远不满足移除条件。修复应让结束分支保留相应死亡计时清理；本轮未改代码。这是本轮新发现的问题，没有版本差异证据证明由这批修复新引入。

## 回归检查

- **类型/构建：通过。** `npx tsc --noEmit` exit0；`npm run build` exit0，Vite7.3.8、60模块，copy-data完成。没有启动preview或另开服务。
- **构建数据：通过。** data与dist/data各216个文件；逐文件SHA-256检查0缺失、0差异。两侧 `spanim/chomper_2.png` 均656396字节，SHA-256均为 `87FE94F0118F2CFC6A03A383A537950FE8A1149E6852F2EC763AF0E7118488B2`。
- **1-1胜利：路径通过，结束清理有上述P2。** URL指定9999阳光，通过原pointerDown逐行种豌豆，每株间调用原update750次等冷却，再加速推进；种植计数1/2/3/4/5，tick7491进入won、wave4/4、剩4株、sun9499。未直接设置won或修改敌人HP；最后一次碾压留下尸体，未把结果清理判为无回归。
- **1-1失败：路径通过。** 不种植物，受控额外生成3只row=2的Normal，其余波次自然执行；加速原update，tick10360进入lost。存活突破者row=0,x=-36.056，小车已gone。没有直接调用lose或设置lost。见 [失败结果](shots/codex3-loss.png)。这是增怪后的失败路径测试，不是原始随机1-1必败断言。
- **1-5传送带：通过本轮范围。** 实际鼠标点击 `(175,530)` 再 `(280,330)`，免费种Wallnut于col1,row2；sun始终0，卡片被消费。三株预置豌豆原位为(5,1)/(7,2)/(6,3)，Spine身体可见。再受控推进2500次原update，`sun=0,suns=0,sunsFallen=0`，卡片持续补充。见 [开局](shots/codex3-conveyor-start.png)、[实际免费种植](shots/codex3-conveyor-plant.png)、[推进后](shots/codex3-conveyor.png)。未按原版滚坚果玩法验收。
- **HUD与图集：本轮采样无新增异常。** 浏览器按实际assets.view遍历1876个sprite的2093个合法cel，源矩形越界0；实际输入种植后的阳光数字、豌豆、普通僵尸、小车与铲子底座画面可辨，没有复现跨切片杂图。见 [HUD](shots/codex3-hud.png)、[战斗采样](shots/codex3-atlas.png)。未将算术范围检查扩大为全部cel逐帧美术验收；上一轮所述简化进度条/缺旗标等保真限制未在本轮重新验收为完整修复。
- **控制台：** 本轮冷启动1-1/1-5/1-10及上述探针均未报告console error、Runtime exception或Log error。两次独立1-10资源加载均包含正常Chomper info，无失败warning；`ERRORS:none` 本身不被用作可见性结论。

## 未验证项

- 未正常阳光、自然时长逐关通关1-1～1-10；未统计平衡、随机卡池分布、传送带胜率。
- 未逐帧比对所有植物/僵尸动画与原版，未全面验证Chomper的全部动画、目标离开/被别的攻击杀死、所有特殊攻击与撑杆/寒冰组合。
- 未重复第二轮所有已通过项目的完整探针矩阵，例如Tall-nut真实资源（上一轮只做别名分支）、任意高速弹丸扫掠、双发植物被铲除后的待发子弹。
- 未另启dist服务器或外部部署；仅验证构建与落盘资产一致，不能把文件一致等同于所有源资产完整。
- 未覆盖移动端、触屏、多浏览器、高DPI、长时间内存/性能、音频主观体验。
- 没有完整历史版本差异证据；新发现项表示本轮首次发现，不等同于判定其由本次修复引入。
