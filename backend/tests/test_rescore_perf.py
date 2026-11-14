import time
from datetime import datetime, timezone

from backend.data.factors import resolve
from backend.models.rescore import rescore
from backend.schemas import (Building, ConversionCandidate, Edit, FitScores, LegalPath, Locale, Parcel, Plan,
                             Precomputed, Provenance, Site, Sourced, Station, TransitPlan, ZoningEnvelope)

NOW = datetime(2026, 11, 13, tzinfo=timezone.utc)
P = Provenance(source="test", confidence="medium", retrieved_at=NOW)
SQ = {"type": "Polygon", "coordinates": [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]]}


def s(v):
    return Sourced(value=v, prov=P)


def synthetic_plan(n_parcels=3000, n_buildings=500) -> Plan:
    loc = Locale(id="houston_downtown", name="t", purpose="t", data_tier="costar_full", jurisdiction="houston",
                 bbox=(-95.4, 29.7, -95.3, 29.8), stations=[Station(name="S", lonlat=(-95.36, 29.75), mode="light_rail",
                                                                    source_url="x")],
                 utm_epsg=32615, county_fips="48201", transit_agency="METRO")
    parcels, walk, flood, cent, homes = [], {}, {}, {}, {}
    for i in range(n_parcels):
        pid = f"p{i}"
        parcels.append(Parcel(id=pid, geometry=SQ, area_acres=s(0.5), land_use=s("surface_parking"), owner=s("ACME"),
                              last_sale_usd=s(None), last_sale_year=s(2000), lease_expiry_year=s(None),
                              address=s(f"{i} Main"), assessed_value_usd=s(2_000_000.0), zoning_code=s(None)))
        c = (-95.4 + (i % 60) * 0.0015, 29.7 + (i // 60) * 0.0015)
        cent[pid] = c
        walk[pid] = {"park": 900.0, "clinic": 300.0, "grocery": 300.0, "school": 500.0, "frequent_stop": 300.0}
        flood[pid] = i % 10 == 0
        homes[pid] = 120
    buildings, convs = [], []
    path = LegalPath(name="Houston development rules", eligible=True,
                     allows={"allows_uses": ["residential", "hotel", "mixed_use", "keep_current"]}, citations=[])
    for j in range(n_buildings):
        bid = f"b{j}"
        buildings.append(Building(id=bid, parcel_id=f"p{j}", footprint=SQ, property_type=s("office"),
                                  building_class=s(None), year_built=s(1970), year_renovated=s(None), stories=s(20),
                                  rentable_area_sqft=s(300_000.0), typical_floor_sqft=s(15_000.0), vacancy_pct=s(40.0),
                                  asking_rent_usd_sqft_yr=s(20.0), parking_spaces=s(None), floor_depth_ft=s(40.0),
                                  ceiling_height_ft=s(None), window_wall_pct=s(None), roof_area_sqft=s(15_000.0),
                                  name=s(bid)))
        fs = FitScores(physical=.8, legal=1, market=.7, financial=.4, location=.7)
        convs.append(ConversionCandidate(building_id=bid, best_use="residential",
                                         scores_by_use={u: fs for u in ("residential", "hotel", "mixed_use", "keep_current")},
                                         overall=.7, est_units=240, blockers=[], legal_path=path,
                                         embodied_co2_saved_tonnes=1000.0, confidence="low", screening_only=False,
                                         details=[]))
        walk[bid] = walk[f"p{j}"]
        cent[bid] = cent[f"p{j}"]
    sites = [Site(id=f"s{i}", kind="new_build", parcel_ids=[f"p{i + 1}"], building_id=None, geometry=SQ, homes=120,
                  height_ft=84, status="pursue") for i in range(5)]
    return Plan(id="t", locale=loc, infrastructure=[], readiness=[], transit=TransitPlan(routes=[], stops=[],
                measurements=[], budget_usd=1e7), parcels=parcels, buildings=buildings,
                envelopes=[ZoningEnvelope(parcel_id="p1", paths=[path], recommended_path=path.name, covered=True)],
                conversions=convs, sites=sites, deals=[], stacks=[], targets=[], created_at=NOW, prompt="t", notes={},
                agent_errors={}, precomputed=Precomputed(walk_m=walk, in_flood=flood, centroid=cent,
                                                         homes_by_parcel=homes,
                                                         demand_cells=[{"h3": "x", "lonlat": [-95.39, 29.71],
                                                                        "demand": 5000, "homes": 100}],
                                                         solar_kwh_per_kw_year=1400.0))


EDITS = [Edit(kind="place_tile", tile="park", target_id="p2"),
         Edit(kind="place_tile", tile="homes", target_id="p61"),
         Edit(kind="place_tile", tile="stop", target_id="p100"),
         Edit(kind="place_tile", tile="convert_residential", target_id="b7"),
         Edit(kind="slider", value=0.5)]


def test_five_edits_under_300ms():
    plan, f = synthetic_plan(), resolve("houston_downtown")
    rescore(plan, [], f)  # warm lookups, as the API does on plan load
    t = time.perf_counter()
    for i in range(1, len(EDITS) + 1):
        rescore(plan, EDITS[:i], f)
    assert time.perf_counter() - t < 0.3


def test_reset_restores_and_flood_rejects():
    plan, f = synthetic_plan(200, 20), resolve("houston_downtown")
    base = rescore(plan, [], f)
    assert all(v == 0 for v in base.deltas.values())
    park = rescore(plan, EDITS[:1], f)
    assert park.scoreboard.homes == base.scoreboard.homes - 120  # site s1 sat on p2
    assert rescore(plan, [], f).scoreboard == base.scoreboard
    r = rescore(plan, [Edit(kind="place_tile", tile="homes", target_id="p10")], f)
    assert r.rejected and "flood" in r.rejected.reason and r.scoreboard == base.scoreboard
