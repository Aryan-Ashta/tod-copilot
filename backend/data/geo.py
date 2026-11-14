"""WGS84 GeoJSON in, metric math in the locale's UTM zone."""
from functools import lru_cache

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry

SQFT_PER_M2 = 10.7639
M2_PER_ACRE = 4046.8564224


@lru_cache(maxsize=8)
def _tf(epsg: int) -> Transformer:
    return Transformer.from_crs(4326, epsg, always_xy=True)


def to_utm(geom: dict | BaseGeometry, epsg: int) -> BaseGeometry:
    g = shape(geom) if isinstance(geom, dict) else geom
    tf = _tf(epsg)
    return shapely.transform(g, lambda xy: np.column_stack(tf.transform(xy[:, 0], xy[:, 1])))


def lonlat_to_utm(lon: float, lat: float, epsg: int) -> tuple[float, float]:
    return _tf(epsg).transform(lon, lat)


def area_acres(geom: dict | BaseGeometry, epsg: int) -> float:
    return to_utm(geom, epsg).area / M2_PER_ACRE


def area_sqft(geom: dict | BaseGeometry, epsg: int) -> float:
    return to_utm(geom, epsg).area * SQFT_PER_M2


def distance_m(a: dict | BaseGeometry, b: dict | BaseGeometry, epsg: int) -> float:
    return to_utm(a, epsg).distance(to_utm(b, epsg))
