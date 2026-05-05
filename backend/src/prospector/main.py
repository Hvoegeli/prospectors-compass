from fastapi import FastAPI

from prospector.config import settings
from prospector.llm.tracing import init_tracing

init_tracing()

app = FastAPI(title="Prospector's Compass")


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "llm_mock_mode": str(settings.llm_mock_mode),
        "langsmith_project": settings.langsmith_project,
    }
