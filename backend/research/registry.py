"""Field and source registries for agent research (docs/12 §6). Nothing here names a locale: state and county come
from `Locale.county_fips`."""
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

import yaml

HERE = Path(__file__).resolve().parent
FIELDS_PATH = HERE / "fields.yaml"
SOURCES_PATH = HERE / "sources.yaml"
SKILLS_DIR = HERE / "skills"
PROMPTS_DIR = HERE / "prompts"


@lru_cache(maxsize=1)
def _fields_raw() -> dict:
    return yaml.safe_load(FIELDS_PATH.read_text())


def field_specs() -> dict[str, dict]:
    """Researchable schema fields, each with `confidence_by_source_type` filled from the defaults."""
    raw = _fields_raw()
    default = raw["defaults"]["confidence_by_source_type"]
    return {k: {"confidence_by_source_type": default, **v} for k, v in raw["fields"].items()}


def identity_specs() -> dict[str, dict]:
    default = _fields_raw()["defaults"]["confidence_by_source_type"]
    return {k: {"confidence_by_source_type": default, **v} for k, v in _fields_raw()["identity_fields"].items()}


def market_specs() -> dict[str, dict]:
    return dict(_fields_raw()["market_factors"])


def local_factor_specs(level: str) -> dict[str, dict]:
    """Local factor researcher keys at one level (state | county)."""
    return {k: v for k, v in _fields_raw()["local_factors"].items() if v["level"] == level}


def spec_for(field: str) -> Optional[dict]:
    return field_specs().get(field) or identity_specs().get(field)


@lru_cache(maxsize=1)
def _sources_raw() -> dict:
    return yaml.safe_load(SOURCES_PATH.read_text())


def _merge(dst: dict, src: dict) -> dict:
    out = dict(dst)
    for k, v in (src or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        elif isinstance(v, list) and isinstance(out.get(k), list):
            out[k] = out[k] + [x for x in v if x not in out[k]]
        else:
            out[k] = v
    return out


def sources_for(county_fips: str) -> dict[str, Any]:
    """global (sources.yaml) -> state policies -> county research section (backend/registry), merged."""
    from backend.onboard import registry as onboard
    merged = _merge({}, _sources_raw()["global"])
    if county_fips[:2] in onboard.us_states():
        merged = _merge(merged, {"policies": onboard.state(county_fips[:2]).get("policies") or {}})
    research = dict(onboard.county(county_fips).get("research") or {})
    card = research.pop("assessor_card", None) or {}
    if card.get("status") not in (None, "not_found") and card.get("example_url"):
        research["preferred_domains"] = list(research.get("preferred_domains") or []) + [domain(card["example_url"])]
    return _merge(merged, research)


def blocked_fields(county_fips: str) -> set[str]:
    """Fields a state or county policy removes from the queue and the verifier (e.g. Texas non-disclosure)."""
    on = {k for k, v in (sources_for(county_fips).get("policies") or {}).items() if v}
    return {f for f, s in field_specs().items() if on & set(s.get("blocked_by_policies") or [])}


def domain(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def denied(url: str, county_fips: str) -> bool:
    host = domain(url)
    return any(host == d or host.endswith("." + d) for d in sources_for(county_fips)["denylist_domains"])
