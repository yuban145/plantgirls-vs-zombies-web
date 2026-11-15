# 第四轮独立复审（收尾）

复审日期：2026-11-15。工作目录：`D:\逆向\plangirls-web`。基线：[第三轮报告](codex-review-3.md)。

## 结论

**通过本轮收尾复审。** 第三轮剩余的 P1（预警双重递减）及 P2（终态碾压尸体与小车不退场）均已关闭；文档 floor 描述已同步。指定回归项通过，本轮未发现新的 P1/P2。

本轮仅写本报告及 `docs/shots/codex4-*.png`，执行构建写入允许的 dist；未修改 src、data、tools。始终使用既有 `http://127.0.0.1:5188/`，未重启服务或另开服务端口。浏览器测试使用 Chrome DevTools；截图均已人工查看。

## 逐项复核

### 1. P1：hugeWaveTimer 双重递减——已修复

冷启动 1-10 后，使用已加载的真实 assets/audio 和关卡、loadout 的运行时副本创建隔离 Board，挂到 `window.__board` 和 shell.board。取消 shell 的 RAF 调度以避免手动计数期间混入后台 tick，保持原方法实现。初始 `waveIndex=9,waveCountdown=6,hugeWaveTimer=0,zombies=[]`，后续**逐次调用 `window.__board.update()`**，未以局部 updateWaves 代替验收。

以触发预警的调用为 n=0；n 表示其后经过的 tick 数，故 n=750 是包含触发调用在内第751次 update：

- n=0：tick=1，wave=9，countdown=5，warning=750，zombies=0。
- n=1：tick=2，wave=9，countdown=5，warning=749，zombies=0。
- n=374：tick=375，wave=9，countdown=5，warning=376，zombies=0。
- n=375：tick=376，wave=9，countdown=5，warning=375，zombies=0，未复现第三轮提前归零。
- n=749：tick=750，wave=9，countdown=5，warning=1，zombies=0。
- n=750：tick=751，wave=10，countdown=4500，warning=0，zombies=14。

对 n=1..749 每次调用均断言 wave=9、countdown=5、warning=750-n、zombies=0，违例数 **0**。预警完整持续750 tick（100Hz下7.5秒）；归零当次经过普通倒计时的1→0并出生，不再多等一次调用。截图：[第750 tick出生](shots/codex4-wave.png)；截图只证明出生画面，时长结论来自上述逐tick断言。

静态复核：`src/game/board.ts:586` 是唯一 `hugeWaveTimer--`；update 顶部已无递减。其他写入为字段初始化和 `board.ts:614` 的预警赋值。`board.ts:585-591` 归零设置 countdown=1 后继续执行下方递减，与本机反编译 `Board.cs` 的 UpdateZombieSpawning 预警分支一致。本轮按最新明确要求验收“归零同次出生”，取代第三轮报告采用的下一次调用边界。

### 2. P2：won/lost 尸体及 running 小车清理——已修复

分别建立 won、lost 隔离场景。通过真实 `spawnZombie` 生成两只 Normal；一只放至小车前由原 updateMowers 造成 mowed（hold动画），另一只由原 damageZombie 致死形成 die。随后仅在隔离探针中设置终态，推进原 `window.__board.update()`，观察到两分支结果一致：

- n=0：mowed timer=25、die timer=220，二者 finished=false；小车 running，x=23.33。
- n=1：计时分别24、219；小车x=26.66。
- n=24：mowed timer=1，实体仍存在。
- n=25：mowed 已移除；die timer=195。
- n=234：尸体数量0，小车 x=802.55、state=gone。
- n=1000：仍为尸体0、小车gone，无再次移动或残留。

另对 won/lost 各做一次动画完成条件探针：保留正值 dieTimer，将死亡动画标记 finished，下一次原 update 即移除，确认“计时归零或动画完成”两条条件均有效。该探针为受控条件注入，不视为完整动画时长验收。截图：[终态清理](shots/codex4-terminal.png)。

追加第三轮原问题的完整因果复现：运行时关卡副本仅一波 Normal，waveCountdown=1，通过原 update 出生；设置该僵尸 row=2、x=25，小车 running、x=20，下一次原 update 自行触发碾压及胜利，未设置 won。进入胜利时 `mowed,dieTimer=25,mower.x=23.33`；再1000次原 update 后 `won,zombies=0,mower=gone,x=802.55`。见[最后一只被小车碾压后的胜利](shots/codex4-mower-win.png)。

源码 `src/game/board.ts:497-513` 已在 won/lost 分支递减 die/mowed 的 dieTimer，倒序移除实体，并推进 running 小车至 x>800。ready 小车保留是正常待机状态，不计作运行中小车残留。

自然波次胜利另见下方回归：只通过种植输入和原 update 加速，不注入胜利、波次或敌人血量；胜利后尸体也正常清零。

### 3. spec-reanim 的 floor 文字——已修复

