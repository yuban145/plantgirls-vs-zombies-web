# Adventure mode levels / wave spawn spec — PlantGirlsVsZombies (PGvZ 1.3.2)

逆向对象：`D:\逆向\PlantGirlsVsZombies`（主程序 `Lawn.exe`，.NET 6 单文件）；
反编译源码：`D:\逆向\output\PlantGirlsVsZombies\decompiled\Lawn\`。
本文件说明 `data/levels.json`、`data/plants.json`、`data/zombies.json` 的生成口径、
原版关卡/波次/选卡/背景/落阳逻辑，并给出代码行号引用。

数据生成脚本：`tools/extract_levels.py`（`python extract_levels.py`），脚本同时打印摘要。
所有 JSON 中的 `_source: {file, line}` 都指向 `decompiled\Lawn\` 下的**反编译文件与行号**。

---

## 0. 时间单位（tick）

- MonoGame 固定步长：`Sexy/Main.cs:39` `base.TargetElapsedTime = TimeSpan.FromSeconds(0.01);`
  → **1 tick = 10 ms，100 ticks/s**。
- 游戏内所有倒计时/动画/攻击间隔都以 tick 为单位（`Board.mMainCounter++` 每帧一次，`Board.cs:10049`）。
- JSON 中的 `*Ticks` 均可除以 100 得秒；必要时同时给出 `*Seconds`。
- **1 格（grid cell）宽度 = 80 px**（`Constants.cs:3026` `Board_GridCellSizeX = 80`；
  `Board.GridToPixelX()` `Board.cs:5501`），僵尸速度写作 px/tick。

## 1. 数据范围与本轮结论

| 项 | 结果 |
| --- | --- |
| 关卡 | Adventure 第 1..10 关（世界 1 “Day”），首次通关流程 |
| 波次数 | `GameConstants.gZombieWaves[level-1]` = 4,6,8,10,8,10,20,10,20,20（`GameConstants.cs:787`） |
| 旗帜波 | 首次 Adventure 且 `mNumWaves<10` 时 `wavesPerFlag=mNumWaves`，否则 10（`Board.cs:12977`）；第 1 关例外：`IsFlagWave` 恒 false（`Board.cs:11775`）→ 1-1 无旗帜波；1-2/1-3/1-5 只有最后一波，1-4/1-6/1-8 第 10 波（index 9）为旗帜波；1-7/1-9/1-10 第 10、20 波（index 9、19）为旗帜波 |
| 选卡 | 首次 Adventure 第 1..7 关固定种子库；第 8、9 关玩家选卡（6 张）；第 5、10 关为传送带（不选卡） |
| 背景 | 第 1..10 关全部 `BackgroundType.Num1Day`（`Board.cs:9444`），资源 `IMAGE_BACKGROUND1` → `images/background1_hd`（`Content/resources.xml:331`） |
| 初始阳光 | 首通第 1 关 150，其余 50（`Board.cs:1632` 起） |
| 自然落阳 | 白天：初始 `RandRangeInt(425,700)`，之后 `min(950, 425+numSunsFallen*10)+NextNumber(275)`；夜晚关卡不落阳 |

> 首次 Adventure 第 11..50 关使用同一 `Board.PickZombieWaves` 代码路径，但 15/20/25/30/35/40/45/50
> 等特殊关会转到 `Challenge.InitZombieWaves()`，且选卡/解锁集合受存档购买影响，本轮未展开。
> 后续扩展只需在脚本里把 `--levels` 改成 `11-50` 并为特殊关补充 Challenge 分支。

## 2. 波次生成（Board.InitZombieWaves / PickZombieWaves）

### 2.1 调用链

`Board.InitLevel()`（`Board.cs:1571`）
→ `PickBackground()`（`Board.cs:1617`）
→ `InitZombieWaves()`（`Board.cs:9864`）
→ 首次 Adventure/Quickplay 走 `InitZombieWavesForLevel(mLevel)`（`Board.cs:9891, 10099`），
用 `CanZombieSpawnOnLevel()` 得到本关允许的僵尸集合（`Board.cs:9323`）
→ `PickZombieWaves()`（`Board.cs:8392`）生成本关全部波次的僵尸列表 `mZombiesInWave[wave][slot]`
→ `UpdateZombieSpawning()`（`Board.cs:7297`）按倒计时调用 `SpawnZombieWave()`（`Board.cs:2601`）
→ `SpawnZombieWave()` 按 slot 顺序 `AddZombie()`。

### 2.2 允许的僵尸（CanZombieSpawnOnLevel）

`Board.cs:9323`：

1. Yeti 单独处理，首通 Adventure 下 `CanSpawnYetis()` 为 false（`LawnApp.cs:2797`）。
2. `level < ZombieDefinition.mStartingLevel` → 不允许。
3. `mPickWeight == 0` → 不允许（Flag 因此不会被随机权重选中）。
4. 非“困难 Adventure”下，`ZombieType >= RobotTitan` → 不允许。
5. 最后查 `GameConstants.gZombieAllowedLevels[type].mAllowedOnLevel[clamp(level-1,0,49)] != 0`（表在 `GameConstants.cs:797`）。

首通 1..10 关允许集合（JSON `allowedZombies` 同源）：

| 关卡 | 允许僵尸 |
| --- | --- |
| 1-1 / 1-2 | Normal |
| 1-3 / 1-4 | Normal, TrafficCone(路障) |
| 1-5 | Normal, TrafficCone |
| 1-6 | Normal, TrafficCone, Polevaulter(撑杆) |
| 1-7 | Normal, TrafficCone, Polevaulter |
| 1-8 | Normal, TrafficCone, Pail(铁桶) |
| 1-9 / 1-10 | Normal, TrafficCone, Polevaulter, Pail |

### 2.3 每波点数预算

> 注意：1-5 只有在**首次通关**时才走普通 Adventure 波次生成；重玩（`!IsFirstTimeAdventureMode()`）时
> `InitZombieWavesForLevel()` 直接 `Challenge.InitZombieWaves(); return;`（`Board.cs:10106-10110`），
> 不在本 JSON 范围内（本 JSON 为首次通关数据）。

`PickZombieWaves()`（`Board.cs:8392`）中，首通 Adventure 的点数：

```
mNumWaves = gZombieWaves[clamp(mLevel-1,0,49)]                    // Board.cs:8409
zombiePicker.mZombiePoints = i / 3 + 1;                           // Board.cs:8519
```

- 旗帜波（`IsFlagWave(i)`，`Board.cs:8542`）：
  - `num2 = min(points, 8)`（`Board.cs:8544`）；
  - `points = (int)(points * 2.5f)`（`Board.cs:8569`）；
  - 先放入 `num2` 个 `Normal`，再放入 1 个 `Flag`（`Board.cs:8573-8580`）。
- 特殊关倍率（`IL_079B` 段）：
  - 1-5 Wall-nut Bowling：`points *= 4`（`Board.cs:8984-8987`，`IsWallnutBowlingLevel` 定义在 `LawnApp.cs:2577`）。
  - 1-10 mini-boss：`points *= 3`（`Board.cs:8989-8992`，`IsMiniBossLevel` 定义在 `LawnApp.cs:2584`）。
  - 非困难 Adventure 首通不会命中其他倍率分支。

### 2.4 固定插入的僵尸

1. **Flag 僵尸**：每个旗帜波固定插入 1 只（见上）。`Flag` 的 `pickWeight=0`，永远不会被随机选中。
2. **新僵尸介绍（introduced zombie）**：`GetIntroducedZombieType()`（`Board.cs:10946`）
   找 `mStartingLevel == mLevel` 的僵尸；在**中间波**（`i == mNumWaves/2`）和**最后一波**各插 1 只
   （`Board.cs:8629-8636`）。首通 1..10 关：1-3 → TrafficCone、1-6 → Polevaulter、1-8 → Pail；
   1-10 的候选 RobotTitan 因非困难 Adventure 被排除，所以没有介绍僵尸。
3. **补漏（PutInMissingZombies）**：最后一波（`i == mNumWaves-1`）对“本波还没有出现、且本关允许”的
   每种僵尸各补 1 只（`Board.cs:12226-12235`，条件是 `mZombieTypeCount[i] <= 0`）。这保证
   `IsZombieWaveDistributionOk()`（`Board.cs:9348`）通过。补漏发生在随机循环之前。

### 2.5 随机选取（PickZombieType）

`Board.cs:2312`：

```
对 Normal..ZombieTypesCount 每种僵尸:
  若 mZombieAllowed[type] 为 false → 跳过
  若 waveIndex + 1 < mFirstAllowedWave → 跳过
  若 zombiePoints < mZombieValue → 跳过
  权重 = mPickWeight（可用 Creative 组件覆盖；冒险模式无）
