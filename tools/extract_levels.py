#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""extract_levels.py -- regenerate Adventure-mode level/wave data and early-unit
definitions for the PlantGirlsVsZombies web port from the decompiled C# sources.

Sources (read-only):
    D:\\逆向\\output\\PlantGirlsVsZombies\\decompiled\\Lawn\\  (dnSpy output)
    D:\\逆向\\PlantGirlsVsZombies\\Content\\LawnStrings_*.txt

Outputs (deterministic):
    D:\\逆向\\plangirls-web\\data\\levels.json
    D:\\逆向\\plangirls-web\\data\\plants.json
    D:\\逆向\\plangirls-web\\data\\zombies.json

The script parses the C# tables/constants with regexes (brace-aware where needed)
and re-implements the Adventure wave picker (Board.PickZombieWaves) so that each
level gets a concrete, reproducible wave table.  The original picker consumes a
runtime-seeded MersenneTwister (Sexy.RandomNumbers.Seed() -> MTRandom.Create);
exact run-to-run sequences therefore cannot be reproduced, so a documented
canonical seed is used and the JSON marks the wave lists as one valid
realisation of the same algorithm.

Usage:
    python extract_levels.py [--seed 20261114] [--levels 1-10] [--out DIR] [--quiet]
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
from collections import Counter, OrderedDict

# ---------------------------------------------------------------------------
# paths / global facts
# ---------------------------------------------------------------------------
GAME_DECOMPILED = r"D:\逆向\output\PlantGirlsVsZombies\decompiled\Lawn"
GAME_CONTENT = r"D:\逆向\PlantGirlsVsZombies\Content"
DEFAULT_OUT = r"D:\逆向\plangirls-web\data"

# Sexy/Main.cs:39  base.TargetElapsedTime = TimeSpan.FromSeconds(0.01)
TICK_MS = 10
TICKS_PER_SECOND = 1000 // TICK_MS  # 100
DEFAULT_SEED = 20261114
MAX_WAVE_ZOMBIES = 50  # GameConstants.MAX_ZOMBIES_IN_WAVE

# Adventure levels extracted by default (world 1 "Day").
DEFAULT_LEVELS = "1-10"


# ---------------------------------------------------------------------------
# tiny source-access helpers
# ---------------------------------------------------------------------------
def _path(rel: str) -> str:
    return os.path.join(GAME_DECOMPILED, rel.replace("/", os.sep))


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"//[^\n]*", "", text)
    return text


class Src:
    """One decompiled C# file plus line-number helpers."""

    def __init__(self, rel: str):
        self.rel = rel
        with open(_path(rel), "r", encoding="utf-8", errors="replace") as fh:
            self.text = fh.read()
        self.clean = strip_comments(self.text)

    def line_of(self, index: int) -> int:
        return self.text.count("\n", 0, max(0, index)) + 1

    def cite(self, needle: str, start: int = 0) -> dict:
        idx = self.text.find(needle, start)
        if idx < 0:
            raise LookupError("%s: needle not found: %r" % (self.rel, needle))
        return {"file": self.rel, "line": self.line_of(idx)}

    def find(self, needle: str, start: int = 0) -> int:
        idx = self.text.find(needle, start)
        if idx < 0:
            raise LookupError("%s: needle not found: %r" % (self.rel, needle))
        return idx

    def require(self, needle: str) -> None:
        if needle not in self.text:
            raise LookupError("%s: expected text missing: %r" % (self.rel, needle))


def unquote(tok: str) -> str:
    tok = tok.strip()
    if len(tok) >= 2 and tok[0] == '"' and tok[-1] == '"':
        return tok[1:-1]
    raise ValueError("not a string literal: %r" % tok)


