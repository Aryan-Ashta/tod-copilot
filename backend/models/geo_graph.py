"""Walk-graph helpers (pure: take loaded data, return plain data)."""
import networkx as nx
import numpy as np
from scipy.spatial import cKDTree

from backend.data.geo import lonlat_to_utm


def build_walk_graph(compact: dict, epsg: int) -> nx.Graph:
    """compact = {"nodes": [[id, lon, lat]], "edges": [[u, v, length_m, highway, sidewalk]]}."""
    G = nx.Graph()
    for nid, lon, lat in compact["nodes"]:
        x, y = lonlat_to_utm(lon, lat, epsg)
        G.add_node(nid, lon=lon, lat=lat, x=x, y=y)
    for u, v, length, hw, sw in compact["edges"]:
        if u in G and v in G:
            G.add_edge(u, v, length=float(length), highway=hw, sidewalk=sw)
    return G


class NodeIndex:
    """KD-tree over node UTM coordinates."""

    def __init__(self, G: nx.Graph):
        self.ids = np.array(list(G.nodes))
        self.xy = np.array([(G.nodes[n]["x"], G.nodes[n]["y"]) for n in self.ids])
        self.tree = cKDTree(self.xy)

    def nearest(self, xy: list[tuple[float, float]]) -> tuple[list, list[float]]:
        if not len(xy):
            return [], []
        d, i = self.tree.query(np.asarray(xy))
        return [self.ids[j].item() for j in np.atleast_1d(i)], [float(v) for v in np.atleast_1d(d)]

    def nearest_k(self, xy: list[tuple[float, float]], k: int) -> tuple[list[list], list[list[float]]]:
        """The k nearest nodes per point (a single nearest node can be a dead-end driveway or plaza path)."""
        if not len(xy):
            return [], []
        k = min(k, len(self.ids))
        d, i = self.tree.query(np.asarray(xy), k=k)
        d, i = np.atleast_2d(d), np.atleast_2d(i)
        if k == 1:
            d, i = d.T, i.T
        return [[self.ids[j].item() for j in row] for row in i], [[float(v) for v in row] for row in d]


def nearest_nodes(G: nx.Graph, points_xy: list[tuple[float, float]], index: NodeIndex | None = None):
    return (index or NodeIndex(G)).nearest(points_xy)


def dist_from_sources(G: nx.Graph, source_nodes) -> dict:
    """Walk metres from the nearest of the given source nodes to every reachable node."""
    src = set(source_nodes)
    if not src:
        return {}
    return nx.multi_source_dijkstra_path_length(G, src, weight="length")
