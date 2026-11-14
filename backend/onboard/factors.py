"""Scoped local factors: backend/registry/factors/<scope>.yaml (scope = national | state-<fips2> | county-<fips5>)
and a drawn area's own <area dir>/factors.yaml. Each entry: {value, unit, source_url, verified: false, note,
retrieved_at, scope}. `backend.data.factors.resolve` reads them for LOCAL_KEYS: area -> recorded locale -> county ->
state -> national. The local factor researcher (ensure_factors) fills state and county files."""
import logging
import statistics
from functools import lru_cache

import yaml

from backend.onboard import registry

log = logging.getLogger(__name__)
HEADER = ("# Managed by backend/onboard (docs/12 §14). Agent-researched or derived local factors; every value is "
          "verified: false until a person checks it.\n")


def _path(scope: str):
    return registry.REGISTRY_DIR / "factors" / f"{scope}.yaml"


@lru_cache(maxsize=None)
def _load_scoped(path: str) -> dict:
    from pathlib import Path
    p = Path(path)
    return (yaml.safe_load(p.read_text()) or {}) if p.exists() else {}


def load_scoped(scope: str) -> dict:
    return _load_scoped(str(_path(scope)))


def scoped_exists(scope: str) -> bool:
    return _path(scope).exists()


def save_scoped(scope: str, data: dict) -> None:
    p = _path(scope)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(HEADER + yaml.safe_dump(data, sort_keys=False, allow_unicode=True, width=120))
    _load_scoped.cache_clear()


def clear_cache() -> None:
    _load_scoped.cache_clear()


def area_factors(locale_id: str) -> dict:
    from backend.data.locales import locale_dir
    p = locale_dir(locale_id) / "factors.yaml"
    return (yaml.safe_load(p.read_text()) or {}) if p.exists() else {}


def seed_national() -> dict:
    """national.yaml: for every LOCAL_KEY, the median of the three recorded locales' values (a placeholder, not a
    national statistic; the note says so)."""
    from backend.data.factors import LOCAL_KEYS, load_factors
    facs = load_factors()
    out = {}
    for key in LOCAL_KEYS:
        f = facs[key]
        h, la, b = (f.value[k] for k in ("houston_downtown", "la_wilshire_koreatown", "brevard_cocoa"))
        med = statistics.median([h, la, b])   # three values: the middle one, same type
        out[key] = {"value": med, "unit": f.unit, "source_url": f.source_url, "verified": False, "scope": "national",
                    "note": (f"national fallback: median of the three recorded locales (houston_downtown {h}, "
                             f"la_wilshire_koreatown {la}, brevard_cocoa {b}); not a national statistic; replace with "
                             "a national source")}
    save_scoped("national", out)
    return out


# ---------------------------------------------------------------- agent 6: local factor researcher
def _research(scope: str, scope_name: str, aliases: list[str], level: str, fips5: str, model, search) -> dict:
    """Research `level` keys for one scope; write the accepted values (possibly none) to factors/<scope>.yaml."""
    import json
    from datetime import date
    from backend.data.factors import load_factors
    from backend.onboard.common import PROMPTS_DIR, thresholds, work_dir
    from backend.research.agent import run_factor_research
    from backend.research.registry import local_factor_specs
    from backend.research.verify import Accepted
    specs = local_factor_specs(level)
    wd = work_dir(f"factors-{scope}")
    year = date.today().year
    suggested = [f"{scope_name} {' '.join(s['keywords'][:3])} {year}" for s in specs.values()]
    verdicts = run_factor_research(scope_name, aliases, specs, fips5, wd, f=thresholds(),
                                   prompt=PROMPTS_DIR / "local_factor_researcher.md", suggested=suggested,
                                   thread_id=f"onboard-factors-{scope}", model=model, search=search)
    facs = load_factors()
    out = {}
    for v in verdicts:
        if isinstance(v, Accepted) and v.field not in out:
            out[v.field] = {"value": v.value, "unit": facs[v.field].unit, "source_url": v.source_url, "verified": False,
                            "note": f"agent-found for {scope_name}: {v.note}", "retrieved_at": v.retrieved_at,
                            "scope": scope}
    with (wd / "rejects.jsonl").open("w") as fh:
        for v in verdicts:
            if not isinstance(v, Accepted):
                fh.write(json.dumps(v.as_dict()) + "\n")
    save_scoped(scope, out)
    return out


def ensure_factors(fips5: str, *, model=None, search=None) -> dict[str, dict]:
    """State-level keys once per state, county-level keys once per county (files written even when empty, so a
    scope is never re-researched). Returns {scope: written entries} for the scopes researched now."""
    from backend.onboard import geo
    st = registry.state(fips5[:2])
    done = {}
    if not scoped_exists(f"state-{fips5[:2]}"):
        done[f"state-{fips5[:2]}"] = _research(f"state-{fips5[:2]}", st["name"], [st["name"], st["usps"]], "state",
                                               fips5, model, search)
    if not scoped_exists(f"county-{fips5}"):
        name = geo.county_info(fips5)["name"]
        short = name.removesuffix(" County").removesuffix(" Parish").removesuffix(" Borough")
        done[f"county-{fips5}"] = _research(f"county-{fips5}", f"{name}, {st['name']}", [name, short, st["name"]],
                                            "county", fips5, model, search)
    return done


def forget_scopes(fips5: str) -> None:
    """force: drop the state and county factor files, the cached answers and the checkpoints, so both are
    researched again."""
    from backend.onboard.common import work_dir
    from backend.research import harness
    for scope in (f"state-{fips5[:2]}", f"county-{fips5}"):
        _path(scope).unlink(missing_ok=True)
        wd = work_dir(f"factors-{scope}")
        (wd / "results" / f"onboard-factors-{scope}.json").unlink(missing_ok=True)
        harness.checkpointer(wd / "checkpoints.sqlite").delete_thread(f"onboard-factors-{scope}")
    _load_scoped.cache_clear()
