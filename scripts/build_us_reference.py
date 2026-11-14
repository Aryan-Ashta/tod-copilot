"""Build the area picker's state lines from the US Census 2023 cartographic boundary file (1:20,000,000).

The source is public domain and cached under cache/census/, so a rebuild needs no network.
Writes frontend/public/geo/us-states.geojson.
Run: uv run python scripts/build_us_reference.py
"""
import io
from pathlib import Path

import geopandas as gpd
import httpx

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "cache" / "census"
OUT = ROOT / "frontend" / "public" / "geo"

STATES_URL = "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_state_20m.zip"
NOT_STATES = {"11", "72"}   # District of Columbia, Puerto Rico


def cached(url: str) -> bytes:
    path = CACHE / url.rsplit("/", 1)[1]
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        path.write_bytes(httpx.get(url, timeout=120, follow_redirects=True).raise_for_status().content)
    return path.read_bytes()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    states = gpd.read_file(io.BytesIO(cached(STATES_URL)))
    states = states[~states["STATEFP"].isin(NOT_STATES)][["STATEFP", "NAME", "geometry"]].to_crs(4326)
    states = states.rename(columns={"STATEFP": "fips", "NAME": "name"})
    if len(states) != 50:
        raise SystemExit(f"expected 50 states, got {len(states)}")
    states["geometry"] = states.geometry.set_precision(0.001)   # ~100 m: plenty at state scale, a small file
    (OUT / "us-states.geojson").write_text(states.to_json(drop_id=True))
    print(f"{len(states)} states -> {OUT / 'us-states.geojson'}")


if __name__ == "__main__":
    main()
