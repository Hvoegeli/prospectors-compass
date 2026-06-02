from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from prospector.api import layers
from prospector.config import settings
from prospector.llm.tracing import init_tracing

init_tracing()

app = FastAPI(title="Prospector's Compass")

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


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "llm_mock_mode": str(settings.llm_mock_mode),
        "langsmith_project": settings.langsmith_project,
    }
