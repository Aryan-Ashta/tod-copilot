import pytest

from backend import settings
from backend.data import http_cache


def test_offline_miss_raises_and_hit_returns(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(settings, "OFFLINE", True)
    url, params = "https://example.invalid/x", {"a": 1}
    with pytest.raises(http_cache.OfflineCacheMiss):
        http_cache.cached_get(url, params)
    d = tmp_path / "http"
    d.mkdir()
    (d / f"{http_cache.cache_key(url, params)}.json").write_text('{"ok": true}')
    assert http_cache.cached_get(url, params) == {"ok": True}
