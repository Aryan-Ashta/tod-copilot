# Transitor: one image with the FastAPI backend and the built frontend, served from one origin on port 8000.
#
# Hosted on Coolify (app "transitor", build pack Dockerfile, port 8000, health check /health); env vars are a subset of
# Doppler prd (names in .env.example). Data comes from volumes, never from this image (.dockerignore):
#   /app/cache                                     recorded cache (plans, http, areas, osm), written at runtime too
#   /app/backend/fixtures/<locale>/{costar,matterport,vexcel}   licensed per-locale slices; the raw CoStar extract
#                                                  (cache/costar) is recording-time only and is not hosted
# On the VPS these are docker volumes bind-backed to /data/transitor/...; `transitor-costar-off` there removes CoStar.

# ---- frontend build
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- backend
FROM python:3.11-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
# Coolify's health check (GET /health, set on the app) runs curl or wget inside the container; slim images have neither.
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/app/.venv PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/ backend/
COPY scripts/ scripts/
COPY --from=web /web/dist frontend/dist
RUN mkdir -p cache
ENV PATH="/app/.venv/bin:$PATH" FRONTEND_DIST=/app/frontend/dist
EXPOSE 8000
CMD ["uvicorn", "backend.serve:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
