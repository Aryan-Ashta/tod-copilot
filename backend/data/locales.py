"""Locales: the three recorded ones in docs/11-test-locales.md (fixtures/<id>/), plus custom areas recorded live
into cache/areas/<id>/."""
from functools import lru_cache
from pathlib import Path
from typing import Optional

import yaml

from backend.schemas import Locale
from backend.settings import CACHE_DIR, FIXTURES_DIR

LOCALE_IDS = ("houston_downtown", "la_wilshire_koreatown", "brevard_cocoa")


def locale_dir(locale_id: str) -> Path:
    return FIXTURES_DIR / locale_id if locale_id in LOCALE_IDS else CACHE_DIR / "areas" / locale_id


@lru_cache(maxsize=None)
def get_locale(locale_id: str) -> Locale:
    p = locale_dir(locale_id) / "locale.yaml"
    if not p.exists():
        raise KeyError(f"unknown area {locale_id}")
    raw = yaml.safe_load(p.read_text())
    fields = {k: v for k, v in raw.items() if k in Locale.model_fields}
    # the licensed extract is git-ignored, so a fresh clone has the tier but not the data (CoStarProvider.covers)
    fields["costar_loaded"] = (locale_dir(locale_id) / "costar" / "buildings.json").exists()
    return Locale(**fields)


def source_locale(locale_id: str) -> Optional[str]:
    """The recorded locale whose county sources (parcels, land-use map, utilities) this area reuses: itself when
    recorded; for a custom area inside Harris or LA County, the Houston or LA locale; otherwise None."""
    return locale_id if locale_id in LOCALE_IDS else get_locale(locale_id).sources_from


def load_locales() -> list[Locale]:
    return [get_locale(i) for i in LOCALE_IDS]
