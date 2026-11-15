"""Hosted demo mode: /api/config reports it and POST /api/plan refuses live runs server-side."""
from fastapi.testclient import TestClient

from backend import settings
from backend.app import app

client = TestClient(app)
PLAN = {"locale_id": "la_wilshire_koreatown", "prompt": "Plan transit and homes", "options": None}


def test_hosted_refuses_live_runs(monkeypatch):
    monkeypatch.setattr(settings, "HOSTED", True)
    cfg = client.get("/api/config").json()
    assert cfg == {"hosted": True, "repo_url": "https://github.com/Aryan-Ashta/tod-copilot"}
    r = client.post("/api/plan", json=PLAN)
    assert r.status_code == 403
    assert "recorded demo" in r.json()["detail"]


def test_not_hosted_config(monkeypatch):
    monkeypatch.setattr(settings, "HOSTED", False)
    assert client.get("/api/config").json()["hosted"] is False
