import pytest

from backend.data.areas import AreaError, resolve_area

HOUSTON_SUB = {"type": "Polygon", "coordinates": [[[-95.368, 29.755], [-95.362, 29.755], [-95.362, 29.760],
                                                   [-95.368, 29.760], [-95.368, 29.755]]]}


def _square(lon, lat, d):
    return {"type": "Polygon", "coordinates": [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d],
                                                [lon, lat]]]}


def test_subarea_inside_houston():
    a = resolve_area(None, HOUSTON_SUB, 12)
    assert (a.kind, a.locale_id) == ("subarea", "houston_downtown")


def test_galleria_is_city_of_houston_metro_area():
    a = resolve_area(None, _square(-95.468, 29.735, 0.012), 12)
    assert (a.kind, a.sources_from, a.jurisdiction) == ("metro", "houston_downtown", "houston")


def test_box_crossing_a_recorded_edge_records_as_metro_area():
    a = resolve_area(None, _square(-95.39, 29.750, 0.02), 12)
    assert (a.kind, a.jurisdiction) == ("metro", "houston")


def test_la_county_outside_city_of_la_has_no_city_corpus():
    a = resolve_area(None, _square(-118.495, 34.010, 0.012), 12)   # Santa Monica
    assert (a.kind, a.sources_from) == ("metro", "la_wilshire_koreatown")
    assert a.jurisdiction != "los_angeles"


@pytest.mark.parametrize("lon,lat", [(-105.0, 39.75), (-80.70, 28.30)])   # Denver; Brevard outside the recorded box
def test_outside_supported_counties_rejected(lon, lat):
    with pytest.raises(AreaError, match="only Harris County"):
        resolve_area(None, _square(lon, lat, 0.01), 12)


def test_too_large_rejected():
    with pytest.raises(AreaError, match="draw at most 12"):
        resolve_area(None, _square(-95.45, 29.80, 0.05), 12)   # ~4.8 x 5.6 km = ~27 km²


def test_no_boundary_needs_recorded_locale():
    assert resolve_area("brevard_cocoa", None, 12).kind == "recorded"
    with pytest.raises(AreaError):
        resolve_area("area-nope", None, 12)
