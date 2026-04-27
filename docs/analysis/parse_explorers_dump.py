#!/usr/bin/env python3
"""
Parse a deep-dump explorer log into a compact per-trait summary.

Input: a log file produced by Steward's `Tools → Diagnostics → Deep dump
explorer types`. Each explorer block starts with
    [LOG] ... [diag:expl] ====== Explorer GetType=N (Name) ======
and contains a `--- spec.skills (M items) ---` section listing trait
skills. The universal premium buff id=301 is skipped here — only
per-type traits are reported.

Output: human-readable text on stdout plus an aggregated bias hint.

Usage:
    python3 parse_explorers_dump.py <dump.txt>
"""

import re
import sys
from dataclasses import dataclass, field

LOG_PREFIX_RE = re.compile(r"^\[LOG\] \[[^\]]+\] \[diag:expl\] ?")
HEADER_RE = re.compile(r"====== Explorer GetType=(\d+) \((.+?)\) ======")
SECTION_SKILLS_RE = re.compile(r"--- spec\.skills \((\d+) items\) ---")
SKILL_HEADER_RE = re.compile(r"spec\.skills\[(\d+)\] id=(\d+) level=(\d+)")
SKILL_DEF_RE = re.compile(r"def: name_string=(.*?), id=(\d+), icon_string=(\S+)$")
EFFECT_RE = re.compile(
    r"\[(\d+)\] type_string=(.*?), modifier_string=(.*?), "
    r"multiplier=(.*?), adder=(.*?), value=(.*?), name_string=(.*), chance=(\S+)$",
    re.DOTALL,
)


@dataclass
class Effect:
    type_string: str
    modifier_string: str
    multiplier: float
    adder: float
    value: float
    name_string: str
    chance: float


@dataclass
class Skill:
    slot: int
    id: int
    level: int
    name_string: str = ""
    effects: list = field(default_factory=list)


@dataclass
class Explorer:
    get_type: int
    name: str
    skills: list = field(default_factory=list)


def strip_prefix(line: str) -> str:
    m = LOG_PREFIX_RE.match(line)
    return line[m.end() :] if m else line


def parse(path: str):
    with open(path, "r", encoding="utf-8") as f:
        raw_lines = f.readlines()

    # Pass 1: collapse multi-line continuations (long name_string lists)
    # into the effect line they belong to. Continuation lines lack the
    # `[LOG] ... [diag:expl]` prefix.
    collapsed = []
    for raw in raw_lines:
        if LOG_PREFIX_RE.match(raw):
            collapsed.append(raw.rstrip("\n"))
        else:
            if collapsed:
                # Strip leading whitespace, append to previous logical line.
                collapsed[-1] = collapsed[-1] + " " + raw.strip()

    explorers = []
    current: Explorer | None = None
    in_skills_section = False
    current_skill: Skill | None = None
    expecting_level_vector = False
    in_effects_block = False

    for line in collapsed:
        body = strip_prefix(line).strip()

        m = HEADER_RE.search(body)
        if m:
            current = Explorer(get_type=int(m.group(1)), name=m.group(2))
            explorers.append(current)
            in_skills_section = False
            current_skill = None
            continue

        if SECTION_SKILLS_RE.search(body):
            in_skills_section = True
            current_skill = None
            continue

        if not in_skills_section or current is None:
            continue

        # Inside spec.skills section
        m = SKILL_HEADER_RE.search(body)
        if m:
            current_skill = Skill(
                slot=int(m.group(1)),
                id=int(m.group(2)),
                level=int(m.group(3)),
            )
            current.skills.append(current_skill)
            in_effects_block = False
            continue

        if current_skill is None:
            continue

        m = SKILL_DEF_RE.search(body)
        if m:
            current_skill.name_string = m.group(1).strip()
            continue

        if "level_vector" in body:
            in_effects_block = True
            continue

        if in_effects_block:
            m = EFFECT_RE.search(body)
            if m:
                try:
                    eff = Effect(
                        type_string=m.group(2).strip(),
                        modifier_string=m.group(3).strip(),
                        multiplier=float(m.group(4)),
                        adder=float(m.group(5)),
                        value=float(m.group(6)),
                        name_string=m.group(7).strip(),
                        chance=float(m.group(8)),
                    )
                    current_skill.effects.append(eff)
                except ValueError:
                    pass

    return explorers


# Modifiers that produce a "find more / better loot" bias. Same list the
# doc's biasFromTrait() uses.
LOOT_MODIFIERS = {
    "changeloottablerolls",
    "changelootcount",
    "changelootchance",
}


