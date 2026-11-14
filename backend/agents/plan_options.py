"""Plan steering: options parsed from the prompt by rules (or set with the UI sliders), then applied to factors in code.

The LLM never sets these. Free text and stock prompts name presets ("half" or "double" the transit budget, a "high"
affordable share); `preset_options` turns them into numbers from factors.yaml, so both map to the same `PlanOptions`.
"""
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal, Optional

import yaml

from backend.data.factors import load_factors
from backend.schemas import PlanOptions, StockPrompt

STOCK_PROMPTS_PATH = Path(__file__).with_name("stock_prompts.yaml")

_I = re.IGNORECASE
_CONVERSIONS = re.compile(r"\b(convert|conversions?|adaptive reuse|reuse)\b|office.{0,30}\b(housing|homes|residential)\b",
                          _I)
_NEW_BUILD = re.compile(r"\b(new (build|construction|homes?)|build new|to build|parking lots?|surface lots?|vacant)\b", _I)
_BUDGET_HALF = re.compile(r"\b(tight|small|low|limited|cheap)\b.{0,20}\bbudget\b|\bbudget\b.{0,20}\b(tight|small|low|limited)\b",
                          _I)
_BUDGET_DOUBLE = re.compile(r"\b(expand|more|increase|double)\b.{0,30}\b(transit|bus|service)\b|\bbrt\b", _I)
_AFFORDABLE = re.compile(r"\baffordab", _I)


def preset_options(focus: str = "all", transit_budget: Optional[Literal["half", "double"]] = None,
                   affordable: Optional[Literal["high"]] = None) -> PlanOptions:
    f = load_factors()
    mult = f["transit_budget_option_multipliers"].value[transit_budget] if transit_budget else 1.0
    share = f["affordable_share_high"].value if affordable == "high" else None
    return PlanOptions(focus=focus, transit_budget_multiplier=mult, affordable_share=share)


def parse_prompt(text: str) -> PlanOptions:
    conv, new = bool(_CONVERSIONS.search(text)), bool(_NEW_BUILD.search(text))
    focus = "conversions" if conv and not new else "new_build" if new and not conv else "all"
    budget = "half" if _BUDGET_HALF.search(text) else "double" if _BUDGET_DOUBLE.search(text) else None
    return preset_options(focus, budget, "high" if _AFFORDABLE.search(text) else None)


def apply_options(f: dict[str, Any], o: PlanOptions) -> dict[str, Any]:
    out = dict(f)
    if o.transit_budget_multiplier != 1:
        out["transit_budget_usd"] = f["transit_budget_usd"] * o.transit_budget_multiplier
    if o.affordable_share is not None:
        out["affordable_share"] = o.affordable_share
    return out


@lru_cache(maxsize=1)
def stock_prompts() -> list[StockPrompt]:
    return [StockPrompt.model_validate({**x, "options": preset_options(**x["options"])})
            for x in yaml.safe_load(STOCK_PROMPTS_PATH.read_text())]
