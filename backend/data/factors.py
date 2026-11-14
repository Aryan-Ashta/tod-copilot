"""Factor registry: every numeric constant with its source (`factors.yaml`).

Per-locale factors (LOCAL_KEYS: values keyed by the three recorded locales) resolve for other areas through the
scoped files of backend/onboard/factors.py: area -> recorded locale -> county -> state -> national."""
import logging
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


LOCAL_KEYS = tuple(k for k, v in yaml.safe_load(FACTORS_PATH.read_text()).items() if _is_per_locale(v["value"]))
_ignored_logged: set[tuple[str, str]] = set()


def _scoped(scope: str) -> dict:
    from backend.onboard.factors import load_scoped
    data = load_scoped(scope)
    for k in data:
        if k not in LOCAL_KEYS and (scope, k) not in _ignored_logged:
            _ignored_logged.add((scope, k))
            logging.getLogger(__name__).warning("factor %s in %s is not a per-locale factor; ignored", k, scope)
    return data


def _local_value(key: str, fac: Factor, locale_id: str, area: dict, src, fips: str):
    if key in area:
        return area[key]["value"]
    if src is not None:
        return fac.value[src]
    for scope in (f"county-{fips}", f"state-{fips[:2]}", "national"):
        if key in (d := _scoped(scope)):
            return d[key]["value"]
    raise FactorMissing(f"{key}: no value for {locale_id} (area, county-{fips}, state-{fips[:2]}, national)")


def resolve(locale_id: str) -> dict[str, Any]:
    """Flatten per-locale mappings to this area's value (see module doc); raise FactorMissing on any null."""
    from backend.data.locales import get_locale, source_locale
    from backend.onboard.factors import area_factors
    src = source_locale(locale_id)
    recorded = locale_id in LOCALE_IDS
    area = {} if recorded else area_factors(locale_id)
    fips = get_locale(locale_id).county_fips
    out: dict[str, Any] = {}
    for key, fac in load_factors().items():
        v = _local_value(key, fac, locale_id, area, src, fips) if key in LOCAL_KEYS else fac.value
        if _has_null(v):
            raise FactorMissing(key)
        out[key] = v
    return out
