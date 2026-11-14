"""2. Transit network agent: a phased network within an annual operating budget."""
from pyproj import Transformer

from backend.agents.context import RunContext
from backend.data.geo import lonlat_to_utm
from backend.data.resolver import Capability
from backend.models import transit
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
        grid = transit.demand_grid(d.value or [], f, epsg)
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
        return f"{rail} rail routes, {bus} bus routes, {len(ctx.cache['existing']['stops'])} stops"

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
        sel = [(c["id"], c["phase"]) for c in res["selected"]]
        return f"selected {sel}; annual cost ${res['spent']:,.0f} of ${budget:,.0f}; notes: {res['notes']}"

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
                          "route_ids": s["properties"]["route_ids"]})
        for c in net["selected"]:
            if c["type"] != "feeder":
                continue
            for i, xy in enumerate(c["stops_xy"]):
                sid = f"{c['id']}-s{i}"
                names[sid] = f"{c['name']} stop {i + 1}"
                stops.append({"id": sid, "lonlat": to_lonlat(*xy), "xy": xy, "route_ids": [c["id"]]})
        out = transit.estimate_ridership(stops, ctx.cache["grid"], f, ctx.cache["demand_prov"])
        ctx.cache["stops"] = out
        ctx.cache["stop_names"] = names
        ctx.cache["covered"] = {s["id"]: s["covered_demand"] for s in stops}
        return f"{len(out)} stops with ridership ranges"

    def suggest_measurements() -> str:
        """Rank stops by ridership range width x demand and suggest counts that would narrow the range most."""
        if "stops" not in ctx.cache:
            raise ValueError("run estimate_ridership first")
        ms = transit.suggest_measurements(ctx.cache["stops"], ctx.cache["covered"], ctx.cache["stop_names"], f)
        ctx.plan_parts["transit"] = TransitPlan(routes=ctx.cache["net"]["routes"], stops=ctx.cache["stops"],
                                                measurements=ms, budget_usd=float(f["transit_budget_usd"]))
        ctx.step(NAME, f"{len(ms)} measurements would narrow ridership ranges most")
        return "; ".join(m.what for m in ms)

    return [get_demand, get_existing_transit, optimize_network, estimate_ridership, suggest_measurements]


def run(ctx: RunContext) -> None:
    for t in tools(ctx):
        t()


def explain(ctx: RunContext) -> str:
    tp = ctx.plan_parts.get("transit")
    if tp is None:
        return "Transit plan not built."
    new = [r for r in tp.routes if r.phase > 0]
    upg = [r for r in new if r.id.startswith("upg-")]
    cost = sum(r.annual_operating_cost_usd for r in new)
    notes = "; ".join(ctx.cache.get("net", {}).get("notes", []))
    return (f"{len(new)} new or upgraded services ({len(upg)} frequency upgrades of existing routes) for "
            f"${cost:,.0f}/yr of a ${tp.budget_usd:,.0f} budget; existing rail kept. "
            f"Ridership is a low-high range per stop. {notes}").strip()
