from backend.models.targets import (embodied_co2_not_built, embodied_co2_saved, flood_exposure, rooftop_solar,
                                    transport_co2, walk_access)

F = {"vmt_reduction_per_household_near_transit": 5000, "co2_g_per_vehicle_mile": 400,
     "embodied_co2_kg_per_sqft_new": 30, "embodied_co2_kg_per_sqft_reuse": 10, "usable_roof_share": 0.5,
     "solar_kw_per_m2": 0.2, "walk_speed_m_per_s": 1.0, "walk_minutes_target": 10, "avg_unit_sqft_residential": 900}


def test_hand_checked_targets():
    assert transport_co2(100, F) == 200.0                      # 100 x 5000 x 400 / 1e6
    assert embodied_co2_saved(100_000, F) == 2000.0            # 100k x 20 / 1000
    assert embodied_co2_not_built(10, F) == 270.0              # 10 homes x 900 sqft x 30 / 1000
    assert round(rooftop_solar([10.7639], 1500, F), 6) == 0.15  # 1 m2 x .5 x .2 kW x 1500 / 1000
    walk = {"a": {"park": 100, "clinic": 500, "grocery": 599}, "b": {"park": 100, "clinic": 700, "grocery": 1}}
    assert walk_access({"a": 30, "b": 10}, walk, F) == 0.75     # threshold 600 m
    assert flood_exposure({"a": 30, "b": 10}, {"b": True}) == 0.25


def test_walk_gaps_count_homes_beyond_each_amenity():
    from backend.models.targets import walk_gaps
    walk = {"a": {"park": 100, "clinic": 500, "grocery": 599}, "b": {"park": 100, "clinic": 700, "grocery": None}}
    assert walk_gaps({"a": 30, "b": 10}, walk, F) == {"park": 0, "clinic": 10, "grocery": 10}
