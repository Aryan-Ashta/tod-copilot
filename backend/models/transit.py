"""Transit network design (docs/05). Pure: demand + existing GTFS + walk graph -> TransitPlan pieces."""
import math
import re
import statistics
from typing import Optional

import h3
import networkx as nx
import numpy as np
from scipy.spatial import cKDTree
from shapely.geometry import LineString, MultiPoint, mapping

from backend.data.geo import lonlat_dist_m, lonlat_to_utm
from backend.models.geo_graph import NodeIndex
from backend.schemas import MeasurementSuggestion, Provenance, Route, SimulatedCount, Stop

H3_RES = 8  # ~0.46 km edge, close to the docs' ~400 m hex


# ---------------------------------------------------------------- demand
def demand_grid(points: list[dict], f: dict, epsg: int) -> list[dict]:
    w = f["transit_demand_weights"]
    cells: dict[str, dict] = {}
    for p in points:
        lon, lat = p["lonlat"]
        c = h3.latlng_to_cell(lat, lon, H3_RES)
        d = cells.setdefault(c, {"h3": c, "homes": 0, "jobs": 0, "zero_car": 0})
        d["homes"] += p.get("homes", 0)
        d["jobs"] += p.get("jobs", 0)
        d["zero_car"] += p.get("zero_car", 0)
    out = []
    for c, d in cells.items():
        lat, lon = h3.cell_to_latlng(c)
        d["lonlat"] = (round(lon, 6), round(lat, 6))
        d["xy"] = lonlat_to_utm(lon, lat, epsg)
        d["demand"] = d["homes"] * w["homes"] + d["jobs"] * w["jobs"] + d["zero_car"] * w["zero_car"]
        out.append(d)
    return sorted(out, key=lambda d: -d["demand"])


def _covered(cells: list[dict], stop_xy: list[tuple[float, float]], radius: float) -> set[str]:
    if not stop_xy or not cells:
        return set()
    tree = cKDTree(np.asarray(stop_xy))
    out = set()
    for c in cells:
        if tree.query_ball_point(c["xy"], radius):
            out.add(c["h3"])
    return out


# ---------------------------------------------------------------- costs
def upgrade_cost(cycle_h: float, old_hw: float, new_hw: float, f: dict) -> float:
    extra_vehicles = cycle_h * 60 / new_hw - cycle_h * 60 / old_hw
    return extra_vehicles * f["service_span_hours_per_day"] * f["service_days_per_year"] * \
        f["bus_operating_cost_usd_per_revenue_hour"]


def new_route_cost(length_km: float, headway: float, f: dict) -> tuple[int, float]:
    vehicles = math.ceil(2 * length_km / f["bus_avg_speed_kmh"] * 60 / headway)
    cost = vehicles * f["service_span_hours_per_day"] * f["service_days_per_year"] * \
        f["bus_operating_cost_usd_per_revenue_hour"]
    return vehicles, cost


