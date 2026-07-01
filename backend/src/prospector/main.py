from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from prospector.api import engine, land_status, layers, trips
from prospector.api.trips import FIND_PHOTOS_DIR
from prospector.config import settings
from prospector.db.base import engine as db_engine
from prospector.db.models import Trip
from prospector.llm.tracing import init_tracing

init_tracing()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure the user-data 'trips' table exists (it has no ingest to create it).
    Trip.__table__.create(bind=db_engine, checkfirst=True)
    # Add the 'target' column to trips created before it existed. Idempotent, so
    # it's safe on every boot (create() above won't alter an existing table).
    with db_engine.begin() as conn:
        conn.execute(text("ALTER TABLE trips ADD COLUMN IF NOT EXISTS target VARCHAR"))
    yield


app = FastAPI(title="Prospector's Compass", lifespan=lifespan)

# Allow the local Vite dev server (desktop frontend) to call the API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
    # The bundle download reads the server-chosen filename from this header. CORS
    # hides response headers from JS by default, so it must be explicitly exposed
    # (the frontend runs on a different port → cross-origin).
    expose_headers=["Content-Disposition"],
)

app.include_router(layers.router)
app.include_router(engine.router)
app.include_router(trips.router)
app.include_router(land_status.router)

# Serve imported field-find photos read-only (written by POST /trips/import-finds).
# The directory must exist before StaticFiles mounts it.
FIND_PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/find-photos", StaticFiles(directory=str(FIND_PHOTOS_DIR)), name="find-photos")


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "llm_mock_mode": str(settings.llm_mock_mode),
        "langsmith_project": settings.langsmith_project,
    }
