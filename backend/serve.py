"""Production entry point: the API plus the built frontend from one origin (the hosted image runs this).

`uvicorn backend.serve:app` serves every `/api` route from backend.app and the Vite build (FRONTEND_DIST, default
frontend/dist) for everything else. Client-side routes (/plan/…, /meeting/…) get index.html so a reload works.
Local development keeps `uvicorn backend.app:app` with the Vite dev server.
"""
import os
from pathlib import Path

from starlette.exceptions import HTTPException
from starlette.staticfiles import StaticFiles

from backend.app import app
from backend.settings import ROOT

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
