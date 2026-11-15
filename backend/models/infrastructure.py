"""Infrastructure readiness (docs/05). Pure: measurements in, InfraReadiness out.

Each target dict carries measurements the infrastructure agent took from the walk graph and layers:
  id, dist_m: {transit, grocery, clinic, school, park, ev} (walk metres; None = none reachable / no data),
  ev_data: bool, sidewalk: {"frontages": M, "with": n, "known": k}, bike_m: float|None,
  utilities: True|False|None (None = no public layer), broadband: True|False|None, flood_zone: str|None
"""
from typing import Any, Optional

from backend.schemas import InfraReadiness

LABEL = {"transit": "frequent transit stop", "grocery": "grocery", "clinic": "clinic", "school": "school",
         "park": "park"}


def walk_threshold_m(f: dict) -> float:
    return f["walk_speed_m_per_s"] * 60 * f["walk_minutes_target"]


def distance_score(d: Optional[float], f: dict) -> float:
    if d is None:
        return 0.0
    return max(0.0, 1 - d / walk_threshold_m(f))


def components(t: dict, f: dict) -> tuple[dict[str, float], list[str], list[str]]:
    thr = walk_threshold_m(f)
    miss = f["reuse_missing_input_score"]
    s: dict[str, float] = {}
    present, gaps = [], []
    for k, label in LABEL.items():
        d = t["dist_m"].get(k)
        s[k] = distance_score(d, f)
        if d is not None and d <= thr:
            present.append(f"{label} {d:.0f} m walk")
        else:  # one threshold, the walk threshold; the score still grades distance
            gaps.append(f"no {label} within {thr:.0f} m walk" + (f" (nearest {d:.0f} m)" if d is not None
                                                                  else " (none reachable)"))
    sw = t["sidewalk"]
    if sw["frontages"] == 0:
        s["sidewalk"] = miss
        gaps.append("no street frontage found next to this site (OSM); verify sidewalk access")
    elif sw["known"] == 0:
        s["sidewalk"] = miss
        gaps.append(f"sidewalk not mapped on {sw['frontages']} of {sw['frontages']} frontages (OSM); verify")
    else:
        # unmapped frontages are unknown, not absent: they score the missing-input value
        unknown = sw["frontages"] - sw["known"]
        s["sidewalk"] = (sw["with"] + miss * unknown) / sw["frontages"]
        if sw["with"]:
            present.append(f"sidewalk on {sw['with']} of {sw['frontages']} frontages")
        if sw["known"] - sw["with"] > 0:
            gaps.append(f"no sidewalk on {sw['known'] - sw['with']} of {sw['frontages']} frontages")
        if unknown:
            gaps.append(f"sidewalk not mapped on {unknown} of {sw['frontages']} frontages (OSM); verify")
    bike = t.get("bike_m")
    s["bike"] = 1.0 if bike is not None and bike <= f["bike_lane_reach_m"] else 0.0
    if s["bike"]:
        present.append(f"bike lane {bike:.0f} m")
    else:
        gaps.append(f"no bike lane within {f['bike_lane_reach_m']:.0f} m")
    u = t.get("utilities")
    if u is None:
        s["utilities"] = miss
        gaps.append("utility data not public here; confirm with the utility")
    else:
        s["utilities"] = 1.0 if u else 0.0
        (present if u else gaps).append("inside public water/sewer layer" if u else
                                        "no mapped water/sewer line near this site; confirm with the utility")
    ev = t["dist_m"].get("ev")
    s["ev"] = 1.0 if ev is not None and ev <= thr else 0.0
    if s["ev"]:
        present.append(f"EV charger {ev:.0f} m walk")
    else:
        gaps.append(f"no EV charger within {thr:.0f} m walk")
    bb = t.get("broadband")
    if bb is None:
        s["broadband"] = miss
        gaps.append("broadband data not available here")
    else:
        s["broadband"] = 1.0 if bb else 0.0
        (present if bb else gaps).append("broadband 100/20 Mbps served (FCC BDC)" if bb else
                                         "no 100/20 Mbps broadband at this site (FCC BDC); confirm with providers")
    if t.get("flood_zone"):
        gaps.append(f"inside FEMA high-risk flood zone ({t['flood_zone']}): no new homes")
    return s, present, gaps


def readiness(targets: list[dict[str, Any]], f: dict) -> list[InfraReadiness]:
    w = f["readiness_weights"]
    out = []
    for t in targets:
        s, present, gaps = components(t, f)
        score = sum(w[k] * s[k] for k in w) / sum(w.values())
        out.append(InfraReadiness(target_id=t["id"], score=round(score, 4), present=present, gaps=gaps))
    return out