def family_for(eff: Effect) -> str:
    tag = eff.type_string or eff.name_string.split(",", 1)[0]
    if tag.startswith("FindTreasure"):
        return "treasure"
    # IntrepidLoot is a loot-table identifier paired with the four
    # FindAdventureZone* variants by wildDetermination's effect list,
    # so treat it as adventure-family. See open question 5 in
    # EXPLORER_TRAITS.md for the structural reasoning.
    if (
        tag.startswith("FindAdventureZone")
        or tag.startswith("FindAdventure_")
        or tag.startswith("IntrepidLoot")
    ):
        return "adventure"
    if tag.startswith("FindDeposit"):
        return "deposit"
    return "other"


# Suffixes appended to base task type_strings to gate effects on a
# specific event. Keyed by the suffix Steward uses; values map to the
# event code Steward's `core.events` recognises (or None for tokens we
# haven't catalogued as events yet — those still classify the effect
# as seasonal-only, just without a code to consult at runtime).
EVENT_SUFFIX_TO_CODE = {
    "_Easter": "Easter",
    "_XMAS": "XMAS",
    "_Halloween": "HW",
    "_Valentine": "Valentine",
    "_SoccerResources": "Soccer",
    "_SoccerBalls": "Soccer",
    "_Anniversary": "Anniversary",
    "_RedNose": "RedNose",  # not yet in core/events/data.js
    "_SpecialistWeek": "SpecialistWeek",  # not yet in core/events/data.js
}

# Token used to mark a "lovely-themed" treasure variant family.
# Used by Lovely Explorer / Bewitching / Snowy traits — the variant
# is keyed on the trait owner, not on a calendar event.
LOVELY_TOKEN = "_Lovely"


def split_name_string(s: str):
    """Split a trait effect's name_string into individual entries.

    Strips whitespace and the truncation marker '…' (which the host
    inserts when the value runs past 240 chars in the diagnostics
    dumper). Returns (entries, truncated).
    """
    if not s:
        return [], False
    truncated = "…" in s
    cleaned = s.replace("…", "").strip().rstrip(",")
    entries = [e.strip() for e in cleaned.split(",") if e.strip()]
    return entries, truncated


def classify_entry(entry: str, type_tag: str):
    """Classify one name_string entry vs the effect's type_string.

    Returns one of:
      'plain'         - entry equals the base type_tag (year-round bonus)
      'lovely'        - entry includes the _Lovely token (Lovely-trait
                        private variant family)
      ('event', code) - entry has a recognised event suffix
      'trait-private' - entry has the FindTreasure_<TraitName>_* /
                        FindAdventure_<TraitName>_* shape — a per-trait
                        loot table the host activates whenever the
                        matching trait is on the dispatch (Princess Zoe,
                        Pirate, Royal Collector, etc.). Functionally
                        always-on for the owner.
      'other'         - some other tag we don't recognise
    """
    if entry == type_tag:
        return "plain"
    # Event suffix wins over the _Lovely token: a table like
    # 'FindTreasure_Lovely_Short_Easter' only exists when Easter is live,
    # so the runtime gate is the event, not the Lovely variant family.
    for suffix, code in EVENT_SUFFIX_TO_CODE.items():
        if entry.endswith(suffix) or (suffix + "_") in entry:
            return ("event", code)
    # Lovely-private variants without an event suffix — fire whenever the
    # Lovely Explorer is on the dispatch (host always-active for owner).
    if LOVELY_TOKEN in entry:
        return "lovely"
    # Trait-private drop tables: FindTreasure_<TraitName>_<Cat> or
    # FindAdventure_<TraitName>_<Cat>. The leading 'Find{Treasure,Adventure}_'
    # underscore-form distinguishes them from the suffixed event variants
    # ('FindTreasureShort_Easter') which embed the suffix at the END of
    # the type tag, not after a 'Find{Treasure,Adventure}_' prefix.
    if entry.startswith("FindTreasure_") or entry.startswith("FindAdventure_"):
        return "trait-private"
    # IntrepidLoot is a named loot table grouped with FindAdventureZone*
    # by `wildDetermination`. Functionally always-on for the trait owner.
    if entry == "IntrepidLoot":
        return "trait-private"
    return "other"


