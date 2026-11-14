"""Per-place configuration registry: backend/registry/{us_states,states/*,counties/*,places/*}.yaml.

Hand-written entries carry `status: reviewed`; onboarding agents write `agent_verified` (code checks passed) or
`not_found`. Every lookup reads REGISTRY_DIR at call time so tests can point it at a tmp dir (then call clear_cache).
"""
import copy
import re
from functools import lru_cache
from pathlib import Path
from typing import Optional

import yaml

from backend import settings

REGISTRY_DIR = settings.ROOT / "backend" / "registry"
STATUSES = ("reviewed", "agent_verified", "not_found")
HEADER = ("# Managed by backend/onboard (docs/12 §14). status: reviewed = checked by a person; agent_verified = code "
          "checks passed; not_found = no public source found.\n")


def _dir() -> Path:
    return REGISTRY_DIR


@lru_cache(maxsize=None)
def _load_cached(rel: str) -> Optional[dict]:
    p = _dir() / rel
    return (yaml.safe_load(p.read_text()) or {}) if p.exists() else None


def _load(rel: str) -> Optional[dict]:
    """A deep copy: callers may edit the result and save it."""
    return copy.deepcopy(_load_cached(rel))


def clear_cache() -> None:
    _load_cached.cache_clear()
    _jurisdiction_index.cache_clear()


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


def us_states() -> dict[str, dict]:
    """Read-only (cached, not copied)."""
    return _load_cached("us_states.yaml")


def state(fips2: str) -> dict:
    base = us_states()[fips2]
    out = {"fips": fips2, "usps": base["usps"], "name": base["name"], "jurisdiction": slug(base["name"]),
           "policies": {}}
    return {**out, **(_load(f"states/{fips2}.yaml") or {})}


def county(fips5: str) -> dict:
    return _load(f"counties/{fips5}.yaml") or {}


def county_view(fips5: str) -> dict:
    """The cached county file, not copied: for hot read-only paths (per-parcel land-use mapping). Never mutate."""
    return _load_cached(f"counties/{fips5}.yaml") or {}


def place(geoid7: str) -> dict:
    return _load(f"places/{geoid7}.yaml") or {}


def _save(rel: str, data: dict) -> None:
    p = _dir() / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(HEADER + yaml.safe_dump(data, sort_keys=False, allow_unicode=True, width=120))
    clear_cache()


def save_county(fips5: str, data: dict) -> None:
    _save(f"counties/{fips5}.yaml", data)


def save_place(geoid7: str, data: dict) -> None:
    _save(f"places/{geoid7}.yaml", data)


def save_state(fips2: str, data: dict) -> None:
    _save(f"states/{fips2}.yaml", data)


def county_fips_list() -> list[str]:
    d = _dir() / "counties"
    return sorted(p.stem for p in d.glob("*.yaml")) if d.exists() else []


def place_geoids() -> list[str]:
    d = _dir() / "places"
    return sorted(p.stem for p in d.glob("*.yaml")) if d.exists() else []


def place_jurisdiction(p: dict) -> str:
    """`p` is a registry place file or a TIGER place (STATE, BASENAME)."""
    if p.get("jurisdiction"):
        return p["jurisdiction"]
    fips2 = p.get("state") or p.get("STATE")
    return f"{us_states()[fips2]['usps'].lower()}_{slug(p.get('basename') or p.get('BASENAME'))}"


def county_jurisdiction(c: dict) -> str:
    """`c` is a registry county file or a TIGER county (STATE, NAME)."""
    if c.get("jurisdiction"):
        return c["jurisdiction"]
    fips2 = c.get("state") or c.get("STATE")
    name = c.get("name") or c.get("NAME")
    for suffix in (" County", " Parish", " Borough"):
        name = name.removesuffix(suffix)
    return f"{us_states()[fips2]['usps'].lower()}_{slug(name)}_county"


@lru_cache(maxsize=1)
def _jurisdiction_index() -> dict[str, str]:
    """jurisdiction -> state FIPS for every registry place and county file."""
    out = {}
    for g in place_geoids():
        p = place(g)
        if p.get("state"):
            out[place_jurisdiction(p)] = p["state"]
    for f in county_fips_list():
        c = county(f)
        if c.get("state") and c.get("name"):
            out[county_jurisdiction(c)] = c["state"]
    return out


def state_jurisdiction(jurisdiction: str) -> Optional[str]:
    """The state-law jurisdiction id above a city or county jurisdiction; None for a state itself or an unknown id."""
    fips2 = _jurisdiction_index().get(jurisdiction)
    if fips2 is None:
        return None
    s = state(fips2)["jurisdiction"]
    return None if s == jurisdiction else s


def section_status(section: Optional[dict]) -> Optional[str]:
    return (section or {}).get("status")
