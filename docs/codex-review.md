# Codex 验收报告（gpt-6.1-sol, reasoning=medium）

## 结论（通过 / 有条件通过 / 不通过）

**不通过。** 基础模拟可以运行，类型检查和内存生产构建通过，实测控制台无错误；但图集采样、植物可见性、传送带关卡、撑杆行为、命中顺序及射击动画存在影响交付的缺陷，不能按 README 所述范围验收。

验收日期：2026-11-15。使用已运行的 `http://127.0.0.1:5188/`，未停止服务、未另启服务端口、未提交或修改被审查代码。只新增本报告和 `docs/shots/codex-*.png`。引用行号以本次工作树为准；修法仅为建议，未实施。

验证方法：静态阅读 README、三份主要规范、全部运行时代码及相关数据管线；Python 内存检查全部资源清单/150 份 Reanim；真实 Chrome/CDP 交互与截图；浏览器内创建隔离 Board 实例进行边界测试。胜负测试直接重复调用现有 `Board.update()` 加速推进，未手动设置胜负或消灭敌人；它证明模拟路径，不代表同等时长的自然帧率测试。

## 必改问题（P0/P1；逐条：现象 + 证据(file:line 或截图) + 具体修法）

本次未发现 P0。以下均为 P1。

1. **图集把逻辑尺寸直接当纹理采样尺寸，阳光、小推车和僵尸出现串图/碎片。**
   - 现象：阳光周围出现绿色字形和其他部件，小推车叠出额外轮子，僵尸肢体破碎。见 [本次运行截图](shots/codex-run.png)，历史 `final-03-gameplay.png`、`final-04-battle.png` 同样存在。
   - 证据：`tools/build_assets.py:121,137-141` 原样复制 UNPACK_INFO，却将矩形声明为 texture pixels；`src/assets.ts:184-192`、`src/reanim.ts:147` 和 `src/assets.ts:211` 都没有转换 `invScale`。1876 个切片中，1752 个为 0.8、10 个为 2、1 个为 4；按当前采样方式有 **97 个矩形越界**（PlantsZombies 60、SunFlower 22、Particles 8、Loc_en 7）。例如 `data/sprites.json:8031` 的 CherryBomb LEFT1：x=2006、w=51，采样右缘 2057 超过 2048。
   - 原因核实：原 C# `Sexy/PrimitiveBatch.cs:109-117` 的 UV 为 `(source + atlasOffset/invScale) * invScale / textureSize`，因此源切片宽高应乘 `invScale`，绘制逻辑尺寸保持不变。按该公式检查，**全部矩形均在纹理内（0 越界）**。这不是原素材本身越界。
   - 修法：在资源层明确区分 source texture rectangle 和 logical destination size；源 cel 偏移/尺寸乘 `invScale`，目标仍用逻辑宽高。同步修正普通精灵、Reanim、过滤缓存及直接调用 drawImage 的路径；重新验证全部边界。不要通过裁短越界矩形掩盖比例错误。

2. **非 Spine 植物始终不可见；1-5/1-8/1-9/1-10 冷启动还会漏载整个默认卡组的动画。**
   - 现象：种植已扣费、占格、保留 HP，但植物没有身体。冷启动 1-4 实种 Wallnut 和 Cherrybomb，两者均 `spine=false,reanim=false`，阳光从 9999 减到 9799；见 [固定卡组不可见截图](shots/codex-fixed-invisible-banner.png)。冷启动 1-8 实种 Peashooter，同样两个动画句柄都为 false；见 [1-8 不可见截图](shots/codex-invisible-level8.png)。
   - 证据：`src/game/board.ts:909` 只读取 `legacyResourcePath`。而 `data/plants.json:228-230,291-293,499-501` 的坚果/樱桃/土豆雷主路径位于 `resourcePath`，legacy 为 null。`board.ts:233-267` 的预加载又只遍历 `seedBank.packets`；该字段在 playerChosen/conveyor 关为 null，`board.ts:273` 却事后换成六张默认卡。1-8 冷启动实测 Spine 缓存为空，Reanim 仅 LawnMower/Sun/Puff/Zombie。
   - 修法：统一解析本局实际种子集合，供预加载和卡组初始化共用；非 Spine 优先使用 `resourcePath` 的 reanim 路径，Spine fallback 才取 legacy。传送带同时预载 initialCards、cardPool、预置植物。对每个可用种子断言至少一种可绘制动画已加载。该问题也影响种植预览。