用 TodPickFromWeightedArray 按权重随机一个                           // TodCommon.cs:195
```

然后 `PutZombieInWave()`（`Board.cs:12195`）把僵尸写入当前波并扣 `mZombieValue`；
循环 `while (mZombiePoints > 0 && mZombieCount < 50)`（`Board.cs:8917`，上限 50 来自
`GameConstants.MAX_ZOMBIES_IN_WAVE`，`GameConstants.cs:464`）。

僵尸点数/权重/首次允许波（`GameConstants.cs:1217` 起）：

| ZombieType | 中文 | mZombieValue | mStartingLevel | mFirstAllowedWave | mPickWeight |
| --- | --- | --- | --- | --- | --- |
| Normal | 普通僵尸 | 1 | 1 | 1 | 4000 |
| Flag | 旗子僵尸 | 1 | 1 | 1 | 0 |
| TrafficCone (Conehead) | 路障僵尸 | 2 | 3 | 1 | 4000 |
| Polevaulter | 撑杆僵尸 | 2 | 6 | 5 | 2000 |
| Pail (Buckethead) | 铁桶僵尸 | 4 | 8 | 1 | 3000 |

### 2.6 RNG 与复现

- 原版：`Sexy.RandomNumbers`（`Sexy/RandomNumbers.cs`）内部 `MTRandom.Create(MTEdition.CokOpt_19937)`
  进程启动时播种（`RandomNumbers.cs:42`），因此**每次运行的波次内容不同**。
- `TodPickFromWeightedArray` 用 `RandomNumbers.NextNumber(totalWeight)`（`TodCommon.cs:209`）。
- 本 JSON 采用**重新实现同一套挑选算法 + 可文档化的确定性 RNG**（`python random.Random`，
  每关种子 `"pgvz-level-waves:<seed>:<level>"`，默认 seed=20261114）生成一份可复现的实现。
  `levels.json._schema.waveGeneration.rng` 明确记录该差异；`waves[].zombies` 是**一次有效的实现**，
  不是唯一结果。复现同一 JSON 请保持默认 seed。
- 随机行（`Board.PickRowForNewZombie`，加权、优先非刚被小推车推过的行）不在数据模型内，
  web 端口可在运行时自行决定行。

### 2.7 波与波之间的倒计时（UpdateZombieSpawning）

`Board.cs:7297`：

- 初始倒计时 `mZombieCountDown`：
  - 默认 **1800**（`Board.cs:9931`）；
  - 首通 1-2 特别为 **5000**（`Board.cs:9921`）；
  - 1-5 Wall-nut Bowling 由 `Challenge.InitLevel()` 覆写为 **200**（`Challenge.cs:442-445`）。
- 每帧 `mZombieCountDown--`。为 5 时：
  - 若当前是旗帜波：显示 `[ADVICE_HUGE_WAVE]`，`mHugeWaveCountDown = 750`（`Board.cs:7392-7397`）；
    750 tick 后 `NextWaveComing()` 并把倒计时置 1（`Board.cs:7330-7334`）。
  - 否则调用 `NextWaveComing()`。
- 为 0 时 `SpawnZombieWave()`，然后：
  - 刚出生的是旗帜波且非 Wall-nut Bowling/LastStand → 下一波倒计时 **4500**（`Board.cs:7413-7417`）；
  - 否则 `mZombieCountDown = 2500 + RandomNumbers.NextNumber(600)`（`Board.cs:7427`）；
  - 同时 `mZombieHealthToNextWave = (int)(RandRangeFloat(0.5,0.65) * mZombieHealthWaveStart)`；
    若下一波前剩余血量已经很低且本波已开始 >400 tick，倒计时会被压缩到 **200**
    （`Board.cs:7386-7389`）。
  - 1-5 Wall-nut Bowling 的 `flag` 例外使旗帜波也走普通 2500+rand(600) 公式
    （`Board.cs:7407, 7413`）；JSON 中 `flagWaveCountDownTicks = null` 并附说明。
- 1-10 mini-boss 没有特殊初始倒计时覆盖（仍 1800）。

### 2.8 进度条/旗帜条（wave meter）

`Board.UpdateProgressMeter()`（`Board.cs:9096`）：

- 总宽 150 px；有旗帜的关卡每面旗扣 12 px 作为旗标（`Board.cs:9124-9130`）；
- 波进度 `mProgressMeterWidth` 按 `mCurrentWave` 线性插值，并叠加
  `(mZombieCountDownStart-mZombieCountDown)/mZombieCountDownStart`
  与按剩余血量的 `(mZombieHealthWaveStart - 当前血量) / (mZombieHealthWaveStart - mZombieHealthToNextWave)` 的较大者；
- `ProgressMeterHasFlags()`（`Board.cs:12965`）：首通 1-1 无旗帜、Whack-a-Zombie/Boss/迷你游戏等无旗帜。
- JSON `progressMeter = {hasFlags, wavesPerFlag, totalWidthPixels:150, flagNotchPixels:12}`。

## 3. 僵尸实际出生顺序

`SpawnZombieWave()`（`Board.cs:2601`）从 `mZombiesInWave[wave][0]` 起按 slot 顺序
`AddZombie()`，遇到 `ZombieType.Invalid` 停止；`Board.cs:2609-2628`。
`AddZombie()` 再随机选行（`PickRowForNewZombie`，`Board.cs:2519`）。
所以 `waves[].zombies` 数组顺序 = 出生顺序；行号运行时决定。

## 4. 选卡（seed bank）

### 4.1 固定卡组 vs 玩家选卡 vs 传送带

`Board.ChooseSeedsOnCurrentLevel()`（`Board.cs:5259`）最后一个条件：
`... && ( (!Adventure && !QuickPlay) || !IsFirstTimeAdventureMode() || mLevel > 7 )`。
首通 Adventure 且 **1..7 关 → false**（固定卡组），**8 关及以后 → true**（玩家选卡），
但传送带关卡（`HasConveyorBeltSeedBank()`，`Board.cs:11866`：Wall-nut Bowling / mini-boss /
Whack-a-Zombie / 各种挑战）永远不选卡。

`Board.InitLevel()`（`Board.cs:1677` 起）：

- `mSeedBank.mNumPackets = GetNumSeedsInBank()`（`Board.cs:5273`）：
  - 普通关卡：`min(mPurchases[21] + 6, 10)`，再被 `LawnApp.GetSeedsAvailable()` 封顶
    （`Board.cs:5351`；购买升级 `mPurchases[21]`，空存档 =0）；
  - 传送带关卡返回 10（`Board.cs:5295`）。
- 固定卡组分支（`Board.cs:1854-1860`）：`mSeedPackets[m].SetPacketType((SeedType)m)`，
  即按 SeedType 枚举顺序取前 `numPackets` 个。空存档下 `GetSeedsAvailable()` 由
  `LawnApp.GetAwardSeedForLevel(level)`（`LawnApp.cs:2666`）给出：

| 关卡 | GetAwardSeedForLevel / GetSeedsAvailable | numPackets | 固定卡组或选卡 |
| --- | --- | --- | --- |
| 1-1 | 1 | 1 | [Peashooter] |
| 1-2 | 2 | 2 | [Peashooter, Sunflower] |
| 1-3 | 3 | 3 | [Peashooter, Sunflower, Cherrybomb] |
| 1-4 | 4 | 4 | [Peashooter, Sunflower, Cherrybomb, Wallnut] |
| 1-5 | 4 | 10（传送带） | 传送带：初始 1 张 Wallnut，池 Wallnut 85 / ExplodeONut 15 |
| 1-6 | 5 | 5 | [Peashooter, Sunflower, Cherrybomb, Wallnut, Potatomine] |
| 1-7 | 6 | 6 | [Peashooter, Sunflower, Cherrybomb, Wallnut, Potatomine, Snowpea] |
| 1-8 | 7 | 6 | 玩家选卡：8 种可选 |
| 1-9 | 8 | 6 | 玩家选卡：9 种可选 |
| 1-10 | 8 | 10（传送带） | 传送带：池 Peashooter20/Cherrybomb20/Wallnut15/Repeater20/Snowpea10/Chomper5/Potatomine10 |

- `GetNumSeedsInBank` 中空存档 `mPurchases[21]=0`；若玩家买了种子槽升级（最多到 10）卡组会变多。
- **玩家选卡的“可选列表”**：`LawnApp.HasSeedType()`（`LawnApp.cs:2493`）在空存档下等价于
  `SeedType < GetSeedsAvailable()`，并特判 `Endoflame` 恒为 true（`LawnApp.cs:2551`）；
  选卡界面遍历 `Peashooter..ExplodeONut` 且只显示拥有类型（`SeedChooserScreen.cs:203, 351-352, 511-513`），
  Imitater 需购买才显示。空存档 1-8 可选：Peashooter、Sunflower、Cherrybomb、Wallnut、
  Potatomine、Snowpea、Chomper、Endoflame；1-9 再加 Repeater。固定卡组关卡不使用该列表。
- JSON：`seedBank.kind = "fixed" | "playerChosen" | "conveyor"`；`playerChosen.packets = null`，
  `chooserOffers` 给出上述列表；`conveyor` 给出 `initialCards`、`cardPool`（权重）与
  `firstCardCountDownTicks`。传送带补充间隔：卡数 >8→1000、>6→500、>4→425、否则 400 tick
  （`Challenge.cs:3728-3743`；`UpdateConveyorBelt` `Challenge.cs:3669`）。
- 1-5 传送带初始卡：`Challenge.InitLevel()` 给 1 张 Wallnut 且 `mConveyorBeltCounter=400`
  （`Challenge.cs:442-451`）；1-10 传送带初始卡为空、计数 0（第一张卡在开局后很快出现）。

### 4.2 1-5 预置植物

`Challenge.InitLevel()`（`Challenge.cs:3309-3314`）：首通 1-5 预植 3 个 Peashooter：
`(5,1)`、`(7,2)`、`(6,3)`（`NewPlant(gridX, gridY, ...)`）。JSON `special.prePlantedPlants`。

## 5. 背景（background）

- `Board.PickBackground()`（`Board.cs:9383`）Adventure/Quickplay 分支（`Board.cs:9444-9475`）：
  - level ≤ 10 → `Num1Day`；11..20 → `Num2Night`；21..30 → `Num3Pool`；31..40 → `Num4Fog`；
    41..49 → `Num5Roof`；50 → `Num6Boss`；其他 → `Num1Day`。
- `Board.LoadBackgroundImages()`（`Board.cs:13059`）加载 `DelayLoad_Background1..6` 组。
- `DrawLevel()`（`Board.cs:4916-4985`）把 `BackgroundType` 映射到 `Resources.IMAGE_BACKGROUND*`：
  `Num1Day → IMAGE_BACKGROUND1`。`Content/resources.xml:331`：
  `<Image id="IMAGE_BACKGROUND1" path="images/background1_hd" ...>`（同组还有 overlay/mask 资源）。
- JSON：`background = {type, imageResource, resourcePath, _source}`。

## 6. 初始阳光与自然落阳

### 6.1 初始阳光

`Board.InitLevel()`（`Board.cs:1620-1655`）：

- `IsFirstTimeAdventureMode() && mLevel == 1` → 150（`Board.cs:1632-1635`）；
- ChallengeLastStand → 5000；IZombie → 150；FinalBoss2 → 1500；ImitaterRandom → 500；
  ChallengeFusion → 50；
- 其他（含首通 Adventure 2..10）→ **50**（`Board.cs:1646-1651`）。
- JSON `startingSun`。

### 6.2 自然落阳（白天/夜晚）

`Board.UpdateSunSpawning()`（`Board.cs:7442`）：

- 夜晚关卡（`StageIsNight()`，`Board.cs:5367`：Num2Night/Num4Fog/HighGround/...）直接 return，不落阳。
- 挑战/传送带/IZombie 等模式也 return（`Board.cs:7463`）。
- 1-1 教学阶段（`TutorialState.Level1PickUpPeashooter/PlantPeashooter` 且场上无植物）不落阳（`Board.cs:7472`）。
- 初始 `mSunCountDown = RandRangeInt(425,700)`（`Board.cs:1671`）。
- 每次落阳：`mSunCountDown = min(950, 425 + mNumSunsFallen*10) + RandomNumbers.NextNumber(275)`，
  `mNumSunsFallen++`；`x = LAWN_XMIN + NextNumber(Board_SunCoinRange)`，y=60
  （`Board.cs:7481-7489`）。
- 阳光价值：`Coin.GetSunValue()`（`Coin.cs:1106`）：Sun=25、Smallsun=15、Largesun=50、Tinysun=5。

## 7. JSON schema 摘要

### 7.1 `data/levels.json`

```
{
 "_schema": { tickMilliseconds, ticksPerSecond, timeUnit, levelFields, waveFields, waveGeneration, _unresolved },
 "_meta":   { game, gameMode, generatedBy, seed, sourceRoot, tickRate, constants, _source, _assumptions },
 "levels": [
   {
     "level": 1, "stage": "1-1", "world": 1, "worldSub": 1, "gameMode": "Adventure",
     "firstTimeAdventure": true,
     "background": { "type", "imageResource", "resourcePath", "_source" },
     "startingSun": 150, "startingSunNote": "...",
     "seedBank": {
        // fixed:      { kind:"fixed", packets:[SeedType...], numPackets, chooseSeedsOnCurrentLevel:false, note, _source }
        // playerChosen:{ kind:"playerChosen", packets:null, numPackets, chooserOffers:[SeedType...], ... }
        // conveyor:   { kind:"conveyor", packets:null, numPackets:10, initialCards, cardPool:[{seed,weight}], firstCardCountDownTicks, ... }
     },
     "numWaves": 4, "flagWaves": [], "wavesPerFlag": 4,
     "progressMeter": { hasFlags, wavesPerFlag, totalWidthPixels, flagNotchPixels, note },
     "zombieSpawning": {
        initialWaveCountDownTicks, initialWaveCountDownNote,
        nonFlagWaveCountDown:{baseTicks,randomExtraMaxExclusive},
        flagWaveCountDownTicks, healthToNextWaveFractionRange:[0.5,0.65],
        healthShortcut:{minWaveAgeTicks,minCountDownTicks}, hugeWaveCountDownTicks,
        finalWaveSoundDelayTicks, _source
     },
     "introducedZombie": null | "TrafficCone" | ...,
     "allowedZombies": [ {zombieType, zombieValue, firstAllowedWave, pickWeight} ],
     "waves": [
        { "index", "flag", "initialZombiePoints", "flagPointMultiplier", "modePointMultiplier",
          "zombiePointsBeforeRandomPicks", "zombiePointsRemaining",
          "zombies": [ZombieType...], "counts": {type:count}, "forced": {
             flagEscortNormals, flagZombie, introduced, missingZombies } }
     ],
     "waveRngCalls": 17,
     "special": null | {prePlantedPlants, tutorial, _source},
     "_source": [...]
   }
 ]
}
```

要点：`waves[].zombies` 顺序即原版 `SpawnZombieWave` 的出生顺序；行号（row）由运行时随机决定，未写入。

### 7.2 `data/plants.json`

```
{ "_schema": {...}, "_meta": {...},
  "plants": [{
     "seedType", "displayNameKey", "localizedNames": {en, zh_cn},
     "sunCost", "refreshTicks", "refreshSeconds", "packetIndex", "subClass",
     "health", "healthSource",
     "launchRateTicks", "launchRateSeconds",
     "attack": null | {projectileType, projectileDamage, projectileSpeedPxPerTick,
                       projectileSpeedPxPerSecond, shotsPerAttackCycle, fireAnimationTicks,
                       firstShotCountDownTicksRange, nextShotCountDownTicksRange,
                       [secondShotTriggerCounter, secondShotPolicy], [chill:{...}], _source},
     "production": null | {sunType, sunValue, firstSunCountDownTicksRange,
                           subsequentSunCountDownTicksRange, _source},
     "special": null | {kind:"wall"|"instantExplosion"|"mine"|"chomper"|"deathExplosion", ...},
     "reanimation": {type, resourcePath, isSpine, legacyResourcePath, spineScale, _source},
     "_source": {definition, class}
  }] }
