# Prospector's Compass — FastAPI backend image.
#
# Base on the OSGeo GDAL image purely for the `gdallocationinfo` CLI binary, which
# the placer scoring path shells out to (see prospector.ingest.terrain.sample_raster).
# The Python geo stack (geopandas/shapely/pyproj/pyogrio) comes from PyPI wheels that
# bundle their own GDAL/GEOS/PROJ, installed into an isolated uv-managed venv — so we
# do NOT depend on the base image's Python or its GDAL Python bindings.
#
# Build context is the REPO ROOT (see docker-compose.yml: build.context = .), so paths
# below are repo-relative (backend/...).
FROM ghcr.io/osgeo/gdal:ubuntu-small-latest

# uv: fast, lockfile-faithful installs; provisions its own Python 3.12 if the base lacks it.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    UV_COMPILE_BYTECODE=1 \
    PATH=/app/.venv/bin:$PATH

# 1) Dependencies only (cached layer) — needs the manifest + lock, not the source yet.
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# 2) Project source, then install the project itself (editable) so `import prospector`
#    resolves to /app/src/prospector — which makes BACKEND_ROOT (parents[3]) == /app,
#    i.e. SLOPE_TIF == /app/data/processed/slope.tif and find-photos == /app/data/find-photos.
COPY backend/src ./src
RUN uv sync --frozen --no-dev

EXPOSE 8000

# 0.0.0.0 so the published port is reachable from the host (the frontend hits localhost:8000).
CMD ["uvicorn", "prospector.main:app", "--host", "0.0.0.0", "--port", "8000"]
