"""Locales: exactly the three in docs/11-test-locales.md, loaded from fixtures/<id>/locale.yaml."""
from functools import lru_cache

import yaml

from backend.schemas import Locale
from backend.settings import FIXTURES_DIR

LOCALE_IDS = ("houston_downtown", "la_wilshire_koreatown", "brevard_cocoa")


@lru_cache(maxsize=None)
def get_locale(locale_id: str) -> Locale:
    if locale_id not in LOCALE_IDS:
        raise KeyError(f"unknown locale {locale_id}")
    raw = yaml.safe_load((FIXTURES_DIR / locale_id / "locale.yaml").read_text())
    return Locale(**{k: v for k, v in raw.items() if k in Locale.model_fields})


def load_locales() -> list[Locale]:
    return [get_locale(i) for i in LOCALE_IDS]