def classify_effect(eff: Effect):
    """Walk an effect's name_string list and decide whether the bonus
    fires year-round, only when an event is live, or both.

    Returns a dict with:
      mode:      'year-round' | 'event-gated' | 'lovely-gated' | 'mixed' | 'unknown'
      events:    sorted list of event codes the effect would gate on
                 (empty for year-round / lovely-gated / unknown)
      truncated: True when the host clipped the name_string at 240 chars
                 — caller should suspect there may be a hidden 'plain'
                 entry pushing the effect into 'year-round' or 'mixed'
    """
    type_tag = eff.type_string or ""
    entries, truncated = split_name_string(eff.name_string)

    if not entries:
        # No name_string filter — the effect fires whenever the host's
        # task has type_string == type_tag (the universal case for
        # most skills with empty name_string).
        return {"mode": "year-round", "events": [], "truncated": False}

    has_plain = False
    has_lovely = False
    has_trait_private = False
    event_codes = set()
    for e in entries:
        c = classify_entry(e, type_tag)
        if c == "plain":
            has_plain = True
        elif c == "lovely":
            has_lovely = True
        elif c == "trait-private":
            has_trait_private = True
        elif isinstance(c, tuple) and c[0] == "event":
            event_codes.add(c[1])

    # Year-round dimension: the bonus fires on the trait owner's normal
    # dispatches without needing an external trigger.
    always_on = has_plain or has_trait_private or has_lovely

    if always_on and event_codes:
        mode = "mixed"
    elif always_on:
        mode = "year-round"
    elif event_codes:
        mode = "event-gated"
    else:
        mode = "unknown"

    return {
        "mode": mode,
        "events": sorted(event_codes),
        "truncated": truncated,
    }


def bias_from_trait(skill: Skill, active_events=None, event_boost=0):
    """Score every effect into one of {treasure, adventure, deposit, other}.

    Loot modifiers contribute `max(adder, multiplier-1) * chance` (positive
    only). The `searchTime` modifier contributes `(1 - multiplier) * chance`
    (positive when the trait makes the family faster, negative when slower).
    Negative searchTime weights are kept — they represent a real "this
    family is actively discouraged" signal (Nora the Explorer is the
    canonical case).

    Seasonal gating: effects whose `name_string` filter lists ONLY
    event-suffixed variants (no plain entry) are gated on the event.
    Such effects only contribute to the score when one of their events
    appears in `active_events`. Pass `active_events=None` (default) to
    treat every event as live (useful for the always-on score). Pass an
    empty set for the off-event score.

    `event_boost`: when > 0 AND active_events is non-empty / 'ANY',
    add this constant to the treasure score. Implements the "no
    adventure during events" rule by ensuring treasure dominates over
    every observed adventure score (max ~4). Recommended production
    value is ≥1000. Default 0 keeps the trait's mechanical bias
    intact (used by the audit / off-event-default tooling).
    """
    if active_events is None:
        active_events = "ANY"  # sentinel — count every event-gated effect
    scores = {"treasure": 0.0, "adventure": 0.0, "deposit": 0.0, "other": 0.0}
    for eff in skill.effects:
        mod = eff.modifier_string.lower()
        chance = eff.chance if eff.chance else 1
        if mod in LOOT_MODIFIERS:
            weight = max(eff.adder, eff.multiplier - 1) * chance
            if weight <= 0:
                continue
        elif mod == "searchtime":
            weight = (1 - eff.multiplier) * chance
        else:
            continue

        # Apply seasonal gating. Effects with `mode='event-gated'` only
        # fire when one of their declared events is live; with
        # `mode='mixed'` the effect fires year-round on the plain entry
        # AND adds an event boost when active — but since we can't
        # cleanly split the weight between year-round and event-bonus
        # components from a single effect entry, we keep the whole weight
        # in the year-round bucket (conservative).
        cls = classify_effect(eff)
        if cls["mode"] == "event-gated":
            if active_events != "ANY":
                if not (set(cls["events"]) & set(active_events)):
                    continue
        scores[family_for(eff)] += weight

    # "No adventure during events" boost. Purely additive to OUR scoring;
    # never mutates the host's trait/skill objects. Caller controls
    # whether this fires via `event_boost` (wired from the
    # explorers.forceTreasureOnEvents setting).
    has_event = (active_events == "ANY") or bool(active_events)
    if event_boost > 0 and has_event:
        scores["treasure"] += event_boost

    return scores


