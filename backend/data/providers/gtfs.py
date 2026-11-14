"""GtfsProvider: existing routes and stops (recorded from the agency's GTFS)."""
from backend.data.providers._base import features, first_url, fx, prov, retrieved
from backend.data.resolver import Capability
from backend.schemas import Locale, Sourced


class GtfsProvider:
    name = "gtfs"

    def covers(self, locale: Locale, cap: Capability) -> bool:
        return cap == Capability.TRANSIT_EXISTING and fx(locale.id, "gtfs", "routes.geojson").exists()

    def fetch(self, locale: Locale, cap: Capability, **kw) -> Sourced:
        p = prov(self.name, "high", retrieved(locale.id, "gtfs"), first_url(locale.id, "gtfs"),
                 f"{locale.transit_agency} GTFS; peak headway = 120 / weekday 07-09 trips at busiest stop")
        return Sourced(value={"routes": features(fx(locale.id, "gtfs", "routes.geojson")),
                              "stops": features(fx(locale.id, "gtfs", "stops.geojson"))}, prov=p)
