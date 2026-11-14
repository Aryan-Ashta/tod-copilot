import pytest
from shapely.geometry import box, mapping

from backend.data.areas import AreaError, resolve_area
from backend.onboard import geo

HOUSTON_SUB = {"type": "Polygon", "coordinates": [[[-95.368, 29.755], [-95.362, 29.755], [-95.362, 29.760],
                                                   [-95.368, 29.760], [-95.368, 29.755]]]}
DENVER_BOX = (-105.11, 39.61, -104.60, 39.91)
SANTA_MONICA_BOX = (-118.52, 33.99, -118.44, 34.05)


def _square(lon, lat, d):
    return {"type": "Polygon", "coordinates": [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d],
                                                [lon, lat]]]}


@pytest.fixture(autouse=True)
def fake_tiger(monkeypatch):
    """TIGERweb stand-ins: Denver County (08031) and the cities of Denver and Santa Monica, as boxes."""
    def county_at(lon, lat):
        if box(*DENVER_BOX).contains(box(lon, lat, lon, lat).centroid):
            return {"type": "Feature", "properties": {"GEOID": "08031", "NAME": "Denver County", "STATE": "08"},
                    "geometry": mapping(box(*DENVER_BOX))}
        return None

    def places(bbox):
        out = []
        for geoid, name, st, b in (("0820000", "Denver", "08", DENVER_BOX),
                                   ("0670000", "Santa Monica", "06", SANTA_MONICA_BOX)):
            if box(*b).intersects(box(*bbox)):
                out.append({"type": "Feature", "properties": {"GEOID": geoid, "NAME": f"{name} city",
                                                              "BASENAME": name, "STATE": st},
                            "geometry": mapping(box(*b))})
        return out
    monkeypatch.setattr(geo, "_tiger_county_at", county_at)
    monkeypatch.setattr(geo, "_tiger_places", places)


def test_subarea_inside_houston():
    a = resolve_area(None, HOUSTON_SUB, 12)
    assert (a.kind, a.locale_id) == ("subarea", "houston_downtown")


def test_galleria_is_city_of_houston_metro_area():
    a = resolve_area(None, _square(-95.468, 29.735, 0.012), 12)
    assert (a.kind, a.sources_from, a.jurisdiction) == ("metro", "houston_downtown", "houston")


def test_box_crossing_a_recorded_edge_records_as_metro_area():
    a = resolve_area(None, _square(-95.39, 29.750, 0.02), 12)
    assert (a.kind, a.jurisdiction) == ("metro", "houston")


def test_santa_monica_gets_its_own_city_jurisdiction():
    a = resolve_area(None, _square(-118.495, 34.010, 0.012), 12)
    assert (a.kind, a.sources_from, a.jurisdiction) == ("metro", "la_wilshire_koreatown", "ca_santa_monica")


def test_any_us_county_is_a_metro_area():
    a = resolve_area(None, _square(-105.0, 39.75, 0.01), 12)
    assert (a.kind, a.county_fips, a.jurisdiction, a.sources_from) == ("metro", "08031", "co_denver", None)


def test_brevard_outside_the_recorded_box_reuses_its_sources():
    a = resolve_area(None, _square(-80.70, 28.30, 0.01), 12)
    assert (a.kind, a.county_fips, a.sources_from) == ("metro", "12009", "brevard_cocoa")
    assert a.jurisdiction == "fl_brevard_county"


def test_box_straddling_two_counties_rejected():
    with pytest.raises(AreaError, match="draw the boundary inside one US county"):
        resolve_area(None, _square(-105.12, 39.75, 0.03), 12)   # centre in Denver County, west edge 1 km past it


def test_too_large_rejected():
    with pytest.raises(AreaError, match="draw at most 12"):
        resolve_area(None, _square(-95.45, 29.80, 0.05), 12)   # ~4.8 x 5.6 km = ~27 km²


def test_no_boundary_needs_recorded_locale():
    assert resolve_area("brevard_cocoa", None, 12).kind == "recorded"
    with pytest.raises(AreaError):
        resolve_area("area-nope", None, 12)
