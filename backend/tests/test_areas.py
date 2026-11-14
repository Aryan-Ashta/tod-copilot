import pytest

from backend.data.areas import AreaError, resolve_area

HOUSTON_SUB = {"type": "Polygon", "coordinates": [[[-95.368, 29.755], [-95.362, 29.755], [-95.362, 29.760],
                                                   [-95.368, 29.760], [-95.368, 29.755]]]}
DENVER = {"type": "Polygon", "coordinates": [[[-105.005, 39.748], [-104.990, 39.748], [-104.990, 39.758],
                                              [-105.005, 39.758], [-105.005, 39.748]]]}


def _square(lon, lat, d):
    return {"type": "Polygon", "coordinates": [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d],
                                                [lon, lat]]]}


def test_subarea_inside_houston():
    a = resolve_area(None, HOUSTON_SUB, 12)
    assert (a.kind, a.locale_id) == ("subarea", "houston_downtown")


def test_crossing_edge_rejected():
    with pytest.raises(AreaError, match="crosses the edge"):
        resolve_area(None, _square(-95.39, 29.750, 0.02), 12)


def test_denver_is_custom():
    assert resolve_area(None, DENVER, 12).kind == "custom"


def test_too_large_rejected():
    with pytest.raises(AreaError, match="draw at most 12"):
        resolve_area(None, _square(-104.0, 40.0, 0.05), 12)   # ~4.3 x 5.6 km = ~24 km²


def test_no_boundary_needs_recorded_locale():
    assert resolve_area("brevard_cocoa", None, 12).kind == "recorded"
    with pytest.raises(AreaError):
        resolve_area("area-nope", None, 12)
