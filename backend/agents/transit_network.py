"""2. Transit network agent: a phased network within an annual operating budget."""
from pyproj import Transformer
from shapely.geometry import Point

from backend.agents import common
from backend.agents.context import RunContext
from backend.data.geo import lonlat_to_utm
from backend.data.resolver import Capability
from backend.models import transit
from backend.models.rescore import in_plan
from backend.schemas import TransitPlan

NAME = "transit_network"
GOAL = "Design a phased transit network (on-demand, frequent bus, BRT) within an annual operating budget."


def tools(ctx: RunContext):
    loc, r, f = ctx.locale, ctx.resolver, ctx.f
    epsg = loc.utm_epsg
    back = Transformer.from_crs(epsg, 4326, always_xy=True)

    def to_lonlat(x, y):
        lon, lat = back.transform(x, y)
        return (round(lon, 6), round(lat, 6))

    def get_demand() -> str:
        """Aggregate homes, jobs and zero-car households into ~0.5 km hexes. Returns the cell count and totals."""
        d = r.get(loc, Capability.DEMAND)
        ctx.cache["demand_prov"] = d.prov
        pts = d.value or []
        if ctx.boundary is not None:   # drawn sub-area: demand inside it only; stops and routes stay whole
            pts = [p for p in pts if ctx.boundary.contains(Point(*p["lonlat"]))]
        grid = transit.demand_grid(pts, f, epsg)
        ctx.cache["grid"] = grid
        ctx.pre["demand_cells"] = [{"h3": c["h3"], "lonlat": c["lonlat"], "demand": round(c["demand"], 1),
                                    "homes": c["homes"]} for c in grid]
        ctx.step(NAME, f"Demand grid: {len(grid)} hexes")
        return f"{len(grid)} demand cells; homes {sum(c['homes'] for c in grid)}, jobs {sum(c['jobs'] for c in grid)}"

    def get_existing_transit() -> str:
        """Load existing GTFS routes and stops near the locale. Returns route counts by mode."""
        t = r.get(loc, Capability.TRANSIT_EXISTING)
        ctx.cache["existing"] = t.value or {"routes": [], "stops": []}
        ctx.cache["existing_prov"] = t.prov
        rail = sum(1 for x in ctx.cache["existing"]["routes"] if x["properties"]["mode"] == "rail")
        bus = len(ctx.cache["existing"]["routes"]) - rail
        ctx.step(NAME, f"Existing service: {rail} rail and {bus} bus routes")
        return f"{rail} rail routes, {bus} bus routes, {len(ctx.cache['existing']['stops'])} stops; " \
               f"{common.stations_text(ctx)}"

    def optimize_network() -> str:
        """Pick frequency upgrades, feeders, BRT and on-demand zones greedily by covered demand per dollar within
        the annual operating budget. Returns the selected route ids, phases and spend."""
        if "grid" not in ctx.cache or "existing" not in ctx.cache:
            raise ValueError("run get_demand and get_existing_transit first")
        budget = float(f["transit_budget_usd"])
        ctx.step(NAME, "Generating frequency upgrades and station feeders")
        stations = [{"name": s.name, "lonlat": s.lonlat} for s in loc.stations]
        cands = transit.candidates(ctx.cache["existing"], ctx.cache["grid"], ctx.graph, stations, f, epsg, to_lonlat)
        ctx.step(NAME, f"Selecting from {len(cands)} candidates within ${budget:,.0f}/yr")
        res = transit.optimize_network(ctx.cache["existing"], ctx.cache["grid"], cands, budget, f, epsg, loc.id, to_lonlat)
        ctx.cache["net"] = res
        def describe(c):
            what = {"upgrade": f"route {c.get('name') or c['id']} from every {c.get('old_headway_min') or 0:.0f} to "
                               f"every {c['headway_min']} min",
                    "feeder": f"new {c.get('name') or 'feeder'} every {c['headway_min']} min",
                    "brt": f"BRT on {c.get('name') or c['id']} every {c['headway_min']} min",
                    "on_demand": "an on-demand zone"}.get(c["type"], c["type"])
            return f"{what} (phase {c['phase']}, ${c['cost']:,.0f}/yr)"
        sel = "; ".join(describe(c) for c in res["selected"]) or "nothing fits the budget"
        notes = " ".join(n[0].upper() + n[1:] + "." for n in res["notes"])
        return f"Selected: {sel}. Annual cost ${res['spent']:,.0f} of ${budget:,.0f}. {notes}".strip()

    def estimate_ridership() -> str:
        """Ridership range (low-high riders/day) per stop from covered demand. Returns the stop count."""
        net = ctx.cache.get("net")
        if net is None:
            raise ValueError("run optimize_network first")
        b = loc.bbox
        stops, names = [], {}
        for s in ctx.cache["existing"]["stops"]:
            lon, lat = s["geometry"]["coordinates"]
            if not (b[0] <= lon <= b[2] and b[1] <= lat <= b[3]):
                continue
            sid = s["properties"]["stop_id"]
            names[sid] = s["properties"]["name"]
            stops.append({"id": sid, "lonlat": (lon, lat), "xy": lonlat_to_utm(lon, lat, epsg),
                          "route_ids": s["properties"]["route_ids"], "name": names[sid]})
        for c in net["selected"]:
            if c["type"] != "feeder":
                continue
            for i, xy in enumerate(c["stops_xy"]):
                sid = f"{c['id']}-s{i}"
                names[sid] = f"{c['name']} stop {i + 1}"
                stops.append({"id": sid, "lonlat": to_lonlat(*xy), "xy": xy, "route_ids": [c["id"]], "name": names[sid]})
        out = transit.estimate_ridership(stops, ctx.cache["grid"], f, ctx.cache["demand_prov"])
        ctx.cache["stops"] = out
        ctx.cache["stop_names"] = names
        ctx.cache["covered"] = {s["id"]: s["covered_demand"] for s in stops}
        busiest = sorted(out, key=lambda s: -s.riders_per_day_high)[:3]
        return (f"{len(out)} stops with ridership ranges, {sum(s.riders_per_day_low for s in out):,.0f}-"
                f"{sum(s.riders_per_day_high for s in out):,.0f} riders/day in total; busiest: "
                + "; ".join(f"{names.get(s.id, s.id)} {s.riders_per_day_low:,.0f}-{s.riders_per_day_high:,.0f}"
                            for s in busiest))

    def suggest_measurements() -> str:
        """Rank stops by ridership range width x demand and suggest counts that would narrow the range most."""
        if "stops" not in ctx.cache:
            raise ValueError("run estimate_ridership first")
        ms = transit.suggest_measurements(ctx.cache["stops"], ctx.cache["covered"], ctx.cache["stop_names"], f)
        ctx.plan_parts["transit"] = TransitPlan(routes=ctx.cache["net"]["routes"], stops=ctx.cache["stops"],
                                                measurements=ms, budget_usd=float(f["transit_budget_usd"]))
        ctx.step(NAME, f"{len(ms)} measurements would narrow ridership ranges most")
        return ("Ridership counts to narrow the ranges are chosen once sites are picked, favouring stops whose "
                "catchment holds planned homes")

    return [get_demand, get_existing_transit, optimize_network, estimate_ridership, suggest_measurements]