3. **1-5、1-10 没有实现传送带玩法，1-5 的三株预置植物丢失。**
   - 现象：两关被当作普通阳光购买关；1-5 开局只有 50 阳光、六张默认付费卡、零植物。运行到 tick=2514 已自然落阳四次。见 [1-5 截图](shots/codex-level5.png)。
   - 证据：`board.ts:271-278` 不检查 seedBank.kind；`board.ts:384-394` 无条件落阳；构造函数未消费 special.prePlantedPlants。规范 `docs/spec-levels.md:187-234,259-270` 明确 1-5/1-10 的传送带、权重、补卡间隔、初始卡及 1-5 的 `(5,1),(7,2),(6,3)` 三株 Peashooter。JSON 已提供这些字段。`board.ts:468-518,623-630` 也没有 Chomper 吞食和 ExplodeONut 死亡爆炸分支。
   - 修法：按 kind 实现传送带卡片生成、消费和免费种植，禁止自然落阳及常规购买冷却，应用预置植物，并补上相应特殊攻击/滚动坚果逻辑。用原规范分别验收 1-5 与 1-10，不能仅替换卡组名称。

4. **撑杆僵尸不跳跃，直接啃植物且一直保留撑杆前速度。**
   - 证据：`board.ts:553-607` 对所有种类统一行走/啃食，没有 vault 状态；数据里的 special.vault 未消费。隔离实例中让 Polevaulter 接触坚果，推进 100 次 updateZombies 后仍 `state=eat,x=270`，坚果 HP=3900。规范 `docs/spec-levels.md:383-399` 要求跳过前方植物，来源为原 `Zombie.cs:2534`。
   - 修法：增加接近、起跳、落地、失杆后的状态和速度转换，衔接对应动画与碰撞规则，并验证 1-6/1-7/1-9/1-10 的撑杆波次。

5. **弹丸按僵尸创建顺序命中，重叠时会越过前方敌人伤害后方敌人。**
   - 证据：`board.ts:641-648` 对数组调用 find，没有按弹道距离选择。隔离测试按顺序放入 x=300、x=290 的同排普通僵尸，弹丸从 x=320 推进一次；结果 x=300 的 HP 从 270 降到 250，较近的 x=290 仍为 270。两者均与弹丸包围盒重叠。
   - 修法：在同排有效候选中选择运动方向上的首个碰撞，最好用本 tick 移动线段求最早交点；保留死亡/被碾压排除条件。补充不同出生顺序、不同速度追叠时的检查。

6. **Spine 植物首次射击结束后停在末帧，后续射击不会重播。**
   - 证据：`src/spine.ts:81-93` 遇到相同动画名直接 return，shooting 使用 loop=false；`board.ts:545-547` 不断请求同一 shooting，却没有完成后回 idle 的逻辑。实测 shooting duration=1 秒，推进到 trackTime=2 后 complete=true；再次 playAttack，trackTime 仍为 2，current 仍是 shooting。`playIdle()` 在游戏侧没有调用点。
   - 修法：攻击完成后回 idle，新的攻击事件允许重启相同的非循环动画；如果连续攻击需要混合，使用 track entry/队列管理，避免仅靠名称去重。验证至少三次攻击及无目标后的待机。

