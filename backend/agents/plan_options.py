"""Plan steering: the focus option parsed from the prompt by rules. Numeric goals come from form fields only.

The LLM never sets these; free text and stock prompts map to the same `PlanOptions` deterministically.
"""
import re
from functools import lru_cache
from pathlib import Path

import yaml

from backend.schemas import PlanOptions, StockPrompt

STOCK_PROMPTS_PATH = Path(__file__).with_name("stock_prompts.yaml")

_I = re.IGNORECASE
_CONVERSIONS = re.compile(r"\b(convert|conversions?|adaptive reuse|reuse)\b|office.{0,30}\b(housing|homes|residential)\b",
                          _I)
_NEW_BUILD = re.compile(r"\b(new (build|construction|homes?)|build new|to build|parking lots?|surface lots?|vacant)\b", _I)


def parse_prompt(text: str) -> PlanOptions:
    conv, new = bool(_CONVERSIONS.search(text)), bool(_NEW_BUILD.search(text))
    focus = "conversions" if conv and not new else "new_build" if new and not conv else "all"
    return PlanOptions(focus=focus)


@lru_cache(maxsize=1)
def stock_prompts() -> list[StockPrompt]:
    return [StockPrompt.model_validate(x) for x in yaml.safe_load(STOCK_PROMPTS_PATH.read_text())]