def run(ctx: RunContext) -> None:
    for t in tools(ctx):
        t()


def finalize_measurements(ctx: RunContext) -> None:
    """Re-rank the suggested counts once sites exist: stops serving planned homes first (models/transit)."""
    tp, sites = ctx.plan_parts.get("transit"), ctx.plan_parts.get("sites")
    if tp is None or not sites or "stops" not in ctx.cache:
        return
    pts = tuple((common.centroid_lonlat(s.geometry), s.homes) for s in sites if in_plan(s) and s.homes)
    ms = transit.suggest_measurements(ctx.cache["stops"], ctx.cache["covered"], ctx.cache["stop_names"], ctx.f, pts)
    ctx.plan_parts["transit"] = tp.model_copy(update={"measurements": ms})


def explain(ctx: RunContext) -> str:
    tp = ctx.plan_parts.get("transit")
    if tp is None:
        return "Transit plan not built."
    new = [r for r in tp.routes if r.phase > 0]
    upg = [r for r in new if r.id.startswith("upg-")]
    cost = sum(r.annual_operating_cost_usd for r in new)
    notes = " ".join(n[0].upper() + n[1:] + "." for n in ctx.cache.get("net", {}).get("notes", []))
    return (f"{len(new)} new or upgraded services ({len(upg)} frequency upgrades of existing routes) for "
            f"${cost:,.0f}/yr of a ${tp.budget_usd:,.0f} budget; existing rail kept. "
            f"Ridership is a low-high range per stop. {notes}").strip()