7. **波次调度未消费已提取的规则，旗帜预警时机和清场后的节奏错误。**
   - 证据：`board.ts:396-417` 只有固定 2500+random/4500 倒计时，没有剩余血量阈值和 >400 tick 后缩至 200 tick 的分支。下一波为旗帜波时，在上一波刚出生便将 hugeWaveTimer 设为 750，显示提前后消失；旗帜出生时又显示 300，而非 countdown=5 触发预警并等待 750 tick。规范见 `docs/spec-levels.md:145-165`。
   - 修法：把 zombieSpawning 的血量、起始倒计时、快捷倒计时、旗帜延迟等字段纳入运行时模型，记录本波起始 HP/年龄，按规范实现预警状态。`board.ts:430,453` 的 initialDelay 实际未生效；原规范为同步按 slot 出生，应删除误导参数或依据明确规则实现。

## 建议改进（P2）

- **HUD 与原版布局核对。** 原截图 `original-play5.png` 为带窗口装饰的 1616×939 图，游戏客户区约为 `(8,31,1600,900)`；依据规范，客户区内应先扣左右 50 px，再除以 1.5 还原到 1000×600。直接把整张图缩到 1000×600 会得到错误测量。以下数值以代码和规范锚点为准，未把不同游戏阶段强行逐像素相减。
  - 草坪：web 网格原点 `(140,80)`、80×100、9×5，总范围 720×500，与 `spec-render.md:103-168` 的常规白天关布局相符。原 play5 处在 1-1 教学阶段，只有中间一行草地、一辆车；`final-03/04` 是五行全草地、五辆车。两者存在明显玩法/阶段差异，不能宣称 1-1 画面忠实复现。需补教学行限制，或明确将教学阶段列为未移植。
  - 种子栏：x=0、首卡 y=20、间隔77、卡片逻辑81×106与52高的点击区域基本沿用规范；与原 play5 的单卡位置近似一致。web 新增了宽86的暗色背板（`board.ts:1162-1166`），原参考没有同样的矩形底板；不能判定整块背景为像素一致。种子包肖像占据上方区域，而当前 packetAt 仅接受 top..top+52；可对照原版最近中心命中算法改善点击体验。
  - 阳光板：外框 `(119,0,143,44)` 与规范一致；原参考为金黄日光和黑色数字，web 为蓝色贴图、浅黄描边数字。字体26及基线策略不同（`board.ts:1216-1231`）；规范文本锚点是 `(211,3)`，当前用 middle `(211,22)`，应结合原字体渲染语义对齐，不能简单把两种锚点的19px当作实测位移。
  - 旗帜条：框体 `(450,3,237,40)` 一致，但 `board.ts:1254` 只把进度映射到 **150px**，规范填充应到 **225px**。满进度少75px，半进度少37.5px；头部却沿220px移动，头与填充不同步。`progressFraction()` 只取 wave/总波数，没有波内倒计时/HP 插值；还未绘制各旗帜标记。应使用规范 `spec-render.md:350-382` 与 `spec-levels.md:167-176` 的两级映射。原 play5 没显示进度条，故这里的精确偏差来自规范及代码，而非该参考图的直接测量。
  - 关卡横幅：`board.ts:1346-1347` 锚点 `(891,585)`，规范为 `(891,565)`，**明确下移20px**；字体24也未证明与原 FONT_HOUSEOFTERROR16 等价。末15 tick 的 alpha 还用了额外 +0.35，不能平滑淡到零。截图 [固定卡组与横幅](shots/codex-fixed-invisible-banner.png) 保留了开局横幅（暂停遮罩覆盖其上）。原 play5 本身未显示横幅，此项以规范为依据。
  - 顶部按钮：原规范45高，web绘制42高，少3px；鼠标区仍使用 y<50。铲子仅绘制了普通 IMAGE_SHOVEL，缺少原版底座和植物娘铲子组合（`board.ts:1330` 对照 `spec-render.md:339-347`），也没有铲除输入分支；README 的“铲子位”不应理解成已实现铲除功能。
  - 标题：`final-01-menu.png` 使用草坪背景、纯文字标题和居中按钮；`original-title.png` 是树木/天空/墓碑/人物场景，且当时有“新用户”对话框。`src/scenes/menu.ts:31-90` 完全重画了场景，属于整体布局替换，远大于2–3px偏差；应恢复原场景或明确标为重新设计。对话框因已声明无存档而不计为新缺陷。`final-02` 也是自制选关 UI。`final-05-end.png` 实际仍是战斗画面，不能作为胜负验收证据。

