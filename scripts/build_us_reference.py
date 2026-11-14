"""Build the area picker's US reference layers: state outlines and each state's most populous city.

Sources (US Census Bureau, public domain), cached under cache/census/ so a rebuild needs no network:
- State outlines: 2023 cartographic boundary file, 1:20,000,000 (cb_2023_us_state_20m).
- City populations: Vintage 2023 incorporated place estimates (sub-est2023.csv, SUMLEV 162), July 1, 2023.
- City points: 2023 Gazetteer place file internal points (INTPTLAT, INTPTLONG).

Writes frontend/public/geo/us-states.geojson and frontend/public/geo/us-largest-cities.json.
Run: uv run python scripts/build_us_reference.py
"""
import io
import json
import re
import zipfile
from pathlib import Path

import geopandas as gpd
import httpx
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "cache" / "census"
OUT = ROOT / "frontend" / "public" / "geo"

STATES_URL = "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_state_20m.zip"
POP_URL = "https://www2.census.gov/programs-surveys/popest/datasets/2020-2023/cities/totals/sub-est2023.csv"
GAZ_URL = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_place_national.zip"

NOT_STATES = {"11", "72"}   # District of Columbia, Puerto Rico
# Census place names carry their legal type ("Houston city", "Nashville-Davidson metropolitan government (balance)").
_SUFFIX = re.compile(r"\s+(\(balance\)|city|town|village|municipality|borough|CDP|"
                     r"(unified |consolidated |metropolitan |metro )?(city-county |city and county |government))+.*$")
# Places whose Census names are not the city's common name.
_COMMON = {"Nashville-Davidson": "Nashville", "Louisville/Jefferson County": "Louisville", "Urban Honolulu": "Honolulu",
           "Boise City": "Boise"}


def cached(url: str) -> bytes:
    path = CACHE / url.rsplit("/", 1)[1]
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        path.write_bytes(httpx.get(url, timeout=120, follow_redirects=True).raise_for_status().content)
    return path.read_bytes()


def city_name(census_name: str) -> str:
    name = _SUFFIX.sub("", census_name).strip()
    return _COMMON.get(name, name)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    states = gpd.read_file(io.BytesIO(cached(STATES_URL)))
    states = states[~states["STATEFP"].isin(NOT_STATES)][["STATEFP", "NAME", "geometry"]].to_crs(4326)
    states = states.rename(columns={"STATEFP": "fips", "NAME": "name"})
    states["geometry"] = states.geometry.set_precision(0.001)   # ~100 m: plenty at state scale, a small file
    (OUT / "us-states.geojson").write_text(states.to_json(drop_id=True))

    pop = pd.read_csv(io.BytesIO(cached(POP_URL)), dtype=str, encoding="latin-1")
    pop = pop[(pop["SUMLEV"] == "162") & ~pop["STATE"].isin(NOT_STATES)]
    pop["population"] = pop["POPESTIMATE2023"].astype(int)
    top = pop.sort_values("population", ascending=False).groupby("STATE").head(1)

    with zipfile.ZipFile(io.BytesIO(cached(GAZ_URL))) as z:
        gaz = pd.read_csv(z.open(z.namelist()[0]), sep="\t", dtype=str)
    gaz.columns = [c.strip() for c in gaz.columns]
    gaz = gaz.set_index("GEOID")

    cities = []
    for _, r in top.iterrows():
        g = gaz.loc[r["STATE"] + r["PLACE"]]
        cities.append({"name": city_name(r["NAME"]), "state": r["STNAME"], "population": int(r["population"]),
                       "lonlat": [round(float(g["INTPTLONG"]), 4), round(float(g["INTPTLAT"]), 4)]})
    cities.sort(key=lambda c: -c["population"])
    if len(cities) != 50 or len(states) != 50:
        raise SystemExit(f"expected 50 states, got {len(states)} outlines and {len(cities)} cities")
    (OUT / "us-largest-cities.json").write_text(json.dumps({
        "source": "US Census Bureau, Vintage 2023 incorporated place population estimates (July 1, 2023); "
                  "2023 Gazetteer place internal points",
        "source_url": POP_URL,
        "cities": cities,
    }, indent=1))
    print(f"{len(states)} states, {len(cities)} cities -> {OUT}")


if __name__ == "__main__":
    main()