# ---------------------------------------------------------------- candidates
def _stops_along(line_xy: LineString, spacing: float) -> list[tuple[float, float]]:
    n = max(1, int(line_xy.length // spacing))
    return [tuple(line_xy.interpolate(i * line_xy.length / n).coords[0]) for i in range(n + 1)]


def candidates(existing: dict, grid: list[dict], G: nx.Graph, stations: list[dict], f: dict, epsg: int,
               to_lonlat) -> list[dict]:
    out = []
    stops = existing["stops"]
    stop_xy = {s["properties"]["stop_id"]: lonlat_to_utm(*s["geometry"]["coordinates"], epsg) for s in stops}
    # upgrades
    for r in existing["routes"]:
        p = r["properties"]
        hw, cyc = p.get("peak_headway_min"), p.get("cycle_time_h")
        if p["mode"] != "bus" or hw is None or cyc is None or hw <= f["frequent_bus_headway_min"]:
            continue
        rs = [stop_xy[s["properties"]["stop_id"]] for s in stops if p["route_id"] in s["properties"]["route_ids"]]
        out.append({"id": f"upg-{p['route_id']}", "kind": "frequent_bus", "type": "upgrade", "phase": 1,
                    "geometry": r["geometry"], "headway_min": f["frequent_bus_headway_min"], "old_headway_min": hw,
                    "cycle_time_h": cyc, "cost": upgrade_cost(cyc, hw, f["frequent_bus_headway_min"], f),
                    "stops_xy": rs, "name": p.get("short_name"), "length_km": None})
    # feeders: each station to each of the top 6 demand cells > 400 m from any existing stop
    all_stop_xy = list(stop_xy.values())
    far = [c for c in grid if not _covered([c], all_stop_xy, f["stop_catchment_m"])][:6]
    if G is not None and far and stations:
        idx = NodeIndex(G)
        for si, st in enumerate(stations):
            src, _ = idx.nearest([lonlat_to_utm(*st["lonlat"], epsg)])
            dists, paths = nx.single_source_dijkstra(G, src[0], weight="length")
            for c in far:
                dst, _ = idx.nearest([c["xy"]])
                if dst[0] not in paths or dists[dst[0]] < f["stop_spacing_m"]:
                    continue
                pts = [(G.nodes[n]["x"], G.nodes[n]["y"]) for n in paths[dst[0]]]
                line = LineString(pts)
                vehicles, cost = new_route_cost(line.length / 1000, f["frequent_bus_headway_min"], f)
                ll = LineString([to_lonlat(x, y) for x, y in line.simplify(10).coords])
                out.append({"id": f"fdr-{si}-{c['h3'][-6:]}", "kind": "frequent_bus", "type": "feeder", "phase": 2,
                            "geometry": mapping(ll), "headway_min": f["frequent_bus_headway_min"], "cost": cost,
                            "vehicles": vehicles, "stops_xy": _stops_along(line, f["stop_spacing_m"]),
                            "length_km": line.length / 1000, "name": f"Feeder {st['name']}"})
    return out


# ---------------------------------------------------------------- selection
def optimize_network(existing: dict, grid: list[dict], cands: list[dict], coverage_goal_pct: float, f: dict, epsg: int,
                     locale_id: str, to_lonlat) -> dict:
    """Add service greedily by uncovered demand per dollar until the share of demand within a frequent stop (rail or
    a bus at frequent_bus_headway_min or better) reaches the goal; the cost is the operating funding it needs."""
    frequent = f["frequent_bus_headway_min"]
    freq = {r["properties"]["route_id"] for r in existing["routes"]
            if r["properties"]["mode"] == "rail" or (r["properties"].get("peak_headway_min") is not None
                                                     and r["properties"]["peak_headway_min"] <= frequent)}
    base_xy = [lonlat_to_utm(*s["geometry"]["coordinates"], epsg) for s in existing["stops"]
               if s["properties"].get("rail") or set(s["properties"].get("route_ids") or []) & freq]
    covered = _covered(grid, base_xy, f["stop_catchment_m"])
    demand = {c["h3"]: c["demand"] for c in grid}
    total_demand = sum(demand.values())

    def pct(cov: set) -> float:
        return 100 * sum(demand[h] for h in cov) / total_demand if total_demand else 0.0

    baseline = pct(covered)
    for c in cands:
        c["cover"] = _covered(grid, c["stops_xy"], f["stop_catchment_m"])
    selected, spent, notes = [], 0.0, []

    def take(c):
        nonlocal spent
        selected.append(c)
        spent += c["cost"]
        covered.update(c["cover"])

    upgrades = [c for c in cands if c["type"] == "upgrade"]
    if locale_id == "brevard_cocoa" and upgrades:
        # Guardrail: at least one existing route gets more frequent; the best by demand per dollar.
        best = max(upgrades, key=lambda c: sum(demand[h] for h in c["cover"]) / max(c["cost"], 1))
        take(best)
        notes.append(f"route {best.get('name') or best['id']} runs every {frequent} min instead of "
                     f"{best['old_headway_min']:.0f} so at least one existing route gets more frequent")
        cands = [c for c in cands if c["id"] != best["id"]]
    pool = list(cands)
    while pool and pct(covered) < coverage_goal_pct:
        scored = [(sum(demand[h] for h in c["cover"] - covered) / max(c["cost"], 1), c) for c in pool]
        scored = [s for s in scored if s[0] > 0]
        if not scored:
            break
        _, c = max(scored, key=lambda s: s[0])
        take(c)
        pool = [p for p in pool if p["id"] != c["id"]]
    coverage = pct(covered)
    if coverage < coverage_goal_pct:
        notes.append(f"frequent stops reach {coverage:.1f}% of demand, short of the {coverage_goal_pct:g}% goal: "
                     f"no remaining candidate route adds coverage")
    # BRT variants for strong corridors
    for c in list(selected):
        length_km = c.get("length_km") or (LineString([lonlat_to_utm(*xy, epsg) for xy in _coords(c["geometry"])]).length / 1000)
        dem = sum(demand[h] for h in c["cover"])
        if length_km and dem / length_km >= f["brt_min_demand_per_km"]:
            if c["type"] == "upgrade":
                cost = upgrade_cost(c["cycle_time_h"], c["headway_min"], f["brt_headway_min"], f)
            else:
                cost = new_route_cost(length_km, f["brt_headway_min"], f)[1] - c["cost"]
            selected.append({**c, "id": f"brt-{c['id']}", "kind": "brt", "type": "brt", "phase": 3,
                             "headway_min": f["brt_headway_min"], "cost": cost, "cover": set()})
            spent += cost
    # on-demand zone where no fixed route reaches above-median demand
    all_xy = [lonlat_to_utm(*s["geometry"]["coordinates"], epsg) for s in existing["stops"]] + \
        [xy for c in selected for xy in c["stops_xy"]]
    reach = _covered(grid, all_xy, f["stop_catchment_m"])
    med = statistics.median([c["demand"] for c in grid]) if grid else 0
    gap = [c for c in grid if c["h3"] not in reach and c["demand"] > med]
    if len(gap) >= 3:
        hull = MultiPoint([c["lonlat"] for c in gap]).convex_hull
        selected.append({"id": "odz-1", "kind": "on_demand_zone", "type": "on_demand", "phase": 1,
                         "geometry": mapping(hull), "headway_min": None, "cost": f["on_demand_cost_usd_per_zone_year"],
                         "stops_xy": [], "cover": {c["h3"] for c in gap}})
        spent += f["on_demand_cost_usd_per_zone_year"]
    routes = []
    sel_ids = {c["id"].removeprefix("upg-") for c in selected if c["type"] == "upgrade"}
    for r in existing["routes"]:
        p = r["properties"]
        if p["mode"] == "rail":
            routes.append(Route(id=f"rail-{p['route_id']}", kind="rail_existing", geometry=r["geometry"],
                                headway_min=_int(p.get("peak_headway_min")), phase=0, annual_operating_cost_usd=0.0))
        elif p["route_id"] not in sel_ids:
            routes.append(Route(id=f"bus-{p['route_id']}", kind="bus_existing", geometry=r["geometry"],
                                headway_min=_int(p.get("peak_headway_min")), phase=0, annual_operating_cost_usd=0.0))
    for c in selected:
        routes.append(Route(id=c["id"], kind=c["kind"], geometry=c["geometry"], headway_min=_int(c["headway_min"]),
                            phase=c["phase"], annual_operating_cost_usd=round(c["cost"], 2)))
    return {"routes": routes, "selected": selected, "spent": spent, "notes": notes,
            "coverage_baseline_pct": round(baseline, 1), "coverage_pct": round(coverage, 1)}


def _int(v) -> Optional[int]:
    return None if v is None else int(round(v))


def _coords(geom: dict) -> list:
    if geom["type"] == "LineString":
        return geom["coordinates"]
    if geom["type"] == "MultiLineString":
        return [c for part in geom["coordinates"] for c in part]
    return []


# ---------------------------------------------------------------- ridership + measurements
def estimate_ridership(stops: list[dict], grid: list[dict], f: dict, prov: Provenance) -> list[Stop]:
    """stops: [{id, lonlat, xy, route_ids}]; a cell's demand is split evenly among stops covering it."""
    if not stops:
        return []
    tree = cKDTree(np.asarray([s["xy"] for s in stops]))
    share = [0.0] * len(stops)
    for c in grid:
        hits = tree.query_ball_point(c["xy"], f["stop_catchment_m"])
        for i in hits:
            share[i] += c["demand"] / len(hits)
    out = []
    for s, d in zip(stops, share):
        s["covered_demand"] = d
        out.append(Stop(id=s["id"], lonlat=s["lonlat"], route_ids=s["route_ids"],
                        riders_per_day_low=round(d * f["ridership_rate_low"], 1),
                        riders_per_day_high=round(d * f["ridership_rate_high"], 1), prov=prov, name=s.get("name")))
    return out


def suggest_measurements(stops: list[Stop], covered: dict[str, float], names: dict[str, str], f: dict,
                         sites: tuple[tuple[tuple[float, float], int], ...] = ()) -> list[MeasurementSuggestion]:
    """Top 3 stops to count; one per stop name (GTFS often has one id per side of the street).

    `sites`: (lon/lat, homes) of planned sites. Stops with planned homes inside their catchment come first, ranked by
    range width x those homes; then the rest by range width x covered demand. Without sites, only the second key."""
    def dep_homes(s: Stop) -> int:
        return sum(h for ll, h in sites if lonlat_dist_m(ll, s.lonlat) <= f["stop_catchment_m"])

    def key(s: Stop) -> tuple[float, float]:
        width = s.riders_per_day_high - s.riders_per_day_low
        return -width * dep_homes(s), -width * covered.get(s.id, 0)
    ranked = sorted(stops, key=key)
    out, seen = [], set()
    for s in ranked:
        name = names.get(s.id, s.id)
        # "8th / Irolo" and "Irolo / 8th" are one intersection: compare the set of street names
        corner = frozenset(p.strip().lower() for p in re.split(r"[/@&]", name)) or {name}
        if s.riders_per_day_high <= 0 or corner in seen:
            continue
        seen.add(corner)
        out.append(MeasurementSuggestion(what=f"Manual weekday passenger count at stop {name}, 7–9 am",
                                         target_id=s.id, expected_range_narrowing_pct=f["count_range_narrowing_pct"]))
        if len(out) == 3:
            break
    return out


def simulate_count(stop: Stop, f: dict) -> SimulatedCount:
    lo, hi = stop.riders_per_day_low, stop.riders_per_day_high
    count = lo + f["simulated_count_position_in_range"] * (hi - lo)
    half = (hi - lo) / 2 * (1 - f["count_range_narrowing_pct"] / 100)
    return SimulatedCount(stop_id=stop.id, simulated=True, count_per_day=round(count, 1), before=(lo, hi),
                          after=(round(max(0.0, count - half), 1), round(count + half, 1)))