- **铁桶破甲后贴图不消失。** 数据使用 zombieType=Pail，`board.ts:667` 却只认 Buckethead，错误隐藏 anim_cone。实测 Pail 的 helmHp 已为0，但 hidden 中没有 anim_bucket。统一标准枚举/别名，验证路障和铁桶分别脱落；护甲数值吸收本身正确。

- **Reanim 未实现插值。** `src/reanim.ts:69-73,98-103` 四舍五入取整帧，忽略文档 interpolate 与隐藏边界；与 `docs/spec-reanim.md:355-357,587,654-656` 不符。补 before/after 的平移、缩放、角度、透明度插值，保持图像字段离散选择。README 的“完整实现”应在修正前收窄。

- **每帧构造完整动画实例。** `board.ts:1074-1079` 每画一辆小车都 new Reanim 并重建 Map，且每帧重置时间，只推进0.01秒，车辆动画无法连续播放。`board.ts:1119` 的预览每帧 new SpineChar，内部重建 Skeleton/AnimationState；它的分配成本比普通数组大。缓存小车和选中卡的预览实例，在 update 中推进。`board.ts:941-950` 的每帧 filter/flat/map 诊断状态也可降频或仅调试启用。本次未测得足以判定泄漏的长时 heap 曲线，不把这些分配等同于内存泄漏。

- **资源覆盖范围与错误可见性。** 150 份 Reanim 中51份存在无法从 manifest sprites/images 命中的名称，合计5248个不同缺失 ID。主要是未移植的角色/场景、Spine legacy 素材或占位图，不应全部算作当前玩法阻断。Zombie、Zombie_polevaulter、Sun、LawnMower、Puff 的引用均命中；PeaShooter 中有155个缺失 ID，Chomper 有380个，后续启用这些 fallback 前须补齐。`Assets.reanim()` 失败返回 null，image.decode 失败被吞掉，渲染又静默跳过，所以“控制台0错误”不能证明资源完备。建议按可达动画闭包检查并报告缺失。

- **结束与菜单后的状态清理。** 胜利后 `board.ts:353-363` 不再递减 dieTimer 或移除死亡僵尸；受控测试 dieTimer 在胜利更新后仍为220。应让终态装饰对象完成退场。`shell.ts:146-158` 返回菜单没有清空 window.__board / __SHOT_STATE__；实测菜单已激活、实际 board=null，两个调试对象仍指向旧战斗，导致状态采集误判并保留最后一局对象。

- **细小模拟偏差。** `board.ts:390-391` 先 sunsFallen++ 再计算倒计时，比规范原顺序多10 tick；阳光点击区域为中心±50，即100×100，规范为43×43外扩50，即143×143（`spec-render.md:456-475`）。双发射手在同一 tick 生成两弹并偏移18px（`board.ts:534-543`），未按数据 secondShotTriggerCounter 延时。当前默认卡组不含 Repeater，后续补传送带后需验证。

- **生产部署包不自包含。** `vite.config.ts:29-54` 通过开发/preview 中间件从仓库 data/ 供图；本次内存构建产物仅 index.html 和两份 JS，未包含 data/。部署 dist 到普通静态托管会缺少资源。应给出明确的 data 发布/拷贝步骤，或提供构建时资产打包策略；本次未实际部署。

## 已验证通过项