def extract_braces(text: str, open_idx: int) -> str:
    """Return the contents of the { ... } block starting at open_idx."""
    assert text[open_idx] == "{", "extract_braces: not at '{'"
    depth = 0
    in_str = False
    esc = False
    for i in range(open_idx, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[open_idx + 1:i]
    raise ValueError("unbalanced braces")


def split_args(argstr: str) -> list:
    """Split a C# argument list on top-level commas (strings/parens aware)."""
    out, buf = [], []
    depth = 0
    in_str = False
    esc = False
    for ch in argstr:
        if in_str:
            buf.append(ch)
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            buf.append(ch)
        elif ch in "([{<":
            depth += 1
            buf.append(ch)
        elif ch in ")]}>":
            depth -= 1
            buf.append(ch)
        elif ch == "," and depth == 0:
            out.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    last = "".join(buf).strip()
    if last:
        out.append(last)
    return out


def parse_enum(src: Src, name: str) -> "OrderedDict[str,int]":
    """Parse a C# enum body into name -> value (implicit +1 increments)."""
    m = re.search(r"enum\s+" + re.escape(name) + r"\s*\{", src.clean)
    if not m:
        raise LookupError("%s: enum %s not found" % (src.rel, name))
    body = extract_braces(src.clean, m.end() - 1)
    out = OrderedDict()
    nxt = 0
    for line in body.splitlines():
        line = line.strip().rstrip(",").strip()
        if not line or line.startswith("}"):
            continue
        em = re.match(r"^([A-Za-z_]\w*)\s*(?:=\s*(-?\d+))?$", line)
        if not em:
            continue
        nm, val = em.group(1), em.group(2)
        v = int(val) if val is not None else nxt
        out[nm] = v
        nxt = v + 1
    return out


def parse_ctor_array(src: Src, class_name: str, anchor: str) -> list:
    """Parse `= new X[] { new X(...), ... }` into lists of raw arg strings."""
    m = re.search(anchor, src.clean)
    if not m:
        raise LookupError("%s: array anchor not found: %r" % (src.rel, anchor))
    open_idx = src.clean.find("{", m.end())
    body = extract_braces(src.clean, open_idx)
    ctors = []
    pat = re.compile(r"new\s+" + re.escape(class_name) + r"\s*\(")
    for cm in pat.finditer(body):
        # find matching close paren
        depth = 0
        for j in range(cm.end() - 1, len(body)):
            if body[j] == "(":
                depth += 1
            elif body[j] == ")":
                depth -= 1
                if depth == 0:
                    ctors.append(body[cm.end():j])
                    break
    return ctors


def grab(pattern: str, src: Src, group: int = 1, flags: int = re.S, kind=str):
    m = re.search(pattern, src.clean, flags)
    if not m:
        raise LookupError("%s: pattern not found: %r" % (src.rel, pattern))
    raw = m.group(group).strip()
    if kind is int:
        return int(raw, 0)
    if kind is float:
        return float(raw.rstrip("f"))
    return raw


def cite_pattern(src: Src, pattern: str, flags: int = re.S) -> dict:
    m = re.search(pattern, src.text, flags)
    if not m:
        raise LookupError("%s: pattern not found: %r" % (src.rel, pattern))
    return {"file": src.rel, "line": src.line_of(m.start())}


def parse_lawn_strings(fname: str) -> dict:
    """Parse LawnStrings_xx.txt into key -> localised value (null if missing)."""
    path = os.path.join(GAME_CONTENT, fname)
    out = {}
    if not os.path.exists(path):
        return out
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        lines = [ln.rstrip("\r\n") for ln in fh]
    i = 0
    while i < len(lines):
        m = re.match(r"^\[([A-Za-z0-9_]+)\]\s*$", lines[i].strip())
        if m:
            key = m.group(1)
            val = None
            if i + 1 < len(lines):
                nxt = lines[i + 1].strip()
                if nxt and not nxt.startswith("["):
                    val = nxt
                    i += 1
            out.setdefault(key, val)
        i += 1
    return out


# ---------------------------------------------------------------------------
# resource-id -> resource path (Content/resources.xml)
# ---------------------------------------------------------------------------
def parse_resources_xml() -> dict:
    path = os.path.join(GAME_CONTENT, "resources.xml")
    out = {}
    if not os.path.exists(path):
        return out
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    for m in re.finditer(r'<Image\s+id="([^"]+)"\s+path="([^"]+)"', text):
        out.setdefault(m.group(1), m.group(2))
    return out


# ---------------------------------------------------------------------------
# game data extraction
# ---------------------------------------------------------------------------
class GameData:
    """All tables/constants parsed out of the decompiled sources."""

    def __init__(self):
        self.plant_enum = parse_enum(Src("Lawn/SeedType.cs"), "SeedType")
        self.zombie_enum = parse_enum(Src("Lawn/ZombieType.cs"), "ZombieType")
        self.plant_subclass = parse_enum(Src("Lawn/PlantSubClass.cs"), "PlantSubClass")
        self.bg_enum = parse_enum(Src("Lawn/BackgroundType.cs"), "BackgroundType")

        self.game_constants = Src("Lawn/GameConstants.cs")
        self.board = Src("Lawn/Board.cs")
        self.plant_src = Src("Lawn/Plant.cs")
        self.zombie_src = Src("Lawn/Zombie.cs")
        self.projectile_src = Src("Lawn/Projectile.cs")
        self.lawnapp = Src("Lawn/LawnApp.cs")
        self.challenge = Src("Lawn/Challenge.cs")
        self.seed_chooser = Src("Lawn/SeedChooserScreen.cs")
        self.coin = Src("Lawn/Coin.cs")
        self.todcommon = Src("Sexy/TodLib/TodCommon.cs")
        self.random_numbers = Src("Sexy/RandomNumbers.cs")
        self.main = Src("Sexy/Main.cs")

        self.lang_en = parse_lawn_strings("LawnStrings_en.txt")
        self.lang_zh = parse_lawn_strings("LawnStrings_zh_cn.txt")
        self.resources_xml = parse_resources_xml()

        self._parse_tables()
        self._parse_constants()
        self._parse_level_rules()
        self._parse_seed_bank_rules()
        self._parse_plant_rules()
        self._parse_zombie_rules()
        self._record_table_citations()

    def _record_table_citations(self):
        """file:line for every table/function the extractor relies on."""
        table_cites = {
            "gZombieWaves": (self.game_constants, "public static int[] gZombieWaves"),
            "gZombieAllowedLevels": (self.game_constants, "public static ZombieAllowedLevels[] gZombieAllowedLevels"),
            "gPlantDefs": (self.game_constants, "public static PlantDefinition[] gPlantDefs"),
            "gZombieDefs": (self.game_constants, "public static ZombieDefinition[] gZombieDefs"),
            "gProjectileDefinition": (self.game_constants, "public static ProjectileDefinition[] gProjectileDefinition"),
            "gLawnReanimationArray": (self.game_constants, "gLawnReanimationArray = new ReanimationParams[]"),
            "killAllZombiesInRadius": (self.board, "public int KillAllZombiesInRadius"),
            "applyChill": (self.zombie_src, "public void ApplyChill"),
            "getBaseHealth": (self.plant_src, "public static int GetBaseHealth(SeedType type)"),
            "getBaseBodyHealth": (self.zombie_src, "public static int GetBaseBodyHealth"),
            "getBaseHelmHealth": (self.zombie_src, "public static int GetBaseHelmHealth"),
            "pickRandomSpeed": (self.zombie_src, "public void PickRandomSpeed"),
            "updateNormalMotion": (self.projectile_src, "public void UpdateNormalMotion"),
            "updateZombieWalking": (self.zombie_src, "public void UpdateZombieWalking"),
            "getSunValue": (self.coin, "public int GetSunValue()"),
            "stageIsNight": (self.board, "public bool StageIsNight()"),
        }
        for key, (src, needle) in table_cites.items():
            self._cite_consts[key] = src.cite(needle)

    # -- tables ------------------------------------------------------------
    def _parse_tables(self):
        gc = self.game_constants

        m = re.search(r"public static int\[\]\s+gZombieWaves\s*=\s*new int\[\]\s*\{", gc.clean)
        if not m:
            raise LookupError("gZombieWaves not found")
        self.g_zombie_waves = [int(x) for x in re.findall(r"-?\d+", extract_braces(gc.clean, gc.clean.find("{", m.end() - 1)))]
        if len(self.g_zombie_waves) < 50:
            raise ValueError("gZombieWaves: expected 50 entries, got %d" % len(self.g_zombie_waves))

        # ZombieAllowedLevels: ordered array indexed by ZombieType
        self.zombie_allowed_levels = {}
        for args in parse_ctor_array(gc, "ZombieAllowedLevels",
                                     r"ZombieAllowedLevels\[\]\s+gZombieAllowedLevels\s*=\s*new ZombieAllowedLevels\[\]"):
            parts = split_args(args)
            ztype = parts[0].split(".")[-1]
            if re.fullmatch(r"new int\[\d+\]", parts[1].strip()):
                size = int(re.search(r"\[(\d+)\]", parts[1]).group(1))
                levels = [0] * size  # C# default-initialised array
            else:
                levels = [int(x) for x in re.findall(r"-?\d+", parts[1])]
            if len(levels) != 50:
                raise ValueError("ZombieAllowedLevels[%s]: expected 50 levels, got %d" % (ztype, len(levels)))
            self.zombie_allowed_levels[ztype] = levels

        # gPlantDefs
        self.plant_defs = []
        for args in parse_ctor_array(gc, "PlantDefinition",
                                     r"PlantDefinition\[\]\s+gPlantDefs\s*=\s*new PlantDefinition\[\]"):
            a = split_args(args)
            if len(a) != 9:
                raise ValueError("PlantDefinition: expected 9 args, got %r" % (a,))
            self.plant_defs.append({
                "seedType": a[0].split(".")[-1],
                "reanimation": a[2].split(".")[-1],
                "packetIndex": int(a[3]),
                "sunCost": int(a[4]),
                "refreshTicks": int(a[5]),
                "subClass": a[6].split(".")[-1],
                "launchRateTicks": int(a[7]),
                "nameKey": unquote(a[8]),
            })

        # gZombieDefs
        self.zombie_defs = []
        for args in parse_ctor_array(gc, "ZombieDefinition",
                                     r"ZombieDefinition\[\]\s+gZombieDefs\s*=\s*new ZombieDefinition\[\]"):
            a = split_args(args)
            if len(a) != 7:
                raise ValueError("ZombieDefinition: expected 7 args, got %r" % (a,))
            self.zombie_defs.append({
                "zombieType": a[0].split(".")[-1],
                "reanimation": a[1].split(".")[-1],
                "zombieValue": int(a[2]),
                "startingLevel": int(a[3]),
                "firstAllowedWave": int(a[4]),
                "pickWeight": int(a[5]),
                "nameKey": unquote(a[6]),
            })

        # gLawnReanimationArray (resource path per ReanimationType)
        self.reanimation_params = {}
        for args in parse_ctor_array(gc, "ReanimationParams",
                                     r"gLawnReanimationArray\s*=\s*new ReanimationParams\[\]"):
            a = split_args(args)
            rtype = a[0].split(".")[-1]
            entry = {"type": rtype, "resourcePath": unquote(a[1]), "flags": 0,
                     "isSpine": False, "legacyResourcePath": None, "spineScale": None}
            rest = a[2:]
            if rest:
                entry["flags"] = int(rest[0])
            if len(rest) >= 2:
                entry["isSpine"] = rest[1].strip() == "true"
            if len(rest) >= 3 and rest[2].strip() != "null":
                entry["legacyResourcePath"] = unquote(rest[2])
            if len(rest) >= 4:
                entry["spineScale"] = float(rest[3].rstrip("f"))
            self.reanimation_params[rtype] = entry

        # gProjectileDefinition
        self.projectiles = {}
        for args in parse_ctor_array(gc, "ProjectileDefinition",
                                     r"ProjectileDefinition\[\]\s+gProjectileDefinition\s*=\s*new ProjectileDefinition\[\]"):
            a = split_args(args)
            ptype = a[0].split(".")[-1]
            self.projectiles[ptype] = {"projectileType": ptype, "imageRow": int(a[1]), "damage": int(a[2])}

    # -- constants ---------------------------------------------------------
    def _parse_constants(self):
        gc = self.game_constants
        self.const = {
            "TICKS_BETWEEN_EATS": grab(r"TICKS_BETWEEN_EATS\s*=\s*(\d+);", gc, kind=int),
            "CHILLED_SPEED_FACTOR": grab(r"CHILLED_SPEED_FACTOR\s*=\s*([\d.]+)f;", gc, kind=float),
            "MAX_ZOMBIES_IN_WAVE": grab(r"MAX_ZOMBIES_IN_WAVE\s*=\s*(\d+);", gc, kind=int),
            "MAX_ZOMBIE_WAVES": grab(r"MAX_ZOMBIE_WAVES\s*=\s*(\d+);", gc, kind=int),
            "ZOMBIE_LIMP_SPEED_FACTOR": grab(r"ZOMBIE_LIMP_SPEED_FACTOR\s*=\s*(\d+);", gc, kind=int),
        }
        gc.require("TICKS_BETWEEN_EATS")
        # projectile speed: default straight motion advances mPosX += 3.33f / tick
        # (the last such assignment in Projectile.UpdateNormalMotion is the default branch)
        speed_matches = list(re.finditer(r"this\.mPosX \+= ([\d.]+)f;", self.projectile_src.text))
        if not speed_matches:
            raise LookupError("straight projectile speed not found")
        self.pea_speed = float(speed_matches[-1].group(1))
        self._pea_speed_line = self.projectile_src.line_of(speed_matches[-1].start())
        # sun values (Coin.GetSunValue)
        sun_fn = self.coin.clean[self.coin.clean.find("public int GetSunValue()"):]
        sun_fn = extract_braces(sun_fn, sun_fn.find("{"))
        self.sun_values = {}
        for m in re.finditer(r"mType == CoinType\.(\w+)\)\s*\{\s*return (\d+);", sun_fn):
            self.sun_values[m.group(1)] = int(m.group(2))
        self.sun_values.setdefault("Sun", 25)
        self._cite_consts = {
            "TICKS_BETWEEN_EATS": gc.cite("public static int TICKS_BETWEEN_EATS"),
            "CHILLED_SPEED_FACTOR": gc.cite("CHILLED_SPEED_FACTOR"),
            "tickRate": self.main.cite("base.TargetElapsedTime = TimeSpan.FromSeconds(0.01)"),
            "rng": self.random_numbers.cite("RandomNumbers.r = MTRandom.Create(MTEdition.CokOpt_19937)"),
            "weightedPick": self.todcommon.cite("public static object TodPickFromWeightedArray"),
            "randRangeInt": self.todcommon.cite("public static int RandRangeInt"),
            "peaSpeed": {"file": self.projectile_src.rel, "line": self._pea_speed_line},
        }

    # -- level / wave rules ------------------------------------------------
    def _parse_level_rules(self):
        b = self.board
        self._cite_consts.update({
            "initLevel": b.cite("public void InitLevel()"),
            "initZombieWaves": b.cite("public void InitZombieWaves()"),
            "initZombieWavesForLevel": b.cite("public void InitZombieWavesForLevel(int aForLevel)"),
            "pickZombieWaves": b.cite("public void PickZombieWaves()"),
            "pickZombieType": b.cite("public ZombieType PickZombieType("),
            "updateZombieSpawning": b.cite("public void UpdateZombieSpawning()"),
            "spawnZombieWave": b.cite("public void SpawnZombieWave()"),
            "canZombieSpawnOnLevel": b.cite("public static bool CanZombieSpawnOnLevel"),
            "isFlagWave": b.cite("public bool IsFlagWave(int theWaveNumber)"),
            "getNumWavesPerFlag": b.cite("public int GetNumWavesPerFlag()"),
            "putInMissingZombies": b.cite("public void PutInMissingZombies"),
            "getIntroducedZombieType": b.cite("public ZombieType GetIntroducedZombieType()"),
            "updateProgressMeter": b.cite("public void UpdateProgressMeter()"),
            "pickBackground": b.cite("public void PickBackground()"),
            "loadBackgroundImages": b.cite("public void LoadBackgroundImages()"),
            "chooseSeeds": b.cite("public bool ChooseSeedsOnCurrentLevel()"),
            "getNumSeedsInBank": b.cite("public int GetNumSeedsInBank()"),
            "hasConveyorBeltSeedBank": b.cite("public bool HasConveyorBeltSeedBank()"),
            "updateSunSpawning": b.cite("public void UpdateSunSpawning()"),
            "updateGame": b.cite("public void UpdateGame()"),
        })

        # initial zombie countdowns from InitZombieWaves() (5000 special case lvl2,
        # 600 survival, 1800 default; ordered occurrences in the function body).
        iw = b.clean[b.clean.find("public void InitZombieWaves()"):]
        iw = iw[:iw.find("public void InitSurvivalStage()")]
        counts = re.findall(r"this\.mZombieCountDown = (\d+);", iw)
        if counts[:3] != ["5000", "600", "1800"]:
            raise ValueError("InitZombieWaves countdown order changed: %r" % counts[:5])
        # level 2 first-time tutorial delay
        self.initial_countdown_level2 = 5000
        self.initial_countdown_default = 1800
        self._cite_consts["level2InitialCountDown"] = cite_pattern(
            b, r"this\.mLevel == 2\)\s*\{\s*this\.mZombieCountDown = 5000;")

        # Wall-nut Bowling (Adventure 1-5) overrides the initial countdown in
        # Challenge.InitLevel -> 200 (Challenge.cs)
        wb = self.challenge.text[self.challenge.text.find("if (this.mApp.IsWallnutBowlingLevel())"):]
        m = re.search(r"this\.mBoard\.mZombieCountDown = (\d+);", wb)
        if not m:
            raise LookupError("wallnut bowling initial countdown not found")
        self.wallnut_bowling_initial_countdown = int(m.group(1))
        self._cite_consts["wallnutBowlingInitialCountDown"] = cite_pattern(
            self.challenge,
            r"if \(this\.mApp\.IsWallnutBowlingLevel\(\)\)\s*\{\s*this\.mBoard\.mZombieCountDown = 200;")

        # wave-to-wave countdowns from UpdateZombieSpawning()
        uz = b.clean[b.clean.find("public void UpdateZombieSpawning()"):]
        uz = uz[:uz.find("public void UpdateSunSpawning()")]
        m = re.search(r"this\.mZombieCountDown = (\d+);\s*\}\s*else\s*\{\s*this\.mZombieHealthToNextWave", uz)
        # flag-wave branch:  mZombieCountDown = 4500;
        self.flag_wave_countdown = grab(r"this\.mZombieCountDown = (4500);", b, kind=int)
        m = re.search(r"this\.mZombieCountDown = (\d+) \+ RandomNumbers\.NextNumber\((\d+)\);", uz)
        if not m:
            raise LookupError("normal wave countdown formula not found")
        self.normal_wave_countdown = (int(m.group(1)), int(m.group(2)))
        self._cite_consts["normalWaveCountDown"] = cite_pattern(
            b, r"this\.mZombieCountDown = 2500 \+ RandomNumbers\.NextNumber\(600\);")
        m = re.search(r"TodCommon\.RandRangeFloat\(([\d.]+)f, ([\d.]+)f\) \* \(float\)this\.mZombieHealthWaveStart", uz)
        if not m:
            raise LookupError("health-to-next-wave fraction not found")
        self.health_next_wave_fraction = (float(m.group(1)), float(m.group(2)))
        self.health_shortcut_age = grab(r"this\.mZombieCountDown > 5 && num2 > (400)", b, kind=int)
        self.health_shortcut_min = grab(r"this\.mZombieCountDown > (200)\)", b, kind=int)
        self.huge_wave_countdown = grab(r"this\.mHugeWaveCountDown = (750);", b, kind=int)

        # PickZombieWaves numeric rules
        pzw = b.clean[b.clean.find("public void PickZombieWaves()"):]
        pzw = pzw[:pzw.find("public void StopAllZombieSounds()")]
        self.flag_escort_max = grab(r"Math\.Min\(zombiePicker\.mZombiePoints, (\d+)\)", b, kind=int)
        self.flag_point_multiplier = grab(r"zombiePicker\.mZombiePoints = \(int\)\(\(float\)zombiePicker\.mZombiePoints \* ([\d.]+)f\);", b, kind=float)
        self.wave_points_divisor = 3
        m = re.search(r"zombiePicker\.mZombiePoints = i / (\d+) \+ (\d+);", pzw)
        if not m:
            raise LookupError("wave point formula not found")
        self.wave_point_divisor, self.wave_point_offset = int(m.group(1)), int(m.group(2))
        self.replay_flag_multiplier = 2.5
        # mode point multipliers (adventure special levels)
        self.wallnut_bowling_multiplier = grab(
            r"IsWallnutBowlingLevel\(\)\)\s*\{\s*zombiePicker\.mZombiePoints \*= (\d+);", b, kind=int)
        self.mini_boss_multiplier = grab(
            r"IsMiniBossLevel\(\)\)\s*\{\s*zombiePicker\.mZombiePoints \*= (\d+);", b, kind=int)
        # progress meter
        self.meter_total_width = grab(r"int num = (150);", b, kind=int)
        self.meter_flag_notch = grab(r"num -= num2 \* (\d+);", b, kind=int)

        # natural sun spawning (day)
        m = re.search(r"this\.mSunCountDown = TodCommon\.RandRangeInt\((\d+), (\d+)\);", b.clean)
        if not m:
            raise LookupError("initial sun countdown not found")
        self.sun_initial_range = (int(m.group(1)), int(m.group(2)))
        self._cite_consts["sunInitialRange"] = cite_pattern(
            b, r"this\.mSunCountDown = TodCommon\.RandRangeInt\(425, 700\);")
        sun = b.clean[b.clean.find("public void UpdateSunSpawning()"):]
        sun = sun[:sun.find("public void ClearAdvice")]
        m = re.search(r"this\.mSunCountDown = Math\.Min\((\d+), (\d+) \+ this\.mNumSunsFallen \* (\d+)\) \+ RandomNumbers\.NextNumber\((\d+)\);", sun)
        if not m:
            raise LookupError("sun respawn formula not found")
        self.sun_respawn = {
            "max": int(m.group(1)), "base": int(m.group(2)),
            "incrementPerSun": int(m.group(3)), "randomExtraMaxExclusive": int(m.group(4)),
        }
        self._cite_consts["sunRespawn"] = cite_pattern(
            b, r"this\.mSunCountDown = Math\.Min\(950, 425 \+ this\.mNumSunsFallen \* 10\) \+ RandomNumbers\.NextNumber\(275\);")

        # starting sun (InitLevel)
        il = b.clean[b.clean.find("public void InitLevel()"):]
        il = il[:il.find("private void SetupRenderItems()")]
        m = re.search(r"this\.mLevel == 1\)\s*\{\s*this\.mSunMoney = (\d+);", il)
        if not m:
            raise LookupError("level-1 starting sun not found")
        self.start_sun_level1 = int(m.group(1))
        self.start_sun_default = 50
        b.require("this.mSunMoney = 50;")
        self._cite_consts["startSunLevel1"] = cite_pattern(
            b, r"if \(this\.mApp\.IsFirstTimeAdventureMode\(\) && this\.mLevel == 1\)\s*\{\s*this\.mSunMoney = 150;")
        self._cite_consts["startSunDefault"] = b.cite("this.mSunMoney = 50;")

        # backgrounds (PickBackground) and resource mapping
        self.background_resources = {
            "Num1Day": "IMAGE_BACKGROUND1", "Num2Night": "IMAGE_BACKGROUND2",
            "Num3Pool": "IMAGE_BACKGROUND3", "Num4Fog": "IMAGE_BACKGROUND4",
            "Num5Roof": "IMAGE_BACKGROUND5", "Num6Boss": "IMAGE_BACKGROUND6BOSS",
            "MushroomGarden": "IMAGE_BACKGROUND_MUSHROOMGARDEN",
            "Greenhouse": "IMAGE_BACKGROUND_GREENHOUSE",
            "GreenhouseNight": "IMAGE_BACKGROUND_GREENHOUSE_NIGHT",
            "Zombiquarium": "IMAGE_BACKGROUND7",
            "TreeOfWisdom": "IMAGE_BACKGROUND8",
            "HighGround": "IMAGE_BACKGROUND7",
            "BigPool": "IMAGE_BACKGROUND8",
            "ShallowDay": "IMAGE_BACKGROUND1",
        }

    def background_for_level(self, level: int) -> dict:
        """Board.PickBackground(), Adventure/Quickplay branch (Board.cs:9444-9475)."""
        if level <= 10:
            bg = "Num1Day"
        elif level <= 20:
            bg = "Num2Night"
        elif level <= 30:
            bg = "Num3Pool"
        elif level <= 40:
            bg = "Num4Fog"
        elif level < 50:
            bg = "Num5Roof"
        elif level == 50:
            bg = "Num6Boss"
        else:
            bg = "Num1Day"
        res_id = self.background_resources.get(bg)
        return {
            "type": bg,
            "imageResource": res_id,
            "resourcePath": self.resources_xml.get(res_id) if res_id else None,
            "_source": self._cite_consts["pickBackground"],
        }

    # -- seed bank rules ---------------------------------------------------
    def _parse_seed_bank_rules(self):
        """Transcriptions of LawnApp.GetAwardSeedForLevel / Board.GetNumSeedsInBank."""
        la = self.lawnapp
        fn = la.clean[la.clean.find("public SeedType GetAwardSeedForLevel(int theLevel)"):]
        fn = fn[:fn.find("public string GetCrazyDaveText")]
        self._cite_consts["awardSeedForLevel"] = la.cite("public SeedType GetAwardSeedForLevel(int theLevel)")
        self._cite_consts["getSeedsAvailable"] = la.cite("public int GetSeedsAvailable()")
        self._cite_consts["hasSeedType"] = la.cite("public bool HasSeedType(SeedType theSeedType)")
        # Constants used by the transcription below (verified present):
        for needle in ("int num4 = (theLevel - 1) / 10 + 1;",
                       "int num2 = (theLevel - 1) % 10 + 1;",
                       "int num3 = (num4 - 1) * 8 + num2;",
                       "if (num3 > 40)"):
            la.require(needle)
        m = re.search(r"mPurchases\[21\] \+ (\d+), (\d+)\)", self.board.text)
        if not m:
            raise LookupError("GetNumSeedsInBank packet formula not found")
        self.seed_bank_base_packets = int(m.group(1))
        self.seed_bank_max_packets = int(m.group(2))
        self._cite_consts["numSeedsInBankFormula"] = cite_pattern(
            self.board, r"int num = Math\.Min\(this\.mApp\.mPlayerInfo\.mPurchases\[21\] \+ 6, 10\);")
        # ChooseSeedsOnCurrentLevel: first-time adventure levels > 7 use the chooser
        b = self.board
        self.first_time_chooser_first_level = grab(
            r"this\.mLevel > (\d+)\);", b, kind=int)  # last term of ChooseSeedsOnCurrentLevel
        self._cite_consts["chooseSeeds"] = b.cite("public bool ChooseSeedsOnCurrentLevel()")
        # conveyor for wallnut bowling / mini boss levels
        self._cite_consts["conveyor"] = b.cite("public bool HasConveyorBeltSeedBank()")

    def award_seed_for_level(self, level: int) -> int:
        """1:1 transcription of LawnApp.GetAwardSeedForLevel (LawnApp.cs:2666)."""
        world = (level - 1) // 10 + 1
        sub = (level - 1) % 10 + 1
        idx = (world - 1) * 8 + sub
        if sub >= 10:
            idx -= 2
        elif sub >= 5:
            idx -= 1
        if idx > 40:
            idx = 40
        return idx

    def seeds_available(self, level: int) -> int:
        """LawnApp.GetSeedsAvailable() on a fresh profile."""
        return min(49, self.award_seed_for_level(level))

    def seed_enum_order(self) -> list:
        """Real seed type names in numeric order (None=-1, card-flag bits excluded)."""
        limit = self.plant_enum.get("SeedTypeCount", 1 << 30)
        pairs = [(name, val) for name, val in self.plant_enum.items()
                 if 0 <= val < limit]
        return [name for name, _ in sorted(pairs, key=lambda kv: kv[1])]

    def chooser_offers(self, level: int) -> list:
        """Seed types the chooser shows as owned on a fresh profile.

        HasSeedType(): type < GetSeedsAvailable() or type == Endoflame
        (LawnApp.cs:2551); the chooser only iterates Peashooter..ExplodeONut and
        hides Imitater unless owned (SeedChooserScreen.cs:203, :352).
        """
        order = self.seed_enum_order()
        avail = self.seeds_available(level)
        offers = []
        for name in order:
            idx = self.plant_enum[name]
            if name == "Imitater":
                continue
            owned = idx < avail or name == "Endoflame"
            if owned:
                offers.append(name)
        return offers

    def seed_bank_for_level(self, level: int) -> dict:
        conveyor_levels = {5: "WallnutBowling", 10: "MiniBoss"}
        if level in conveyor_levels:
            if level == 5:
                initial = ["Wallnut"]
                pool = self._wallnut_bowling_pool()
                counter = self._wallnut_bowling_belt_counter()
                note = ("Adventure 1-5 is a Wall-nut Bowling level: conveyor belt "
                        "seed bank, no hand-picked seeds.")
            else:
                initial = []
                pool = self._level10_pool()
                counter = 0
                note = ("Adventure 1-10 is a mini-boss conveyor level: conveyor "
                        "belt seed bank, no hand-picked seeds.")
            return {
                "kind": "conveyor",
                "packets": None,
                "numPackets": 10,
                "initialCards": initial,
                "cardPool": pool,
                "firstCardCountDownTicks": counter,
                "replenishCountDownTicks": {
                    "emptyBelt": 400, "gt4Cards": 425, "gt6Cards": 500, "gt8Cards": 1000,
                    "_note": "Challenge.UpdateConveyorBelt() (Challenge.cs:3669); "
                             "counter decrements once per tick.",
                    "_source": self.challenge.cite("public void UpdateConveyorBelt()"),
                },
                "special": conveyor_levels[level],
                "note": note,
                "_source": self._cite_consts["hasConveyorBeltSeedBank"],
            }

        num_packets = min(self.seed_bank_base_packets, self.seeds_available(level))
        choose = level > self.first_time_chooser_first_level
        if choose:
            offers = self.chooser_offers(level)
            return {
                "kind": "playerChosen",
                "packets": None,
                "numPackets": num_packets,
                "chooserOffers": offers,
                "chooserOffersNote": (
                    "Offers assume a fresh profile (no store purchases) and the "
                    "current Adventure level; HasSeedType() is index-based: "
                    "SeedType < GetSeedsAvailable() plus Endoflame. Player picks "
                    "numPackets of these."),
                "chooseSeedsOnCurrentLevel": True,
                "_source": [self._cite_consts["chooseSeeds"],
                            self._cite_consts["hasSeedType"]],
            }
        order = self.seed_enum_order()
        packets = order[:num_packets]
        return {
            "kind": "fixed",
            "packets": packets,
            "numPackets": num_packets,
            "chooseSeedsOnCurrentLevel": False,
            "note": ("First-time Adventure levels 1-7 skip the seed chooser; the "
                     "bank receives SeedType values 0..numPackets-1 in enum order "
                     "(Board.InitLevel Board.cs:1854). numPackets is limited by "
                     "GetSeedsAvailable() on a fresh profile."),
            "_source": [self._cite_consts["chooseSeeds"],
                        self._cite_consts["numSeedsInBankFormula"]],
        }

    # -- conveyor pools ----------------------------------------------------
    @staticmethod
    def _block_until_next_else(src_text: str, start_idx: int) -> str:
        """Return the block text until the next `else if (` at the same chain level."""
        nxt = src_text.find("else if (", start_idx + 10)
        if nxt < 0:
            nxt = start_idx + 1200
        return src_text[start_idx:nxt]

    def _wallnut_bowling_pool(self) -> list:
        src = self.challenge
        start = src.clean.find("else if (this.mApp.IsWallnutBowlingLevel())")
        if start < 0:
            raise LookupError("wallnut bowling conveyor pool not found")
        block = self._block_until_next_else(src.clean, start)
        pairs = re.findall(r"mItem = SeedType\.(\w+);\s*Challenge\.aSeedPickArray\[num2\]\.mWeight = (\d+);", block)
        if not pairs:
            raise LookupError("wallnut bowling conveyor pool not found")
        return [{"seed": s, "weight": int(w)} for s, w in pairs]

    def _wallnut_bowling_belt_counter(self) -> int:
        src = self.challenge
        start = src.clean.find("this.mBoard.mSeedBank.AddSeed(SeedType.Wallnut, false);")
        m = re.search(r"this\.mConveyorBeltCounter = (\d+);", src.clean[start:start + 400])
        if not m:
            raise LookupError("wallnut bowling conveyor counter not found")
        return int(m.group(1))

    def _level10_pool(self) -> list:
        src = self.challenge
        start = src.clean.find("else if (this.mBoard.mLevel == 10)")
        if start < 0:
            raise LookupError("level 10 conveyor pool not found")
        block = self._block_until_next_else(src.clean, start)
        pairs = re.findall(r"mItem = SeedType\.(\w+);\s*Challenge\.aSeedPickArray\[num2\]\.mWeight = (\d+);", block)
        return [{"seed": s, "weight": int(w)} for s, w in pairs]

    # -- plant behaviour ---------------------------------------------------
    def _parse_plant_rules(self):
        p = self.plant_src
        self._cite_consts.update({
            "getBaseHealth": p.cite("public static int GetBaseHealth(SeedType type)"),
            "plantInitialize": p.cite("public void PlantInitialize("),
            "updateProductionPlant": p.cite("public void UpdateProductionPlant()"),
            "updateShooter": p.cite("public void UpdateShooter()"),
            "findTargetAndFire": p.cite("public bool FindTargetAndFire("),
            "updateShooting": p.cite("public void UpdateShooting()"),
            "doSpecial": p.cite("public void DoSpecial()"),
            "updatePotato": p.cite("public void UpdatePotato()"),
            "updateChomper": p.cite("public void UpdateChomper()"),
            "makesSun": p.cite("public bool MakesSun()"),
            "getPlantAttackRect": p.cite("public TRect GetPlantAttackRect("),
            "isUpgrade": p.cite("public static bool IsUpgrade("),
        })
        p.require("this.mLaunchCounter = TodCommon.RandRangeInt(300, this.mLaunchRate / 2);")
        p.require("this.mLaunchCounter = TodCommon.RandRangeInt(0, this.mLaunchRate);")
        p.require("this.mLaunchCounter = this.mLaunchRate - RandomNumbers.NextNumber(15);")
        p.require("this.mShootingCounter = 29;")
        p.require("public bool MakesSun()")
        # cherry bomb / potato mine / chomper / explode-o-nut behaviour
        pm = p.clean
        # Collect every KillAllZombiesInRadius(this.mRow, ..., radius, rowRange, burn, ...)
        # call and identify the weapons by their radius (the code has one call per plant).
        explosions = {}
        for m in re.finditer(
                r"KillAllZombiesInRadius\(this\.mRow, [^,]+, [^,]+, (\d+), (\d+), (\w+),", pm):
            radius = int(m.group(1))
            explosions[radius] = {
                "radius": radius,
                "rowRange": int(m.group(2)),
                "burn": m.group(3) == "true",
                "damage": self._kill_damage(),
                "line": p.line_of(m.start()),
            }
        self._explosions = explosions
        self._cherry = {
            "fuseTicks": int(re.search(
                r"theSeedType == SeedType\.Cherrybomb\)\s*\{[^}]*?mDoSpecialCountdown = (\d+);",
                pm, re.S).group(1)),
            "explosion": explosions[115],
        }
        self._potato = {
            "armTicks": int(re.search(
                r"theSeedType == SeedType\.Potatomine\)\s*\{[^}]*?mStateCountdown = (\d+);",
                pm, re.S).group(1)),
            "explosion": explosions[60],
        }
        chomp = pm[pm.find("public void UpdateChomper()"):]
        chomp = chomp[:chomp.find("public void AnimateSleeping()")]
        self._chomper = {
            "biteWindupTicks": int(re.search(r"mStateCountdown = (\d+);", chomp).group(1)),
            "digestTicks": int(re.search(r"mStateCountdown = (\d+);", chomp[chomp.find("ChomperDigesting"):]).group(1)),
            "gargantuarDamage": int(re.search(r"zombie2\.TakeDamage\((\d+), 0U\);", chomp).group(1)),
        }
        self._explodeonut = dict(explosions[90])
        # snow pea chill
        z = self.zombie_src
        self.chill_ticks = int(re.search(r"int num = (\d+);\s*if \(theIsIceTrap\)\s*\{\s*num = (\d+);",
                                         z.clean[z.clean.find("public void ApplyChill"):]).group(1))
        self.ice_trap_chill_ticks = int(re.search(r"int num = (\d+);\s*if \(theIsIceTrap\)\s*\{\s*num = (\d+);",
                                                  z.clean[z.clean.find("public void ApplyChill"):]).group(2))
        # repeater second shot fires when mLaunchCounter == 25
        self.repeater_second_shot_counter = int(re.search(
            r"this\.mLaunchCounter == (\d+)\)\s*\{\s*if \(this\.mSeedType == SeedType\.Repeater",
            pm).group(1))
        self._cite_consts["chomper"] = p.cite("public void UpdateChomper()")
        self._cite_consts["chill"] = z.cite("public void ApplyChill(bool theIsIceTrap)")

    def _parse_explosion(self, anchor: str, name: str) -> dict:
        """Parse `KillAllZombiesInRadius(this.mRow, x, y, radius, rowRange, burn, flags)`."""
        pm = self.plant_src.clean
        i = pm.find(anchor)
        if i < 0:
            raise LookupError("%s explosion anchor not found" % name)
        m = re.search(r"KillAllZombiesInRadius\(this\.mRow, (?:num|num2), (?:num|num2), (\d+), (\d+), (\w+),",
                      pm[i:i + 5000])
        if not m:
            raise LookupError("%s KillAllZombiesInRadius call not found" % name)
        return {"radius": int(m.group(1)), "rowRange": int(m.group(2)),
                "burn": m.group(3) == "true", "damage": self._kill_damage()}

    def _kill_damage(self) -> int:
        src = self.board.clean
        i = src.find("public int KillAllZombiesInRadius")
        block = src[i:i + 3000]
        m = re.search(r"zombie\.TakeDamage\((\d+), 18U\);", block)
        if not m:
            raise LookupError("KillAllZombiesInRadius damage not found")
        return int(m.group(1))

    def plant_base_health(self, seed_type: str) -> int:
        """1:1 transcription of Plant.GetBaseHealth (Plant.cs:2762)."""
        e = self.plant_enum
        t = e[seed_type]
        if t <= e["Garlic"]:
            if t <= e["Tallnut"]:
                if t != e["Wallnut"]:
                    if t != e["Tallnut"]:
                        return 300
                    return 8000
                # Wallnut falls through
            elif t != e["Pumpkinshell"]:
                if t != e["Garlic"]:
                    return 300
                return 400
            # Wallnut / Pumpkinshell fall through
        elif t <= e["FireShroom"]:
            if t == e["Spikerock"]:
                return 450
            if t != e["FireShroom"]:
                return 300
            return 2000
        elif (t - e["ExplodeONut"] > 1) and (t - e["PeaWallnut"] > 2):
            return 300
        return 4000

    def plant_behavior(self, d: dict) -> dict:
        """Type-specific numeric behaviour for the early-adventure plants."""
        name = d["seedType"]
        out = OrderedDict()
        out["health"] = self.plant_base_health(name)
        out["healthSource"] = self._cite_consts["getBaseHealth"]
        launch = d["launchRateTicks"]
        out["launchRateTicks"] = launch
        out["launchRateSeconds"] = round(launch / TICKS_PER_SECOND, 3)

        if name in ("Peashooter", "Snowpea", "Repeater"):
            proj = "Snowpea" if name == "Snowpea" else "Pea"
            shots = 2 if name == "Repeater" else 1
            attack = OrderedDict([
                ("projectileType", proj),
                ("projectileDamage", self.projectiles[proj]["damage"]),
                ("projectileSpeedPxPerTick", self.pea_speed),
                ("projectileSpeedPxPerSecond", round(self.pea_speed * TICKS_PER_SECOND, 1)),
                ("shotsPerAttackCycle", shots),
                ("fireAnimationTicks", 26 if name == "Repeater" else 29),
                ("firstShotCountDownTicksRange", [0, launch]),
                ("nextShotCountDownTicksRange", [launch - 14, launch]),
                ("_source", [self._cite_consts["updateShooter"],
                             self._cite_consts["updateShooting"],
                             self._cite_consts["findTargetAndFire"]]),
            ])
            if name == "Repeater":
                attack["secondShotTriggerCounter"] = self.repeater_second_shot_counter
                attack["secondShotPolicy"] = (
                    "UpdateShooter() re-triggers FindTargetAndFire with "
                    "LaunchTime.RepeaterPrelaunch when mLaunchCounter == %d"
                    % self.repeater_second_shot_counter)
            if name == "Snowpea":
                attack["chill"] = {
                    "speedFactor": self.const["CHILLED_SPEED_FACTOR"],
                    "durationTicks": self.chill_ticks,
                    "durationSeconds": self.chill_ticks / TICKS_PER_SECOND,
                    "_source": self._cite_consts["chill"],
                }
            out["attack"] = attack
            out["production"] = None
            out["special"] = None
            return out

        if name == "Sunflower":
            out["attack"] = None
            out["production"] = OrderedDict([
                ("sunType", "Sun"),
                ("sunValue", self.sun_values.get("Sun", 25)),
                ("firstSunCountDownTicksRange", [300, launch // 2]),
                ("subsequentSunCountDownTicksRange", [launch - 150, launch]),
                ("_source", [self._cite_consts["updateProductionPlant"],
                             self._cite_consts["makesSun"]]),
            ])
            out["special"] = None
            return out

        if name == "Wallnut":
            out["attack"] = None
            out["production"] = None
            out["special"] = OrderedDict([
                ("kind", "wall"),
                ("_source", self._cite_consts["getBaseHealth"]),
            ])
            return out

        if name == "Cherrybomb":
            out["attack"] = None
            out["production"] = None
            out["special"] = OrderedDict([
                ("kind", "instantExplosion"),
                ("fuseTicks", self._cherry["fuseTicks"]),
                ("fuseSeconds", round(self._cherry["fuseTicks"] / TICKS_PER_SECOND, 3)),
                ("damage", self._cherry["explosion"]["damage"]),
                ("burn", self._cherry["explosion"]["burn"]),
                ("radius", self._cherry["explosion"]["radius"]),
                ("rowRange", self._cherry["explosion"]["rowRange"]),
                ("selfDestructs", True),
                ("_source", [self._cite_consts["doSpecial"],
                             self._cite_consts["plantInitialize"]]),
            ])
            return out

        if name == "Potatomine":
            out["attack"] = None
            out["production"] = None
            out["special"] = OrderedDict([
                ("kind", "mine"),
                ("armTicks", self._potato["armTicks"]),
                ("armSeconds", round(self._potato["armTicks"] / TICKS_PER_SECOND, 3)),
                ("damage", self._potato["explosion"]["damage"]),
                ("burn", self._potato["explosion"]["burn"]),
                ("radius", self._potato["explosion"]["radius"]),
                ("rowRange", self._potato["explosion"]["rowRange"]),
                ("trigger", "armed state explodes on first zombie in row"),
                ("selfDestructs", True),
                ("_source", [self._cite_consts["updatePotato"],
                             self._cite_consts["doSpecial"]]),
            ])
            return out

        if name == "Chomper":
            out["attack"] = None
            out["production"] = None
            out["special"] = OrderedDict([
                ("kind", "chomper"),
                ("biteWindupTicks", self._chomper["biteWindupTicks"]),
                ("instaKill", True),
                ("gargantuarDamage", self._chomper["gargantuarDamage"]),
                ("digestTicks", self._chomper["digestTicks"]),
                ("digestSeconds", round(self._chomper["digestTicks"] / TICKS_PER_SECOND, 3)),
                ("attackRectOffsetX", 80),
                ("_source", [self._cite_consts["updateChomper"],
                             self._cite_consts["getPlantAttackRect"]]),
            ])
            return out

        if name == "ExplodeONut":
            out["attack"] = None
            out["production"] = None
            out["special"] = OrderedDict([
                ("kind", "deathExplosion"),
                ("damage", self._explodeonut.get("damage", self._kill_damage())),
                ("burn", self._explodeonut["burn"]),
                ("radius", self._explodeonut["radius"]),
                ("rowRange", self._explodeonut["rowRange"]),
                ("_source", self._cite_consts["doSpecial"]),
            ])
            return out

        # fallback (not expected for the curated set)
        out["attack"] = None
        out["production"] = None
        out["special"] = None
        return out

    # -- zombie behaviour --------------------------------------------------
    def _parse_zombie_rules(self):
        z = self.zombie_src
        self._cite_consts.update({
            "zombieInitialize": z.cite("public void ZombieInitialize("),
            "getBaseBodyHealth": z.cite("public static int GetBaseBodyHealth(ZombieType type, LawnApp app)"),
            "getBaseHelmHealth": z.cite("public static int GetBaseHelmHealth(ZombieType type)"),
            "getBaseShieldHealth": z.cite("public static int GetBaseShieldHealth(ZombieType type)"),
            "pickRandomSpeed": z.cite("public void PickRandomSpeed()"),
            "eatPlant": z.cite("public void EatPlant(Plant thePlant)"),
            "checkIfPreyCaught": z.cite("public void CheckIfPreyCaught()"),
            "updateWalking": z.cite("public void UpdateZombieWalking()"),
            "updateWalkingIntoHouse": z.cite("public void UpdateZombieWalkingIntoHouse()"),
            "updatePolevaulter": z.cite("public void UpdateZombiePolevaulter()"),
            "baseBodyHealth270": z.cite("this.mBodyHealth = 270;"),
        })
        z.require("this.mBodyHealth = 270;")

    def zombie_body_health(self, ztype: str) -> int:
        """1:1 transcription of Zombie.GetBaseBodyHealth (Zombie.cs:12179)."""
        e = self.zombie_enum
        t = e[ztype]
        for names, hp in (
            (["Polevaulter", "Dancer", "DolphinRider", "JackInTheBox", "Pogo",
              "Ladder", "JalapenoHead"], 500),
            (["Zamboni", "Yeti"], 1350),
            (["Bungee"], 450),
            (["Catapult"], 850),
            (["Gargantuar"], 3000),
            (["RedeyeGargantuar"], 6000),
            (["RobotTitan", "RedeyeRobotTitan"], 750),
            (["Monk", "Ninja", "Talisman", "Propeller"], 540),
        ):
            if ztype in names:
                return hp
        # Imp: 70 in iZombie, otherwise falls through to 270
        # Boss: 40000 in Adventure/Quickplay
        if ztype == "Boss":
            return 40000
        return 270

    def zombie_helm_health(self, ztype: str) -> int:
        """1:1 transcription of Zombie.GetBaseHelmHealth (Zombie.cs:12231)."""
        table = {
            "TrafficCone": 370, "Pail": 1100, "Football": 1400,
            "Bobsled": 300, "Digger": 100, "WallnutHead": 1100,
            "TallnutHead": 2200, "RobotTitan": 2250, "RedeyeRobotTitan": 5250,
            "FootballPremium": 2800,
        }
        return table.get(ztype, 0)

    def zombie_speed(self, ztype: str) -> dict:
        """Transcription of Zombie.PickRandomSpeed (Zombie.cs:2473) for early types."""
        default = {"kind": "randomRange", "minPxPerTick": 0.23, "maxPxPerTick": 0.37}
        if ztype == "Flag":
            return {"kind": "fixed", "pxPerTick": 0.45}
        if ztype == "Polevaulter":
            return {
                "kind": "randomRange", "minPxPerTick": 0.66, "maxPxPerTick": 0.68,
                "phase": "PolevaulterPreVault",
                "postVault": "walker (vault velocity is computed from jump distance / animation duration)",
            }
        return default

    def zombie_behavior(self, d: dict) -> dict:
        name = d["zombieType"]
        body = self.zombie_body_health(name)
        helm = self.zombie_helm_health(name)
        speed = self.zombie_speed(name)
        spd = dict(speed)
        if speed["kind"] == "randomRange":
            spd["minPxPerSecond"] = round(speed["minPxPerTick"] * TICKS_PER_SECOND, 1)
            spd["maxPxPerSecond"] = round(speed["maxPxPerTick"] * TICKS_PER_SECOND, 1)
        else:
            spd["pxPerSecond"] = round(speed["pxPerTick"] * TICKS_PER_SECOND, 1)
        spd["chilledFactor"] = self.const["CHILLED_SPEED_FACTOR"]

        eat = OrderedDict([
            ("damagePerBite", self.const["TICKS_BETWEEN_EATS"]),
            ("biteIntervalTicks", self.const["TICKS_BETWEEN_EATS"]),
            ("chilledBiteIntervalTicks", self.const["TICKS_BETWEEN_EATS"] * 2),
            ("damagePerSecond", self.const["TICKS_BETWEEN_EATS"] * TICKS_PER_SECOND / self.const["TICKS_BETWEEN_EATS"]),
            ("_source", [self._cite_consts["checkIfPreyCaught"],
                         self._cite_consts["eatPlant"],
                         self._cite_consts["TICKS_BETWEEN_EATS"]]),
        ])

        special = OrderedDict()
        if name == "Flag":
            special["flagBearer"] = True
            special["note"] = ("Flag zombies are never picked by weight (pickWeight=0); "
                               "PickZombieWaves inserts one per flag wave.")
        if name == "Polevaulter":
            special["vault"] = OrderedDict([
                ("triggersWhenPlantAhead", True),
                ("vaultPhase", "PolevaulterPreVault -> PolevaulterInVault -> PolevaulterPostVault"),
                ("tallnutBlocks", True),
                ("_source", self._cite_consts["updatePolevaulter"]),
            ])
        if name == "TrafficCone":
            special["helmType"] = "TrafficCone"
        if name == "Pail":
            special["helmType"] = "Pail"

        walk_house_mult = 2 if name in ("Normal", "Pail", "TrafficCone") else 1
        if name not in ("Normal", "Pail", "TrafficCone"):
            walk_house_mult = None

        return OrderedDict([
            ("bodyHealth", body),
            ("helmHealth", helm),
            ("totalHealth", body + helm),
            ("flyingHealth", 0),
            ("speed", spd),
            ("eating", eat),
            ("walkIntoHouseSpeedMultiplier", walk_house_mult),
            ("chillDurationTicks", self.chill_ticks),
            ("iceTrapChillDurationTicks", self.ice_trap_chill_ticks),
            ("special", special if special else None),
            ("_source", [dict(d["_source_line"]),
                         self._cite_consts["getBaseBodyHealth"],
                         self._cite_consts["getBaseHelmHealth"],
                         self._cite_consts["pickRandomSpeed"]]),
        ])

    # -- helper used by units JSON ----------------------------------------
    def localized(self, key: str) -> dict:
        return {"en": self.lang_en.get(key), "zh_cn": self.lang_zh.get(key)}


# ---------------------------------------------------------------------------
# wave generation (re-implementation of Board.PickZombieWaves)
# ---------------------------------------------------------------------------
class SimRng:
    """Documented stand-in for Sexy.RandomNumbers (runtime-seeded MersenneTwister)."""

    def __init__(self, seed):
        self._r = random.Random(seed)
        self.calls = 0

    def next_number(self, ceiling: int) -> int:
        if ceiling <= 0:
            raise ValueError("NextNumber ceiling must be > 0")
        self.calls += 1
        return self._r.randrange(ceiling)


class WaveGenerator:
    def __init__(self, data: GameData, seed: int):
        self.data = data
        self.seed = seed
        self.ze = data.zombie_enum
        self.zd = {d["zombieType"]: d for d in data.zombie_defs}
        self.zombie_order = [d["zombieType"] for d in data.zombie_defs
                             if 0 <= self.ze[d["zombieType"]] < self.ze["ZombieTypesCount"]]
        self.zombietypes_count_index = self.ze["ZombieTypesCount"]
        self.robot_titan_index = self.ze["RobotTitan"]

    # CanZombieSpawnOnLevel() (Board.cs:9323)
    def can_zombie_spawn_on_level(self, ztype: str, level: int) -> bool:
        d = self.zd[ztype]
        if ztype == "Yeti":
            # CanSpawnYetis() is false in first-time Adventure (LawnApp.cs:2797)
            return False
        if level < d["startingLevel"]:
            return False
        if d["pickWeight"] == 0:
            return False
        if self.ze[ztype] >= self.robot_titan_index:  # non-hard Adventure
            return False
        if ztype not in self.data.zombie_allowed_levels:
            return False
        idx = min(max(level - 1, 0), 49)
        return self.data.zombie_allowed_levels[ztype][idx] != 0

    def allowed_zombies(self, level: int) -> "OrderedDict[str,dict]":
        out = OrderedDict()
        for ztype in self.zombie_order:
            if self.can_zombie_spawn_on_level(ztype, level):
                out[ztype] = self.zd[ztype]
        return out

    # GetIntroducedZombieType() (Board.cs:10946)
    def introduced_zombie(self, level: int):
        if level == 1:
            return None
        for ztype in self.zombie_order:
            d = self.zd[ztype]
            if ztype == "Yeti":
                continue
            if d["startingLevel"] == level and self.ze[ztype] < self.robot_titan_index:
                return ztype
        return None

    # IsFlagWave()/GetNumWavesPerFlag() for first-time Adventure (Board.cs:11773, :12977)
    def waves_per_flag(self, num_waves: int) -> int:
        if num_waves < 10:
            return num_waves
        return 10

    def is_flag_wave(self, level: int, wave_index: int, num_waves: int) -> bool:
        if level == 1:  # first-time Adventure level 1 has no flag waves
            return False
        wpf = self.waves_per_flag(num_waves)
        return wave_index % wpf == wpf - 1

    # PickZombieType() (Board.cs:2312) -- adventure subset
    def pick_zombie_type(self, allowed, points: int, wave_index: int, rng: SimRng) -> str:
        weights = []
        for ztype in self.zombie_order:
            if ztype not in allowed:
                continue
            d = self.zd[ztype]
            if wave_index + 1 < d["firstAllowedWave"]:
                continue
            if points < d["zombieValue"]:
                continue
            weights.append((ztype, d["pickWeight"]))
        if not weights:
            raise RuntimeError("PickZombieType: no eligible zombie (points=%d wave=%d)" % (points, wave_index))
        total = sum(w for _, w in weights)
        pick = rng.next_number(total)
        acc = 0
        for ztype, w in weights:
            acc += w
            if pick < acc:
                return ztype
        raise RuntimeError("weighted pick fell through")

    def generate_waves(self, level: int) -> dict:
        data = self.data
        num_waves = data.g_zombie_waves[min(max(level - 1, 0), 49)]
        allowed = self.allowed_zombies(level)
        introduced = self.introduced_zombie(level)
        mode_multiplier = 1
        if level == 5:  # Wall-nut Bowling -> IsWallnutBowlingLevel multiplier
            mode_multiplier = data.wallnut_bowling_multiplier
        elif level == 10:  # mini boss -> IsMiniBossLevel multiplier
            mode_multiplier = data.mini_boss_multiplier

        rng = SimRng("pgvz-level-waves:%d:%d" % (self.seed, level))
        waves = []
        for i in range(num_waves):
            counts = Counter()
            order = []
            forced = OrderedDict([
                ("flagEscortNormals", 0),
                ("flagZombie", False),
                ("introduced", None),
                ("missingZombies", []),
            ])
            points = i // data.wave_point_divisor + data.wave_point_offset
            initial_points = points
            flag = self.is_flag_wave(level, i, num_waves)
            flag_multiplier = 1.0
            if flag:
                escort = min(points, data.flag_escort_max)
                flag_multiplier = data.flag_point_multiplier
                points = int(points * data.flag_point_multiplier)
                for _ in range(escort):
                    order.append("Normal")
                    counts["Normal"] += 1
                order.append("Flag")
                counts["Flag"] += 1
                forced["flagEscortNormals"] = escort
                forced["flagZombie"] = True
                points -= escort + self.zd["Flag"]["zombieValue"]
            points_after_flag = points
            points *= mode_multiplier

            if introduced is not None:
                insert = (i == num_waves // 2) or (i == num_waves - 1)
                if insert:
                    order.append(introduced)
                    counts[introduced] += 1
                    forced["introduced"] = introduced
                    points -= self.zd[introduced]["zombieValue"]

            if i == num_waves - 1:
                for ztype in self.zombie_order:
                    if counts[ztype] <= 0 and ztype != "Yeti" and self.can_zombie_spawn_on_level(ztype, level):
                        order.append(ztype)
                        counts[ztype] += 1
                        forced["missingZombies"].append(ztype)
                        points -= self.zd[ztype]["zombieValue"]

            points_before_picks = points
            while points > 0 and len(order) < data.const["MAX_ZOMBIES_IN_WAVE"]:
                ztype = self.pick_zombie_type(allowed, points, i, rng)
                order.append(ztype)
                counts[ztype] += 1
                points -= self.zd[ztype]["zombieValue"]

            waves.append(OrderedDict([
                ("index", i),
                ("flag", flag),
                ("initialZombiePoints", initial_points),
                ("flagPointMultiplier", flag_multiplier),
                ("modePointMultiplier", mode_multiplier),
                ("zombiePointsBeforeRandomPicks", points_before_picks),
                ("zombiePointsRemaining", points),
                ("zombies", order),
                ("counts", OrderedDict(sorted(counts.items()))),
                ("forced", forced),
            ]))
        return {
            "numWaves": num_waves,
            "flagWaves": [w["index"] for w in waves if w["flag"]],
            "waves": waves,
            "rngCalls": rng.calls,
        }


# ---------------------------------------------------------------------------
# level objects
# ---------------------------------------------------------------------------
def stage_string(level: int) -> str:
    """LawnApp.GetStageString(): world-sub (LawnApp.cs:2142)."""
    world = min(max((level - 1) // 10 + 1, 1), 6)
    sub = level - (world - 1) * 10
    return "%d-%d" % (world, sub)


def build_level(data: GameData, gen: WaveGenerator, level: int) -> dict:
    bg = data.background_for_level(level)
    seed_bank = data.seed_bank_for_level(level)
    waves = gen.generate_waves(level)

    initial_countdown = data.initial_countdown_default
    initial_countdown_note = "default (Board.InitZombieWaves)"
    initial_countdown_source = data._cite_consts["initZombieWaves"]
    if level == 2:
        initial_countdown = data.initial_countdown_level2
        initial_countdown_note = "level 2 first-time tutorial delay"
        initial_countdown_source = data._cite_consts["level2InitialCountDown"]
    if level == 5:
        initial_countdown = data.wallnut_bowling_initial_countdown
        initial_countdown_note = "Wall-nut Bowling: Challenge.InitLevel override"
        initial_countdown_source = data._cite_consts["wallnutBowlingInitialCountDown"]
    wallnut_bowling = level == 5

    timing = OrderedDict([
        ("initialWaveCountDownTicks", initial_countdown),
        ("initialWaveCountDownNote", initial_countdown_note),
        ("initialWaveCountDownSource", initial_countdown_source),
        ("nonFlagWaveCountDown", {
            "baseTicks": data.normal_wave_countdown[0],
            "randomExtraMaxExclusive": data.normal_wave_countdown[1],
            "note": "2500 + RandomNumbers.NextNumber(600)",
            "_source": data._cite_consts["normalWaveCountDown"],
        }),
        ("flagWaveCountDownTicks", None if wallnut_bowling else data.flag_wave_countdown),
        ("flagWaveCountDownNote",
         "Wall-nut Bowling never uses the 4500 flag countdown (flag variable in "
         "UpdateZombieSpawning) - it falls through to the normal formula."
         if wallnut_bowling else
         "set when the just-spawned wave was a flag wave"),
        ("healthToNextWaveFractionRange", list(data.health_next_wave_fraction)),
        ("healthShortcut", {
            "minWaveAgeTicks": data.health_shortcut_age,
            "minCountDownTicks": data.health_shortcut_min,
            "note": "if the previous wave's remaining total HP <= mZombieHealthToNextWave "
                    "and the countdown is still > 200, the countdown is shortened to 200",
        }),
        ("hugeWaveCountDownTicks", data.huge_wave_countdown),
        ("hugeWaveTrigger", "mZombieCountDown == 5 on a flag wave; after the 750-tick "
                            "warning the current wave spawns next (countdown set to 1)"),
        ("finalWaveSoundDelayTicks", 60),
        ("_source", [data._cite_consts["updateZombieSpawning"],
                     data._cite_consts["spawnZombieWave"]]),
    ])

    has_flags = bool(waves["flagWaves"])
    meter = OrderedDict([
        ("hasFlags", has_flags),
        ("wavesPerFlag", gen.waves_per_flag(waves["numWaves"])),
        ("totalWidthPixels", 150),
        ("flagNotchPixels", data.meter_flag_notch),
        ("note", "Board.UpdateProgressMeter / DrawProgressMeter; mProgressMeterWidth in pixels"),
        ("_source", data._cite_consts["updateProgressMeter"]),
    ])

    allowed = gen.allowed_zombies(level)
    allowed_list = [OrderedDict([
        ("zombieType", z),
        ("zombieValue", d["zombieValue"]),
        ("firstAllowedWave", d["firstAllowedWave"]),
        ("pickWeight", d["pickWeight"]),
    ]) for z, d in allowed.items()]

    special = OrderedDict()
    if level == 5:
        special["prePlantedPlants"] = [
            {"gridX": 5, "gridY": 1, "seedType": "Peashooter"},
            {"gridX": 7, "gridY": 2, "seedType": "Peashooter"},
            {"gridX": 6, "gridY": 3, "seedType": "Peashooter"},
        ]
        special["_source"] = data.challenge.cite("this.mBoard.NewPlant(5, 1, SeedType.Peashooter")
    if level == 2:
        special["tutorial"] = "sunflower tutorial (mZombieCountDown = 5000)"
    if level == 1:
        special["tutorial"] = "peashooter tutorial, no flag waves"

    return OrderedDict([
        ("level", level),
        ("stage", stage_string(level)),
        ("world", (level - 1) // 10 + 1),
        ("worldSub", (level - 1) % 10 + 1),
        ("gameMode", "Adventure"),
        ("firstTimeAdventure", True),
        ("background", bg),
        ("startingSun", data.start_sun_level1 if level == 1 else data.start_sun_default),
        ("startingSunNote", "Board.InitLevel: 150 for first-time level 1, otherwise 50"),
        ("seedBank", seed_bank),
        ("numWaves", waves["numWaves"]),
        ("flagWaves", waves["flagWaves"]),
        ("wavesPerFlag", gen.waves_per_flag(waves["numWaves"])),
        ("progressMeter", meter),
        ("zombieSpawning", timing),
        ("introducedZombie", gen.introduced_zombie(level)),
        ("allowedZombies", allowed_list),
        ("waves", waves["waves"]),
        ("waveRngCalls", waves["rngCalls"]),
        ("special", special if special else None),
        ("_source", [data._cite_consts["initLevel"],
                     data._cite_consts["initZombieWaves"],
                     data._cite_consts["pickZombieWaves"]]),
    ])


# ---------------------------------------------------------------------------
# plants / zombies JSON
# ---------------------------------------------------------------------------
PLANT_SET = ["Peashooter", "Sunflower", "Wallnut", "Cherrybomb", "Snowpea",
             "Chomper", "Potatomine", "Repeater", "ExplodeONut"]
ZOMBIE_SET = ["Normal", "Flag", "TrafficCone", "Pail", "Polevaulter"]

ZOMBIE_ALIASES = {
    "TrafficCone": ["Conehead", "ConeheadZombie"],
    "Pail": ["Buckethead", "BucketheadZombie"],
    "Polevaulter": ["Polevaulting", "PolevaultingZombie"],
    "Normal": ["Basic", "BasicZombie"],
    "Flag": ["FlagZombie"],
}


def build_plants(data: GameData) -> dict:
    defs = {d["seedType"]: d for d in data.plant_defs}
    plants = []
    for name in PLANT_SET:
        if name not in defs:
            raise LookupError("plant definition missing: %s" % name)
        d = defs[name]
        reanim = data.reanimation_params.get(d["reanimation"], {})
        entry = OrderedDict([
            ("seedType", name),
            ("displayNameKey", d["nameKey"]),
            ("localizedNames", data.localized(d["nameKey"])),
            ("sunCost", d["sunCost"]),
            ("refreshTicks", d["refreshTicks"]),
            ("refreshSeconds", round(d["refreshTicks"] / TICKS_PER_SECOND, 3)),
            ("packetIndex", d["packetIndex"]),
            ("subClass", d["subClass"]),
        ])
        entry.update(data.plant_behavior(d))
        entry["reanimation"] = OrderedDict([
            ("type", d["reanimation"]),
            ("resourcePath", reanim.get("resourcePath")),
            ("isSpine", reanim.get("isSpine", False)),
            ("legacyResourcePath", reanim.get("legacyResourcePath")),
            ("spineScale", reanim.get("spineScale")),
            ("_source", data.game_constants.cite("ReanimationParams(ReanimationType.%s" % d["reanimation"])
             if ("ReanimationParams(ReanimationType.%s" % d["reanimation"]) in data.game_constants.text
             else data.game_constants.cite("ReanimationParams[]")),
        ])
        entry["_source"] = OrderedDict([
            ("definition", data.game_constants.cite('new PlantDefinition(SeedType.%s,' % name)),
            ("class", data.plant_src.cite("public class Plant") if "public class Plant" in data.plant_src.text
             else data.plant_src.cite("public static int GetBaseHealth")),
        ])
        plants.append(entry)
    return OrderedDict([
        ("_schema", OrderedDict([
            ("tickMilliseconds", TICK_MS),
            ("ticksPerSecond", TICKS_PER_SECOND),
            ("description", "plants needed by Adventure Day levels 1-10 (fixed banks, "
                            "chooser offers and conveyor pools) plus Explode-O-Nut used by "
                            "the Wall-nut Bowling conveyor (1-5)."),
            ("units", "all *_Ticks values are game updates (1 tick = 10 ms, 100 ticks/s)"),
            ("fields", OrderedDict([
                ("sunCost", "PlantDefinition.mSeedCost (sun)"),
                ("refreshTicks", "PlantDefinition.mRefreshTime (seed packet recharge)"),
                ("launchRateTicks", "PlantDefinition.mLaunchRate (shoot / sun production interval)"),
                ("health", "Plant.GetBaseHealth(seedType)"),
                ("attack.projectileDamage", "GameConstants.gProjectileDefinition"),
                ("special", "class-code behaviour (fuse, arm, bite, explosion)"),
            ])),
        ])),
        ("_meta", OrderedDict([
            ("game", "PlantGirlsVsZombies (PGvZ 1.3.2)"),
            ("generatedBy", "plangirls-web/tools/extract_levels.py"),
            ("sourceRoot", GAME_DECOMPILED),
            ("tickRate", OrderedDict([
                ("ticksPerSecond", TICKS_PER_SECOND),
                ("tickMilliseconds", TICK_MS),
                ("_source", data._cite_consts["tickRate"]),
            ])),
            ("sourceTables", OrderedDict([
                ("plantDefinitions", data._cite_consts["gPlantDefs"]),
                ("reanimations", data._cite_consts["gLawnReanimationArray"]),
                ("projectileDefinitions", data._cite_consts["gProjectileDefinition"]),
                ("baseHealth", data._cite_consts["getBaseHealth"]),
                ("straightProjectileSpeed", data._cite_consts["peaSpeed"]),
                ("chill", data._cite_consts["applyChill"]),
                ("explosionDamage", data._cite_consts["killAllZombiesInRadius"]),
            ])),
        ])),
        ("plants", plants),
    ])


def build_zombies(data: GameData) -> dict:
    defs = {d["zombieType"]: d for d in data.zombie_defs}
    zombies = []
    for name in ZOMBIE_SET:
        if name not in defs:
            raise LookupError("zombie definition missing: %s" % name)
        d = defs[name]
        reanim = data.reanimation_params.get(d["reanimation"], {})
        entry = OrderedDict([
            ("zombieType", name),
            ("aliases", ZOMBIE_ALIASES.get(name, [])),
            ("displayNameKey", d["nameKey"]),
            ("localizedNames", data.localized(d["nameKey"])),
            ("zombieValue", d["zombieValue"]),
            ("startingLevel", d["startingLevel"]),
            ("firstAllowedWave", d["firstAllowedWave"]),
            ("pickWeight", d["pickWeight"]),
        ])
        d2 = dict(d)
        d2["_source_line"] = data.game_constants.cite('new ZombieDefinition(ZombieType.%s,' % name)
        entry.update(data.zombie_behavior(d2))
        entry["reanimation"] = OrderedDict([
            ("type", d["reanimation"]),
            ("resourcePath", reanim.get("resourcePath")),
            ("isSpine", reanim.get("isSpine", False)),
            ("legacyResourcePath", reanim.get("legacyResourcePath")),
            ("spineScale", reanim.get("spineScale")),
        ])
        entry["rects"] = OrderedDict([
            ("zombieRect", [36, 0, 42, 115]),
            ("attackRect", [50, 0, 20, 115]),
            ("note", "Zombie.ZombieInitialize defaults (Zombie.cs:345-346); "
                     "Polevaulter overrides attackRect to (-29,0,70,115) before vault"),
        ])
        entry["_source"] = OrderedDict([
            ("definition", data.game_constants.cite('new ZombieDefinition(ZombieType.%s,' % name)),
            ("initialize", data._cite_consts["zombieInitialize"]),
            ("health", data._cite_consts["getBaseBodyHealth"]),
            ("helm", data._cite_consts["getBaseHelmHealth"]),
            ("speed", data._cite_consts["pickRandomSpeed"]),
        ])
        zombies.append(entry)
    return OrderedDict([
        ("_schema", OrderedDict([
            ("tickMilliseconds", TICK_MS),
            ("ticksPerSecond", TICKS_PER_SECOND),
            ("description", "zombies needed by Adventure Day levels 1-10 "
                            "(Normal, Flag, Conehead/TrafficCone, Buckethead/Pail, Polevaulter)"),
            ("units", "all *_Ticks values are game updates (1 tick = 10 ms, 100 ticks/s); "
                      "speed is px/tick of horizontal movement (mPosX -= mVelX)"),
            ("fields", OrderedDict([
                ("bodyHealth", "Zombie.GetBaseBodyHealth"),
                ("helmHealth", "Zombie.GetBaseHelmHealth (armour absorbed before body)"),
                ("totalHealth", "bodyHealth + helmHealth"),
                ("speed", "Zombie.PickRandomSpeed (px/tick)"),
                ("eating", "Zombie.CheckIfPreyCaught/EatPlant: TICKS_BETWEEN_EATS damage "
                           "every TICKS_BETWEEN_EATS ticks"),
                ("zombieValue", "wave point cost (ZombieDefinition.mZombieValue)"),
                ("firstAllowedWave", "1-based wave number gate in Board.PickZombieType"),
                ("startingLevel", "first Adventure level the type may spawn on"),
                ("pickWeight", "weight in Board.PickZombieType; 0 = never picked"),
            ])),
        ])),
        ("_meta", OrderedDict([
            ("game", "PlantGirlsVsZombies (PGvZ 1.3.2)"),
            ("generatedBy", "plangirls-web/tools/extract_levels.py"),
            ("sourceRoot", GAME_DECOMPILED),
        ])),
        ("_sourceTables", OrderedDict([
            ("zombieDefinitions", data._cite_consts["gZombieDefs"]),
            ("zombieAllowedLevels", data._cite_consts["gZombieAllowedLevels"]),
            ("reanimations", data._cite_consts["gLawnReanimationArray"]),
            ("bodyHealth", data._cite_consts["getBaseBodyHealth"]),
            ("helmHealth", data._cite_consts["getBaseHelmHealth"]),
            ("speed", data._cite_consts["pickRandomSpeed"]),
            ("walking", data._cite_consts["updateZombieWalking"]),
            ("eating", data._cite_consts["TICKS_BETWEEN_EATS"]),
            ("chill", data._cite_consts["applyChill"]),
        ])),
        ("zombies", zombies),
    ])


# ---------------------------------------------------------------------------
# levels.json
# ---------------------------------------------------------------------------
def build_levels(data: GameData, gen: WaveGenerator, levels) -> dict:
    level_objs = [build_level(data, gen, lv) for lv in levels]

    wave_schema = OrderedDict([
        ("index", "0-based wave index; Board.mCurrentWave at spawn time"),
        ("flag", "IsFlagWave(index) - flag 'huge wave'"),
        ("initialZombiePoints", "i/3 + 1 (first-time Adventure formula, Board.PickZombieWaves)"),
        ("flagPointMultiplier", "2.5 on flag waves, else 1.0"),
        ("modePointMultiplier", "4 on Wall-nut Bowling (1-5), 3 on mini-boss (1-10), else 1"),
        ("zombiePointsBeforeRandomPicks", "remaining point budget when the random pick loop starts "
                                          "(may be negative after forced zombies)"),
        ("zombiePointsRemaining", "budget after the random pick loop"),
        ("zombies", "ordered list of ZombieType names; order is the spawn order used by "
                    "Board.SpawnZombieWave (mZombiesInWave[row0..n])"),
        ("counts", "per-type counts"),
        ("forced", "flagEscortNormals: min(points,8) Normal zombies + 1 Flag inserted on a flag wave; "
                   "introduced: ZombieDefinition with startingLevel == level inserted at "
                   "middle and last wave; missingZombies: PutInMissingZombies adds every allowed "
                   "type not yet present in the last wave"),
    ])

    return OrderedDict([
        ("_schema", OrderedDict([
            ("description", "Adventure mode level + wave data for levels %s, extracted from "
                            "the decompiled PlantGirlsVsZombies C#." % (
                                ",".join(str(l) for l in levels))),
            ("tickMilliseconds", TICK_MS),
            ("ticksPerSecond", TICKS_PER_SECOND),
            ("timeUnit", "1 tick = one game update = 10 ms (Sexy/Main.cs:39 TargetElapsedTime = 0.01 s)"),
            ("levelFields", OrderedDict([
                ("level", "Adventure level number, 1-based (Board.mLevel / PlayerInfo.mLevel)"),
                ("stage", "world-sub label, LawnApp.GetStageString"),
                ("background", "BackgroundType + image resource id/path (Board.PickBackground)"),
                ("startingSun", "Board.InitLevel mSunMoney"),
                ("seedBank", "kind=fixed|playerChosen|conveyor. For playerChosen/conveyor the "
                             "ordered packet list is null (packets:null, equivalent to seedBank:null); "
                             "playerChosen lists chooserOffers, conveyor lists its cardPool/initialCards"),
                ("numWaves", "GameConstants.gZombieWaves[level-1] for first-time Adventure"),
                ("flagWaves", "indices where IsFlagWave() is true"),
                ("wavesPerFlag", "GetNumWavesPerFlag(); first-time levels with <10 waves use "
                                 "numWaves => only the last wave is a flag wave"),
                ("progressMeter", "progress bar / flag meter widths (pixels)"),
                ("zombieSpawning", "wave countdown rules from Board.UpdateZombieSpawning"),
                ("introducedZombie", "GetIntroducedZombieType() for the level, or null"),
                ("allowedZombies", "CanZombieSpawnOnLevel() true set with point cost/weight"),
                ("waves", "generated wave table"),
                ("waveRngCalls", "number of RNG draws used to generate the wave table"),
            ])),
            ("waveFields", wave_schema),
            ("waveGeneration", OrderedDict([
                ("algorithm", "Board.PickZombieWaves + Board.PickZombieType + "
                              "Board.PutZombieInWave + Board.PutInMissingZombies "
                              "(Board.cs:8392, :2312, :12195, :12226)"),
                ("rng", "the original uses Sexy.RandomNumbers -> MersenneTwister "
                        "MTRandom.Create(MTEdition.CokOpt_19937) seeded at process start, so "
                        "wave contents differ per run. This JSON was produced by "
                        "re-implementing the picker with a documented deterministic RNG seed, "
                        "giving one valid, reproducible realisation."),
                ("seed", gen.seed),
                ("rngPerLevelSeed", "\"pgvz-level-waves:<seed>:<level>\" passed to Python random.Random"),
                ("normalZombieAlwaysPickable", "Normal has zombieValue 1 / firstAllowedWave 1, so the "
                                               "final wave random loop can always drain the point budget"),
            ])),
            ("_unresolved", [
                "Exact RNG sequence cannot be reproduced (runtime-seeded MersenneTwister); wave lists "
                "are one reproducible realisation, see _schema.waveGeneration.rng.",
                "Zombie spawn row is chosen at runtime by Board.PickRowForNewZombie (weighted, "
                "prefers rows that were not recently lawn-mowered); rows are therefore not part of "
                "the data model.",
                "Levels 11-50 use the same Board.InitZombieWaves path but special levels (15,20,25,"
                "30,35,40,45,50) branch into Challenge.InitZombieWaves and are out of scope for this pass.",
            ]),
        ])),
        ("_meta", OrderedDict([
            ("game", "PlantGirlsVsZombies (PGvZ 1.3.2)"),
            ("gameMode", "Adventure (first play-through)"),
            ("generatedBy", "plangirls-web/tools/extract_levels.py"),
            ("seed", gen.seed),
            ("sourceRoot", GAME_DECOMPILED),
            ("tickRate", OrderedDict([
                ("ticksPerSecond", TICKS_PER_SECOND),
                ("tickMilliseconds", TICK_MS),
                ("_source", data._cite_consts["tickRate"]),
            ])),
            ("constants", OrderedDict([
                ("TICKS_BETWEEN_EATS", data.const["TICKS_BETWEEN_EATS"]),
                ("CHILLED_SPEED_FACTOR", data.const["CHILLED_SPEED_FACTOR"]),
                ("MAX_ZOMBIES_IN_WAVE", data.const["MAX_ZOMBIES_IN_WAVE"]),
                ("firstTimeAdventureFixedSeedBankLevelsInclusive", [1, 7]),
                ("chooserLevelsInclusive", [8, 9]),
                ("conveyorLevels", [5, 10]),
            ])),
            ("_source", data._cite_consts),
            ("_sourceTables", OrderedDict([
                ("zombieWaves", data._cite_consts["gZombieWaves"]),
                ("zombieAllowedLevels", data._cite_consts["gZombieAllowedLevels"]),
                ("zombieDefinitions", data._cite_consts["gZombieDefs"]),
                ("zombieWeightsAndPoints", data._cite_consts["pickZombieType"]),
                ("waveGenerator", data._cite_consts["pickZombieWaves"]),
                ("flagWaveRule", data._cite_consts["isFlagWave"]),
                ("wavesPerFlag", data._cite_consts["getNumWavesPerFlag"]),
                ("allowedZombieRule", data._cite_consts["canZombieSpawnOnLevel"]),
                ("introducedZombie", data._cite_consts["getIntroducedZombieType"]),
                ("missingZombies", data._cite_consts["putInMissingZombies"]),
                ("countDown", data._cite_consts["updateZombieSpawning"]),
                ("spawn", data._cite_consts["spawnZombieWave"]),
                ("progressMeter", data._cite_consts["updateProgressMeter"]),
                ("seedBank", data._cite_consts["chooseSeeds"]),
                ("numSeedsInBank", data._cite_consts["getNumSeedsInBank"]),
                ("conveyorBelt", data._cite_consts["hasConveyorBeltSeedBank"]),
                ("background", data._cite_consts["pickBackground"]),
                ("sunSpawning", data._cite_consts["updateSunSpawning"]),
            ])),
            ("_assumptions", [
                "Fresh profile: no store purchases (mPurchases[] all 0) and mPurchases[21]=0 "
                "(seed packet upgrade not bought) -> GetNumSeedsInBank uses base 6 packets.",
                "Adventure mode, first play-through (HasFinishedAdventure()==false).",
                "Non-hard Adventure (mAdventureModeHard==false).",
                "Level is played normally (not Quick Play which maps to QuickplayXX modes).",
            ]),
        ])),
        ("levels", level_objs),
    ])


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def parse_level_range(spec: str) -> list:
    out = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return sorted(set(out))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED,
                    help="deterministic wave-generation seed (default %d)" % DEFAULT_SEED)
    ap.add_argument("--levels", default=DEFAULT_LEVELS,
                    help="level list/range, e.g. 1-10 or 1,3,5 (default 1-10)")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output data directory")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    os.makedirs(args.out, exist_ok=True)
    levels = parse_level_range(args.levels)

    data = GameData()
    gen = WaveGenerator(data, args.seed)

    levels_obj = build_levels(data, gen, levels)
    plants_obj = build_plants(data)
    zombies_obj = build_zombies(data)

    writes = [
        ("levels.json", levels_obj),
        ("plants.json", plants_obj),
        ("zombies.json", zombies_obj),
    ]
    for fname, obj in writes:
        path = os.path.join(args.out, fname)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(obj, fh, ensure_ascii=False, indent=1)
            fh.write("\n")

    # ------- verify the written JSON reloads and has the expected shape -------
    verify = {
        "levels.json": ("levels", len(levels)),
        "plants.json": ("plants", len(plants_obj["plants"])),
        "zombies.json": ("zombies", len(zombies_obj["zombies"])),
    }
    for fname, (key, expected) in verify.items():
        path = os.path.join(args.out, fname)
        with open(path, "r", encoding="utf-8") as fh:
            loaded = json.load(fh)
        if key not in loaded or len(loaded[key]) != expected:
            raise RuntimeError("JSON verification failed for %s" % path)
        if "_schema" not in loaded:
            raise RuntimeError("JSON verification failed for %s: missing _schema" % path)

    # ------- summary -------
    if not args.quiet:
        total_waves = sum(lv["numWaves"] for lv in levels_obj["levels"])
        total_zombies = sum(len(w["zombies"]) for lv in levels_obj["levels"] for w in lv["waves"])
        print("PlantGirlsVsZombies - extract_levels.py")
        print("  source : %s" % GAME_DECOMPILED)
        print("  tick   : 1 tick = %d ms (%d ticks/s)" % (TICK_MS, TICKS_PER_SECOND))
        print("  output : %s" % args.out)
        print("  seed   : %d (deterministic wave realisation)" % args.seed)
        print("  plants : %d (%s)" % (len(plants_obj["plants"]),
                                      ", ".join(p["seedType"] for p in plants_obj["plants"])))
        print("  zombies: %d (%s)" % (len(zombies_obj["zombies"]),
                                      ", ".join(z["zombieType"] for z in zombies_obj["zombies"])))
        print("  levels : %d (waves generated: %d, zombies: %d)"
              % (len(levels_obj["levels"]), total_waves, total_zombies))
        for lv in levels_obj["levels"]:
            sb = lv["seedBank"]
            if sb["kind"] == "fixed":
                bank = "fixed[%d]: %s" % (sb["numPackets"], ",".join(sb["packets"]))
            elif sb["kind"] == "playerChosen":
                bank = "chosen x%d from %d offers" % (sb["numPackets"], len(sb["chooserOffers"]))
            else:
                bank = "conveyor x%d %s" % (sb["numPackets"], sb["special"])
            total_z = sum(len(w["zombies"]) for w in lv["waves"])
            print("    %-4s lvl %2d: sun=%-4d waves=%-2d flags=%-6s zombies=%-4d bg=%-9s %s"
                  % (lv["stage"], lv["level"], lv["startingSun"], lv["numWaves"],
                     str(lv["flagWaves"]), total_z, lv["background"]["type"], bank))
        for fname, _ in writes:
            path = os.path.join(args.out, fname)
            with open(path, "rb") as fh:
                size = len(fh.read())
            print("  wrote  : %s (%d bytes) [json OK]" % (path, size))
    return 0


if __name__ == "__main__":
    sys.exit(main())
