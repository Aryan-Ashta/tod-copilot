"""Production entry point: the API plus the built frontend from one origin (the hosted image runs this).

`uvicorn backend.serve:app` serves every `/api` route from backend.app and the Vite build (FRONTEND_DIST, default
frontend/dist) for everything else. Client-side routes (/plan/…, /meeting/…) get index.html so a reload works.
Local development keeps `uvicorn backend.app:app` with the Vite dev server.

This entry point is the hosted demo: TRANSITOR_HOSTED defaults to 1 here (before backend.settings is imported), so
POST /api/plan refuses live runs and only recorded replays play. Set TRANSITOR_HOSTED=0 to allow live runs.
"""
import os

os.environ.setdefault("TRANSITOR_HOSTED", "1")

from pathlib import Path  # noqa: E402

from starlette.exceptions import HTTPException  # noqa: E402
from starlette.staticfiles import StaticFiles  # noqa: E402

from backend.app import app  # noqa: E402
from backend.settings import ROOT  # noqa: E402

DIST = Path(os.getenv("FRONTEND_DIST") or ROOT / "frontend" / "dist")


class SpaFiles(StaticFiles):
    """Static files that answer unknown non-API paths with index.html (React Router handles them)."""

    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except HTTPException as e:
            if e.status_code != 404 or path.startswith("api/") or path == "api":
                raise
            return await super().get_response("index.html", scope)


if not (DIST / "index.html").is_file():
    raise RuntimeError(f"frontend build missing: {DIST}/index.html (run `npm run build` in frontend/)")
app.mount("/", SpaFiles(directory=DIST, html=True), name="frontend")
