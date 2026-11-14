"""Factor registry: every numeric constant with its source (`factors.yaml`)."""
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from backend.schemas import Factor

FACTORS_PATH = Path(__file__).with_name("factors.yaml")
LOCALE_IDS = ("houston_downtown", "la_wilshire_koreatown", "brevard_cocoa")


class FactorMissing(KeyError):
    pass


@lru_cache(maxsize=1)
def load_factors() -> dict[str, Factor]:
    raw = yaml.safe_load(FACTORS_PATH.read_text())
    return {k: Factor(key=k, **v) for k, v in raw.items()}


def _is_per_locale(value: Any) -> bool:
    return isinstance(value, dict) and set(value) == set(LOCALE_IDS)


def _has_null(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, dict):
        return any(_has_null(v) for v in value.values())
    if isinstance(value, list):
        return any(_has_null(v) for v in value)
    return False


def resolve(locale_id: str) -> dict[str, Any]:
    """Flatten per-locale mappings to this locale's value (a drawn metro area uses its source locale's); raise
    FactorMissing on any null."""
    from backend.data.locales import source_locale
    pick = source_locale(locale_id)
    out: dict[str, Any] = {}
    for key, fac in load_factors().items():
        v = fac.value[pick] if _is_per_locale(fac.value) else fac.value
        if _has_null(v):
            raise FactorMissing(key)
        out[key] = v
    return out