`docs/spec-reanim.md:29` 已写为 `floor(frameStart + N*animTime)`；第349-350行 frac/before 仍一致采用 floor。文档内提及旧 round(t) 的纠错说明不构成残留错误；其他 sprite cel 取 round 的独立语义未混同为 Reanim 时间采样。运行实现 `src/reanim.ts:100-112` 仍使用 floor 与小数余量。

## 新发现问题

无。本轮没有把未验证范围或既有移植保真限制重新列为新增缺陷。

## 回归检查

- **类型/构建：通过。** `npx tsc --noEmit` exit 0；`npm run build` exit 0，Vite 7.3.8、60模块、copy-data完成。未另启 dist 服务。
- **构建资产：通过。** data 与 dist/data 各216文件；逐文件SHA-256比对，0缺失、0差异。`chomper_2.png` SHA-256 为 `87FE94F0118F2CFC6A03A383A537950FE8A1149E6852F2EC763AF0E7118488B2`。
- **1-1胜利：通过。** URL仅使用既有 `sun=9999` 测试入口。冷启动后停止RAF自动推进，原 pointerDown `(40,46)` 选豌豆，以草地坐标逐行种植；每当真实750 tick冷却完成，优先补植物较少的一行，原 update 连续推进。未改波次、敌人HP、计时器或终态。tick=7526自行进入 won、wave=4/4、9株；当时最后一只为die。再推进1000 tick至8526，zombies=0，五辆小车均ready，没有running小车停住。人工检查[胜利结果](shots/codex4-win.png)无尸体。此随机运行未使用小车，碾压胜利覆盖由上方独立因果探针提供。
- **1-1失败：通过。** 另一轮同样只使用输入种五行单列豌豆，每次种植后调用原 update 等冷却，随后继续原 update 加速。自然随机波次在tick=7551进入lost、wave=4/4，row2小车gone、两只存活僵尸；再1000 tick维持lost，未注入敌人/HP/失败状态。见[失败结果](shots/codex4-loss.png)。这说明单列布阵并不保证随机胜利，不作平衡缺陷判定；失败后的存活僵尸不属于待清理尸体。
- **胜利返回：通过。** 自然胜利后调用原 draw 满足既有结果展示门槛，再以原 pointerDown 点击结果返回；shell.board=null、menu.tabs=levels，三项调试全局均删除。截图[关卡选择](shots/codex4-result-return.png)为追加碾压胜利返回后的同一路径。
- **1-5传送带：通过。** 在RAF已停止的shell中重新 startLevel(4)，从tick=0检查：预置Peashooter `(5,1)/(7,2)/(6,3)` 均有Spine；初始Wallnut卡1张，sun=0。原 pointerDown `(175,530)`、`(280,330)` 免费种Wallnut至col1,row2，卡片1→0、sun仍0。连续2500次原 update 后state=playing、sun=0、suns=0、sunsFallen=0、卡片补至6张。见[传送带推进后](shots/codex4-conveyor.png)。此期间植物可被正常攻击，小车可触发；不要求预置植物始终存活。
- **Chomper可见及吞噬：通过。** 冷启动1-10加载资源，在隔离Board用原 addPlant 受控生成Chomper于col2,row2，Spine非空、活动附件53，人工检查[Chomper截图](shots/codex4-chomper.png)本体可见。受控同行Normal移至plant.x，原 updatePlants 触发windup/timer70；再70次进入digest/timer4000，Normal为die、HP=-99729。未直接调用伤害函数替代吞噬触发。
- **图集采样：通过本轮范围。** 浏览器实际 assets.view 遍历1876个sprite、2093个合法cel，源矩形越界或缺失数0。人工检查本轮战斗、传送带、Chomper和结果截图，HUD数字、普通/路障僵尸、植物、小车、卡片及铲子可辨，未发现跨切片杂图。未将范围检查等同于全部帧美术验收。
- **菜单清理：通过。** 1-5原 pointerDown `(850,20)` 后，`__board/__SHOT_STATE__/__getState` 类型均undefined，Object.hasOwn均false；shell.board=null、menu.tabs=main。因RAF暂停，手动调用现有menu.draw刷新截图，未把未刷新的旧画面当成菜单结果。见[主菜单](shots/codex4-menu.png)。
- **控制台：通过。** 各次1-1/1-5/1-10加载及上述探针后检查Chrome控制台error/warn，均无消息；未见运行时异常。未以“无error”替代画面检查。

## 未验证项

- 未在正常阳光、自然时长下逐关通关1-1至1-10；未统计随机胜率、卡池分布或平衡。加速为原update的同步重复执行，不是修改游戏逻辑。
- 未重跑第三轮全部局部探针（健康加速完整字段矩阵、所有射手动画等），本轮静态确认与指定运行回归不能替代全量验收。
- 未全面逐帧对照原版动画、所有图集cel视觉、特殊僵尸组合及Chomper全部动作边界；未按原版滚坚果玩法验收传送带。
- 未验证移动端、多浏览器、高DPI、长期内存/性能、音频主观体验或外部部署；dist仅构建及文件一致性校验。
- 目录无Git仓库元数据，无法给出提交级历史差异归因；上述结论针对当前文件及本轮实测行为。
