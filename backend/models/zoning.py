"""Zoning (docs/05, docs/10). Pure: structured rules + target attributes -> LegalPath per path.

A rule is "not covered" when its value is TODO or it references an attribute that is None. Not covered never
defaults to anything: an uncovered eligibility leaves eligible=None.
"""
import math
from typing import Any, Optional

from backend.schemas import Citation, LegalPath

ALLOW_KINDS = ("max_height_ft", "max_units_per_acre", "max_far", "parking_min_per_unit", "allows_uses",
               "approval_steps", "discretionary", "note")
SQFT_PER_ACRE = 43_560


def _check(op: str, actual: Any, expected: Any) -> bool:
    if op == "in":
        return actual in expected
    if op == "eq":
        return actual == expected
    if op == "lte":
        return actual <= expected
    if op == "gte":
        return actual >= expected
    raise ValueError(f"unknown operator {op}")


def evaluate(rule: dict, attrs: dict) -> str:
    """'match' | 'nomatch' | 'uncovered'."""
    for attr, conds in (rule.get("applies_if") or {}).items():
        if attrs.get(attr) is None:
            return "uncovered"
        for op, expected in conds.items():
            if not _check(op, attrs[attr], expected):
                return "nomatch"
    if rule.get("value") == "TODO":
        return "uncovered"
    return "match"


def stop_tier(attrs: dict, rules: list[dict]) -> Optional[int]:
    for r in rules:
        if r["rule"] == "stop_tier" and evaluate(r, attrs) == "match":
            return r["value"]
    return None


def citation(rule: dict, urls: dict[str, str]) -> Citation:
    c = rule["cite"]
    return Citation(doc_id=c["doc_id"], section=str(c["section"]), quote=c["quote"], url=urls.get(c["doc_id"]))


def apply_rules(target_attrs: dict, rules: list[dict], path_names: list[str],
                doc_urls: Optional[dict[str, str]] = None) -> list[LegalPath]:
    urls = doc_urls or {}
    attrs = dict(target_attrs)
    if attrs.get("stop_tier") is None:
        attrs["stop_tier"] = stop_tier(attrs, rules)
    paths = []
    for name in path_names:
        eligible: Optional[bool] = None
        allows: dict = {}
        cites: list[Citation] = []
        why: list[Citation] = []        # eligibility rules that decided (False) or a corpus gap (TODO) for None
        missing: list[str] = []         # inputs an eligibility rule needed but this target lacks
        seen_kinds: set[str] = set()
        todo_kinds: list[str] = []
        for r in rules:
            if r["path"] != name or r["rule"] == "stop_tier":
                continue
            kind = r["rule"]
            if kind in seen_kinds:
                continue
            res = evaluate(r, attrs)
            if res == "uncovered" and r.get("value") == "TODO" and evaluate({**r, "value": None}, attrs) == "match":
                todo_kinds.append(kind)  # the rule applies here but its value is not in the corpus
                if kind == "eligible":
                    why.append(citation(r, urls))
            elif res == "uncovered" and kind == "eligible":
                missing += [a for a in (r.get("applies_if") or {}) if attrs.get(a) is None]
            if res != "match":
                continue
            seen_kinds.add(kind)
            if kind == "eligible":
                eligible = bool(r["value"])
                if not eligible:
                    why = [citation(r, urls)]
            elif kind in ALLOW_KINDS:
                allows[kind] = r["value"]
            cites.append(citation(r, urls))
        nc = [k for k in dict.fromkeys(todo_kinds) if k not in seen_kinds and k != "eligible"]
        if nc:
            allows["not_covered"] = nc
        if eligible is not True:  # what a path allows only matters where it applies
            allows = {k: v for k, v in allows.items() if k == "note"}
            if eligible is None and missing:
                allows["missing_inputs"] = list(dict.fromkeys(missing))
            # only the citations that explain the verdict: the rule that ruled it out, or the uncovered rule
            paths.append(LegalPath(name=name, eligible=eligible, allows=allows, citations=why))
            continue
        if attrs.get("stop_tier") is not None:
            for r in rules:
                if r["path"] == name and r["rule"] == "stop_tier" and evaluate(r, attrs) == "match":
                    cites.append(citation(r, urls))
                    break
        paths.append(LegalPath(name=name, eligible=eligible, allows=allows, citations=cites))
    return paths


def homes_for(area_acres: Optional[float], path: LegalPath, f: dict) -> Optional[int]:
    """min(units allowed by density, floor area / avg unit size). None unless the path is eligible, and None when
    the path has a density/height/FAR limit here whose value the corpus does not cover (never assume one)."""
    if path.eligible is not True or not area_acres:
        return None
    a = path.allows
    if any(k in a.get("not_covered", []) for k in ("max_units_per_acre", "max_height_ft", "max_far")):
        return None
    cap = a["max_units_per_acre"] * area_acres if a.get("max_units_per_acre") is not None else math.inf
    area_sqft = area_acres * SQFT_PER_ACRE
    if a.get("max_far") is not None:
        floor_area = a["max_far"] * area_sqft
    else:
        stories = (math.floor(a["max_height_ft"] / f["story_height_ft"]) if a.get("max_height_ft") is not None
                   else f["newbuild_assumed_stories"])
        floor_area = area_sqft * f["site_lot_coverage_ratio"] * stories
    return int(math.floor(min(cap, floor_area / f["avg_unit_sqft_residential"])))


def recommend(paths: list[LegalPath], homes_by_path: dict[str, Optional[int]]) -> Optional[str]:
    """Highest homes among eligible paths; ties -> fewer approval steps (unknown steps rank last)."""
    eligible = [p for p in paths if p.eligible is True]
    if not eligible:
        return None
    best = max(eligible, key=lambda p: (homes_by_path.get(p.name) or 0,
                                        -(p.allows.get("approval_steps") if isinstance(p.allows.get("approval_steps"), int)
                                          else math.inf)))
    return best.name
