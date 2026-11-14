from backend.models.infrastructure import readiness

F = {"walk_speed_m_per_s": 1.0, "walk_minutes_target": 10, "reuse_missing_input_score": 0.5, "bike_lane_reach_m": 400,
     "readiness_weights": {"transit": .3, "grocery": .1, "clinic": .1, "school": .1, "park": .1, "sidewalk": .1,
                           "bike": .05, "utilities": .05, "ev": .05, "broadband": .05}}


def test_readiness_hand_checked():
    t = {"id": "p", "dist_m": {"transit": 300, "grocery": 0, "clinic": 600, "school": None, "park": 150, "ev": 100},
         "sidewalk": {"frontages": 4, "with": 2, "known": 4}, "bike_m": 1000, "utilities": None, "broadband": None,
         "flood_zone": "AE"}
    r = readiness([t], F)[0]
    # transit .5, grocery 1, clinic 0, school 0, park .75, sidewalk .5, bike 0, utilities .5, ev 1, broadband .5
    exp = .3 * .5 + .1 * 1 + .1 * .75 + .1 * .5 + .05 * .5 + .05 * 1 + .05 * .5
    assert abs(r.score - exp) < 1e-4
    assert "utility data not public here; confirm with the utility" in r.gaps
    assert "broadband data not available here" in r.gaps
    assert any("flood zone (AE): no new homes" in g for g in r.gaps)
    assert not any("no utility service" in g for g in r.gaps)
