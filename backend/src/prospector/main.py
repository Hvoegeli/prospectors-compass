from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from prospector.api import engine, layers, trips
from prospector.config import settings
from prospector.db.base import engine as db_engine
from prospector.db.models import Trip
from prospector.llm.tracing import init_tracing

init_tracing()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure the user-data 'trips' table exists (it has no ingest to create it).
    Trip.__table__.create(bind=db_engine, checkfirst=True)
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
)

app.include_router(layers.router)
app.include_router(engine.router)
app.include_router(trips.router)


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "llm_mock_mode": str(settings.llm_mock_mode),
        "langsmith_project": settings.langsmith_project,
    }