- **TypeScript**：执行 `npx tsc --noEmit`，退出码0。
- **生产转换/打包**：使用 Vite 实际读取现有配置，执行内存构建：`node --input-type=module -e "import {build} from 'vite';const r=await build({configLoader:'runner',build:{write:false,emptyOutDir:false}});console.log(r.output.map(x=>x.fileName))"`。Vite 7.3.8，60个模块，成功输出 index.html 和两份 JS，无打包报错。没有写入 dist 或配置缓存。
- **资源基础完整性**：5张 atlas、1876个切片、6份独立图片记录；所有声明纹理文件可解码，实际宽高与 manifest 一致。全部150份 Reanim JSON 可解析。图集问题为采样尺度语义错误，见 P1-1。
- **真实时钟/CDP 冒烟**：按要求执行 shot.mjs，URL 为 `?autostart=1&level=1&sun=9999&speed=3`，等待5秒、点击 `(40,46)`、等待400ms、点击 `(280,330)`、再等待20秒。结果 `[codex-run.png](shots/codex-run.png)`，`ERRORS: none`；状态为 playing、sun=9899、wave=2/4、zombies=1、plants=1、suns=2、tick=6441。能选卡、种植、推进波次并绘制僵尸。
- **种植/冷却**：一次 Peashooter 扣100阳光，cooldown=750；紧接着再点同卡不能多种或多扣费。静态核对空格/边界/阳光不足检查存在。
- **阳光收集**：点击现场阳光后等待动画结束，sun 从9899变9924，准确增加25；收集状态避免重复点击记账。自然落阳存在，同行射手能发射。
- **暂停/倍速/菜单**：点击暂停后，等待700ms，tick 保持6354；点击画面继续，状态恢复 playing；倍速从3切到1；菜单按钮回到主菜单，实际 GameShell.board 变为 null。调试状态残留另列 P2。
- **受控模拟数值**：隔离实例验证豌豆生成1枚、伤害20；普通僵尸270→250；接触植物首咬300→296；正常运行中死亡对象可移除。寒冰命中 chillTicks=1000，移动距离为原速度×0.4（实测0.134581819，与期望一致）。未将这些局部通过扩大为所有特殊单位通过。
- **胜利路径**：重新进入1-1，用真实种植输入放置五行射手，每张间推进750个原模拟tick等待冷却；继续调用 update，tick=12170 时自然得到 won、wave=4/4、plants=5、全部小车 ready。见 [胜利截图](shots/codex-win.png)。没有强制修改 wave/HP/胜负状态；使用9999初始阳光，且该测试不是自然时间完整通关。
- **小车与失败路径**：重新进入1-7、不种植物、加速调用原 update，tick=10387 时自然 lost、wave=3，小车状态 ready/gone/gone/ready/ready，突破僵尸 x=-36.2397。证明小车触发、运行耗尽与房屋失守路径可达。见 [失败截图](shots/codex-loss.png)。
- **控制台**：上述交互以及1-4、1-5、1-7、1-8导航的 Chrome 控制台检查未见 error/warn；shot.mjs 同时监听 Runtime 异常与 Log error，也报告0错误。可见性错误仍可静默发生。

## 未能验证项

- **未原样运行 `npm run build` 的写盘阶段**：脚本会写 dist/，Vite 默认配置加载还可能写 node_modules/.vite-temp；与“唯一允许写报告和截图”冲突。本次完成该脚本的 tsc 检查及等价 Vite 生产内存构建，未验证磁盘写出、dist 预览或部署后的资源路由。
- 未逐一自然时间通关1-1到1-10；未验证正常初始阳光下的全关卡平衡。1-5/1-10 已存在玩法缺失，不能据模拟能到结果页认定移植正确。
- 未对真实原游戏进行新的操控/录制。原 play5 是教学单行局，title 带新用户弹窗；原截图没有可比较的旗帜条/横幅画面。报告对这些元素采用已提供规范，未声称其参考截图达到2–3px测量精度。
- 未做移动端、触屏、浏览器兼容矩阵、高DPI全组合测试；未进行长时内存泄漏和帧率基准。每帧分配结论来自代码审查。
- 未主观听音频、验证原版音效一致性。合成音效、无存档、无选卡界面等 README 已声明限制不重复当作新 P1。
- 未重新生成资产/关卡、运行会写 data/ 的管线；只读核对了清单、引用、尺寸和关键 C# 原始采样公式。未对150份 Reanim 的每一帧做原游戏视觉比对。