```

### 7.3 `data/zombies.json`

```
{ "_schema": {...}, "_meta": {...},
  "zombies": [{
     "zombieType", "aliases" (Conehead / Buckethead / Polevaulting ...),
     "displayNameKey", "localizedNames": {en, zh_cn},
     "zombieValue", "startingLevel", "firstAllowedWave", "pickWeight",
     "bodyHealth", "helmHealth", "totalHealth", "flyingHealth",
     "speed": {kind:"randomRange", minPxPerTick, maxPxPerTick, minPxPerSecond, maxPxPerSecond,
               chilledFactor} | {kind:"fixed", pxPerTick, pxPerSecond, chilledFactor},
     "eating": {damagePerBite, biteIntervalTicks, chilledBiteIntervalTicks, damagePerSecond, _source},
     "walkIntoHouseSpeedMultiplier", "chillDurationTicks", "iceTrapChillDurationTicks",
     "special": null | {flagBearer} | {helmType} | {vault},
     "reanimation": {type, resourcePath, isSpine, legacyResourcePath, spineScale},
     "rects": {zombieRect:[36,0,42,115], attackRect:[50,0,20,115], note},
     "_source": {definition, initialize, health, helm, speed}
  }] }
```

## 8. 单位数值速查（首通 1..10 关需要的单位）

### 植物（`GameConstants.gPlantDefs` `GameConstants.cs:1045`；血量 `Plant.GetBaseHealth` `Plant.cs:2762`）

| SeedType | 中文 | 阳光 | 冷却 tick | 血量 | 发射/产阳间隔 | 伤害/特殊 |
| --- | --- | --- | --- | --- | --- | --- |
| Peashooter | 豌豆射手 | 100 | 750 | 300 | 150 tick（1.5 s） | 豌豆 20（速度 3.33 px/tick） |
| Sunflower | 向日葵 | 50 | 750 | 300 | 2500 tick（25 s） | 产 25 阳光；首发倒计时 300..1250 |
| Wallnut | 坚果 | 50 | 3000 | 4000 | — | 挡路 |
| Cherrybomb | 樱桃炸弹 | 150 | 5000 | 300 | — | 引信 100 tick；爆炸 1800（burn）半径 115，±1 行 |
| Snowpea | 寒冰射手 | 175 | 750 | 300 | 150 tick | 20 伤害 + 减速（速度 ×0.4，1000 tick） |
| Chomper | 大嘴花 | 150 | 750 | 300 | — | 咬 70 tick 后秒杀；巨人 40 伤害；消化 4000 tick |
| Potatomine | 土豆雷 | 25 | 3000 | 300 | — | 武装 1500 tick；爆炸 1800 半径 60，同行 |
| Repeater | 双发射手 | 200 | 750 | 300 | 150 tick ×2 发 | 每轮 2 颗豌豆（各 20） |
| ExplodeONut | 爆炸坚果 | 0 | 3000 | 4000 | — | 死亡爆炸 1800（burn）半径 90，±1 行（1-5 传送带池） |

- 发射间隔来源：`Plant.UpdateShooter()` `Plant.cs:2453`（`mLaunchCounter = mLaunchRate - NextNumber(15)`）
  与 `PlantInitialize` 初始 `RandRangeInt(0, mLaunchRate)`（`Plant.cs:355-369`）。
- 产阳：`Plant.UpdateProductionPlant()` `Plant.cs:2346`（首发 `RandRangeInt(300, mLaunchRate/2)`，
  之后 `RandRangeInt(mLaunchRate-150, mLaunchRate)`）。
- 豌豆速度：`Projectile.UpdateNormalMotion()` 默认分支 `this.mPosX += 3.33f`（`Projectile.cs:1399`）。
- 阳光/爆炸数值：`Plant.DoSpecial()` `Plant.cs:1504`、`Board.KillAllZombiesInRadius()`
  `Board.cs:11720`（非 burn 时 `TakeDamage(1800, 18U)`）。

### 僵尸（`GameConstants.gZombieDefs` `GameConstants.cs:1217`；血量 `Zombie.GetBaseBodyHealth` `Zombie.cs:12179` / `GetBaseHelmHealth` `Zombie.cs:12231`）

| ZombieType | 中文 | 本体 HP | 护甲 HP | 总 HP | 速度 px/tick | 啃食 | 点数/权重 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Normal | 普通僵尸 | 270 | 0 | 270 | 0.23–0.37 | 每 4 tick 造成 4 伤害 | 1 / 4000 |
| Flag | 旗子僵尸 | 270 | 0 | 270 | 0.45 | 同上 | 1 / 0（旗帜波专用） |
| TrafficCone (Conehead) | 路障僵尸 | 270 | 370 | 640 | 0.23–0.37 | 同上 | 2 / 4000 |
| Pail (Buckethead) | 铁桶僵尸 | 270 | 1100 | 1370 | 0.23–0.37 | 同上 | 4 / 3000 |
| Polevaulter | 撑杆僵尸 | 500 | 0 | 500 | 0.66–0.68（撑杆前） | 同上 | 2 / 2000 |

- 啃食：`GameConstants.TICKS_BETWEEN_EATS = 4`（`GameConstants.cs:1178`）；`Zombie.CheckIfPreyCaught()`
  `Zombie.cs:1214` 每 4 tick（冰冻时 8 tick）触发 `EatPlant()`（`Zombie.cs:1282`），每次让植物 `HP -= 4`。
- 速度：`Zombie.PickRandomSpeed()` `Zombie.cs:2473`；移动 `Zombie.UpdateZombieWalking()`
  `Zombie.cs:3844`（`mPosX -= mVelX`，即 px/tick）。
- 冰冻：`Zombie.ApplyChill()` `Zombie.cs:2259`（1000 tick，冰陷阱 2000）；减速系数
  `GameConstants.CHILLED_SPEED_FACTOR = 0.4f`（`GameConstants.cs:1157`）。
- 撑杆：`Zombie.UpdateZombiePolevaulter()` `Zombie.cs:2534`，跳过前方植物（Tallnut 会挡下）。
- 僵尸碰撞盒默认 `mZombieRect=(36,0,42,115)`、`mZombieAttackRect=(50,0,20,115)`
  （`Zombie.cs:345-346`）。

## 9. 已知未解决 / 注意

- **RNG 精确序列不可复现**：见 §2.6；波表为同一算法的确定性样本。
- **行号随机**：`PickRowForNewZombie`（`Board.cs:2519`）运行时加权选行，未进入数据。
- **选卡列表依赖存档**：JSON 以空存档（无购买）假设给出；实际玩家可能已购 `mPurchases` 影响数量/可选类型。
- **1-2..1-4 教学流程**：除波次数据外还有教学 UI 状态（`Board.cs:10084-10093` 等）可能延后第一波，未进入 JSON。
- **11..50 关**：同代码路径，但特殊关分支与选卡解锁未展开（见 §1 注）。