def summarise(exp: Explorer):
    # Filter out the universal premium buff (id=301) — same on every type.
    traits = [s for s in exp.skills if s.id != 301]
    print(f"GetType={exp.get_type:>3}  {exp.name}")
    if not traits:
        print("    (no per-type trait — vanilla)")
        return
    for skill in traits:
        print(
            f"  Trait id={skill.id} {skill.name_string!r} level={skill.level}"
            f"  ({len(skill.effects)} effects)"
        )
        # Aggregate effects by (modifier, multiplier, adder, value, chance,
        # gating-mode, event-set). Long Lovely-style traits emit dozens of
        # near-identical effects across many task variants — collapsing
        # them keeps the output readable while still distinguishing
        # year-round from seasonally-gated rows.
        groups = {}
        for eff in skill.effects:
            cls = classify_effect(eff)
            key = (
                eff.modifier_string,
                eff.multiplier,
                eff.adder,
                eff.value,
                eff.chance,
                cls["mode"],
                tuple(cls["events"]),
            )
            groups.setdefault(key, {"effs": [], "truncated": False})
            groups[key]["effs"].append(eff)
            groups[key]["truncated"] = groups[key]["truncated"] or cls["truncated"]
        # All-effects gating verdict, used for the per-trait audit line.
        all_modes = {k[5] for k in groups.keys()}
        all_events = set()
        for k in groups.keys():
            all_events.update(k[6])

        for key, info in groups.items():
            mod, mul, add, val, ch, mode, events = key
            tags = sorted(
                {(e.type_string, e.name_string.split(",", 1)[0]) for e in info["effs"]}
            )
            shown_tags = []
            for t, n in tags:
                shown_tags.append(t if t else f"[{n}]")
            joined = ", ".join(shown_tags[:6])
            if len(shown_tags) > 6:
                joined += f", … (+{len(shown_tags) - 6})"
            gate = ""
            if mode == "event-gated":
                gate = f"  [seasonal: {','.join(events) or '?'}]"
            elif mode == "mixed":
                if events:
                    gate = f"  [year-round + seasonal: {','.join(events)}]"
                else:
                    gate = "  [year-round + lovely-gated]"
            elif mode == "lovely-gated":
                gate = "  [lovely-trait private variants]"
            elif mode == "unknown":
                gate = "  [unknown gating]"
            if info["truncated"]:
                gate += "  (name_string truncated — re-dump with higher MAX_VALUE_LEN to confirm)"
            print(
                f"      mod={mod} mul={mul} add={add} val={val} chance={ch}"
                f"  on: {joined}{gate}"
            )

        # Two scoring passes: off-event (no events live) and on-event
        # (every event live). Apart shows whether the trait is event-
        # sensitive at all.
        scores_off = bias_from_trait(skill, active_events=set())
        scores_on = bias_from_trait(skill, active_events=None)

        def _print_bias(label, scores):
            ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
            nz = [(k, v) for k, v in ranked if v > 0]
            if nz:
                best = nz[0][0]
                details = "  ".join(f"{k}={v:.2f}" for k, v in nz)
                print(f"    {label} → {best}  ({details})")
            else:
                print(f"    {label} → (no positive weight)")

        if scores_off == scores_on:
            _print_bias("bias", scores_off)
        else:
            _print_bias("bias (no event)  ", scores_off)
            _print_bias("bias (event live)", scores_on)

        # Per-trait gating verdict. Three real outcomes:
        #   ALWAYS — every credit fires on the trait owner's normal
        #            dispatches (no event needed).
        #   SEASONAL — every credit requires at least one event to be
        #              live; outside events the trait is functionally
        #              inert.
        #   MIXED — some credits always fire, others require an event.
        #           The recommendation should be the always-fire family
        #           year-round and BOTH (always + event boost) when an
        #           event is live.
        always_signals = {"year-round", "mixed"}
        seasonal_signals = {"event-gated", "mixed"}
        is_always = bool(all_modes & always_signals)
        is_seasonal = bool(all_modes & seasonal_signals)
        ev_list = sorted(all_events)
        if all_modes == {"year-round"}:
            print("    gating → ALWAYS active")
        elif is_always and is_seasonal:
            evs = ev_list or ["?"]
            print(
                f"    gating → MIXED — year-round baseline + extra credit when {evs} is live"
            )
        elif is_seasonal:
            evs = ev_list or ["?"]
            print(f"    gating → SEASONAL-ONLY (active only when one of {evs} is live)")
        elif is_always:
            print("    gating → ALWAYS active")
        else:
            print(
                f"    gating → UNRESOLVED ({sorted(all_modes)}) — re-dump may be needed"
            )


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        sys.exit(1)
    explorers = parse(argv[1])
    for exp in explorers:
        summarise(exp)
        print()
    print(f"--- parsed {len(explorers)} explorer(s) ---")


if __name__ == "__main__":
    main(sys.argv)
