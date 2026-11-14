"""1. Infrastructure agent: where infrastructure already is, and how ready each target is to take more people."""
from shapely.geometry import LineString, Point, box, mapping, shape
from shapely.strtree import STRtree

from backend.agents import common
from backend.agents.context import RunContext
from backend.data.geo import lonlat_to_utm, to_utm
from backend.data.providers.fcc import served_at
from backend.data.resolver import Capability
from backend.models import geo_graph
from backend.models.infrastructure import readiness as readiness_model
from backend.schemas import InfraFeature, Sourced

NAME = "infrastructure"
GOAL = "Show where infrastructure already is, and how ready each parcel or building is to take more people."
SIDEWALK_YES = {"both", "left", "right", "yes", "separate"}
FOOT_TYPES = {"footway", "path", "pedestrian", "steps", "cycleway", "corridor", "track", "bridleway"}
WALK_KINDS = ("park", "clinic", "grocery", "school", "frequent_stop")


def _feat(kind, geom, attrs, prov) -> InfraFeature:
    return InfraFeature(kind=kind, geometry=geom, attrs=attrs, prov=prov)


def tools(ctx: RunContext):
    loc, r, f = ctx.locale, ctx.resolver, ctx.f

    def get_infra() -> str:
        """Collect existing infrastructure for the locale: transit, streets, utilities, EV chargers, broadband,
        amenities and flood zones. Returns counts by kind and which capabilities are missing."""
        ctx.step(NAME, "Collecting transit, streets, utilities, chargers, amenities and flood zones")
        feats: list[InfraFeature] = []
        layers: dict = {}
        for cap in (Capability.TRANSIT_EXISTING, Capability.STREETS, Capability.UTILITIES, Capability.EV_CHARGING,
                    Capability.BROADBAND, Capability.AMENITIES, Capability.FLOOD, Capability.WALK_NETWORK):
            got = r.get(loc, cap)
            layers[cap] = got
            if got.prov.confidence == "missing":
                ctx.missing.append(cap.value)
        tr = layers[Capability.TRANSIT_EXISTING]
        if tr.value:
            for rt in tr.value["routes"]:
                p = rt["properties"]
                feats.append(_feat("rail" if p["mode"] == "rail" else "bus_route", rt["geometry"],
                                   {k: p.get(k) for k in ("route_id", "short_name", "peak_headway_min", "color")}, tr.prov))
            for s in tr.value["stops"]:
                p = s["properties"]
                feats.append(_feat("bus_stop", s["geometry"], {k: p.get(k) for k in ("stop_id", "name", "peak_headway_min",
                                                                                      "rail")}, tr.prov))
        st = layers[Capability.STREETS]
        if st.value:
            for b in st.value["bike_lanes"]:
                feats.append(_feat("bike_lane", b["geometry"], {"name": b["properties"].get("name")}, st.prov))
        ut = layers[Capability.UTILITIES]
        if ut.value:
            for kind, fs in ut.value.items():
                for u in fs:
                    feats.append(_feat(kind, u["geometry"], {"layer": u["properties"].get("layer")}, ut.prov))
        ev = layers[Capability.EV_CHARGING]
        for e in ev.value or []:
            feats.append(_feat("ev_charger", e["geometry"], {"name": e["properties"].get("name")}, ev.prov))
        am = layers[Capability.AMENITIES]
        for a in am.value or []:
            feats.append(_feat(a["properties"]["kind"], a["geometry"], {"name": a["properties"].get("name")}, am.prov))
        fl = layers[Capability.FLOOD]
        for z in fl.value or []:
            # display copy: clipped to the locale and simplified (~5 m); flood tests use the full geometry
            g = shape(z["geometry"]).intersection(box(*loc.bbox)).simplify(0.00005)
            if not g.is_empty:
                feats.append(_feat("flood_zone", mapping(g), {"FLD_ZONE": z["properties"]["FLD_ZONE"]}, fl.prov))
        wn = layers[Capability.WALK_NETWORK]
        if wn.value:
            nodes = {n[0]: (n[1], n[2]) for n in wn.value["nodes"]}
            for u, v, length, hw, sw in wn.value["edges"]:
                if hw in FOOT_TYPES or u not in nodes or v not in nodes:
                    continue
                feats.append(_feat("sidewalk", {"type": "LineString", "coordinates": [nodes[u], nodes[v]]},
                                   {"sidewalk": sw or "unknown", "highway": hw}, wn.prov))
        ctx.cache["layers"] = layers
        ctx.plan_parts["infrastructure"] = feats
        counts: dict[str, int] = {}
        for x in feats:
            counts[x.kind] = counts.get(x.kind, 0) + 1
        ctx.step(NAME, f"Mapped {len(feats)} features", {"counts": counts})
        return f"features by kind: {counts}; missing capabilities: {ctx.missing or 'none'}"

    def readiness() -> str:
        """Score readiness (0-1) of every candidate parcel and building from walk distances, sidewalks, bike lanes,
        utilities, EV chargers, broadband and flood zones. Returns counts and the mean score."""
        layers = ctx.cache.get("layers")
        if layers is None:
            raise ValueError("run get_infra first")
        epsg = loc.utm_epsg
        ctx.step(NAME, "Building the walk network")
        wn = layers[Capability.WALK_NETWORK].value
        G = geo_graph.build_walk_graph(wn, epsg) if wn else None
        ctx.graph = G
        idx = geo_graph.NodeIndex(G) if G is not None and len(G) else None
        ctx.cache["node_index"] = idx

        def nodes_for(points_lonlat):
            return idx.nearest([lonlat_to_utm(*p, epsg) for p in points_lonlat])[0] if idx and points_lonlat else []

        def pt_of(geom):
            return common.centroid_lonlat(geom)

        tr = layers[Capability.TRANSIT_EXISTING].value or {"stops": []}
        freq = [s["geometry"]["coordinates"] for s in tr["stops"]
                if s["properties"].get("rail") or (s["properties"].get("peak_headway_min") is not None and
                                                   s["properties"]["peak_headway_min"] <= f["readiness_frequent_headway_max_min"])]
        amen = layers[Capability.AMENITIES].value or []
        ev = layers[Capability.EV_CHARGING].value or []
        sources = {"frequent_stop": freq,
                   **{k: [pt_of(a["geometry"]) for a in amen if a["properties"]["kind"] == k]
                      for k in ("park", "clinic", "grocery", "school")},
                   "ev": [e["geometry"]["coordinates"] for e in ev],
                   "station": [s.lonlat for s in loc.stations]}
        ctx.step(NAME, "Computing walk distances to stops, parks, clinics, groceries, schools, chargers")
        ctx.dists = {k: geo_graph.dist_from_sources(G, nodes_for(v)) if G is not None else {} for k, v in sources.items()}

        parcels = common.load_parcels(ctx)
        buildings = common.load_buildings(ctx)
        cand_b = common.candidate_buildings(ctx)
        cand_p = common.underused_parcels(ctx)
        # all non-residential parcels go into the plan (meeting-mode targets); residential lots stay out
        plan_parcels = [p for p in parcels if p.land_use.value not in ("residential",)]
        keep_ids = {p.id for p in plan_parcels}
        for b in cand_b:
            if b.parcel_id and b.parcel_id not in keep_ids:
                keep_ids.add(b.parcel_id)
                plan_parcels.append(ctx.cache["parcels_by_id"][b.parcel_id])
        ctx.cache["plan_parcels"] = plan_parcels
        # distances for every plan parcel and candidate building
        targets = [(p.id, p.geometry) for p in plan_parcels] + [(b.id, b.footprint) for b in cand_b]
        cents = {tid: pt_of(g) for tid, g in targets}
        tids = list(cents)
        tnodes, snap = (idx.nearest([lonlat_to_utm(*cents[t], epsg) for t in tids]) if idx else ([None] * len(tids),
                                                                                                    [0.0] * len(tids)))
        walk_m, station_m = {}, {}
        for t, n, d0 in zip(tids, tnodes, snap):
            w = {}
            for k in ("park", "clinic", "grocery", "school", "frequent_stop", "ev"):
                v = ctx.dists[k].get(n) if n is not None else None
                w[k] = round(v + d0, 1) if v is not None else None
            walk_m[t] = w
            sv = ctx.dists["station"].get(n) if n is not None else None
            station_m[t] = round(sv + d0, 1) if sv is not None else None
        ctx.cache["station_walk_m"] = station_m
        # flood
        flood = layers[Capability.FLOOD].value or []
        fgeoms = [shape(z["geometry"]) for z in flood]
        ftree = STRtree(fgeoms) if fgeoms else None
        in_flood, zone_of = {}, {}
        for t in tids:
            pt = Point(cents[t])
            hits = ftree.query(pt, predicate="within") if ftree else []
            in_flood[t] = bool(len(hits))
            if len(hits):
                zone_of[t] = flood[hits[0]]["properties"]["FLD_ZONE"]
        # streets near each readiness target: frontages and sidewalks
        edges, edge_sw = [], []
        footway_sw = []
        if G is not None:
            for u, v, a in G.edges(data=True):
                line = LineString([(G.nodes[u]["x"], G.nodes[u]["y"]), (G.nodes[v]["x"], G.nodes[v]["y"])])
                if a.get("sidewalk") == "footway_sidewalk":
                    footway_sw.append(line)
                elif a.get("highway") not in FOOT_TYPES:
                    edges.append(line)
                    edge_sw.append(a.get("sidewalk"))
        etree = STRtree(edges) if edges else None
        fwtree = STRtree(footway_sw) if footway_sw else None
        bikes = [to_utm(b["geometry"], epsg) for b in (layers[Capability.STREETS].value or {}).get("bike_lanes", [])]
        btree = STRtree(bikes) if bikes else None
        util = layers[Capability.UTILITIES].value
        # served = a water/sewer main or service area within 30 m; substations (points) would only be map
        # features, never part of this check
        ugeoms = [to_utm(u["geometry"], epsg) for k, fs in (util or {}).items() if k != "power_substation" for u in fs]
        utree = STRtree(ugeoms) if ugeoms else None
        bb = layers[Capability.BROADBAND].value

        rtargets = [(p.id, p.geometry) for p in cand_p] + [(b.id, b.footprint) for b in cand_b]
        ctx.step(NAME, f"Scoring readiness of {len(cand_p)} underused parcels and {len(cand_b)} buildings")
        measures = []
        for tid, geom in rtargets:
            g = to_utm(geom, epsg)
            front, with_sw, known = 0, 0, 0
            if etree is not None:
                for i in etree.query(g.buffer(25)):
                    front += 1
                    sw = edge_sw[i]
                    has_fw = fwtree is not None and len(fwtree.query(edges[i].buffer(15), predicate="intersects")) > 0
                    if sw in SIDEWALK_YES or has_fw:
                        with_sw += 1
                        known += 1
                    elif sw is not None:
                        known += 1
            bike_m = None
            if btree is not None:
                j = btree.nearest(g)
                bike_m = bikes[j].distance(g)
            if util is None:
                u = None
            else:
                u = utree is not None and len(utree.query(g.buffer(30), predicate="intersects")) > 0
            w = walk_m.get(tid, {})
            # FCC BDC: served at 100/20 in the H3 cell containing the target centroid; None when no cell covers it
            broadband = None if bb is None else served_at(bb, *(cents.get(tid) or pt_of(geom)))
            measures.append({"id": tid, "dist_m": {"transit": w.get("frequent_stop"), **{k: w.get(k) for k in
                                                                                          ("grocery", "clinic", "school", "park", "ev")}},
                             "sidewalk": {"frontages": front, "with": with_sw, "known": known}, "bike_m": bike_m,
                             "utilities": u, "broadband": broadband, "flood_zone": zone_of.get(tid)})
        rd = readiness_model(measures, f)
        ctx.plan_parts["readiness"] = rd
        ctx.pre.update(walk_m={t: {k: w[k] for k in WALK_KINDS} for t, w in walk_m.items()}, in_flood=in_flood,
                       centroid=cents)
        mean = sum(x.score for x in rd) / len(rd) if rd else 0
        return f"readiness for {len(rd)} targets, mean {mean:.2f}; {sum(in_flood.values())} targets in flood zones"

    return [get_infra, readiness]


def run(ctx: RunContext) -> None:
    for t in tools(ctx):
        t()


def explain(ctx: RunContext) -> str:
    feats = ctx.plan_parts.get("infrastructure", [])
    rd = ctx.plan_parts.get("readiness", [])
    mean = sum(x.score for x in rd) / len(rd) if rd else 0
    miss = ", ".join(sorted(set(ctx.missing))) or "none"
    return (f"Mapped {len(feats)} existing infrastructure features and scored {len(rd)} parcels and buildings "
            f"(mean readiness {mean:.2f}). Data not available here: {miss}.")
