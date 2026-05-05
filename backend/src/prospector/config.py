from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    anthropic_api_key: str = Field(default="")

    database_url: str = "postgresql://prospector:prospector@localhost:5432/prospector"
    pgvector_dim: int = 1536

    langsmith_api_key: str = ""
    langsmith_project: str = "prospectors-compass"
    langsmith_tracing: bool = True

    resend_api_key: str = ""
    auth_signing_secret: str = ""

    tileserver_url: str = "http://localhost:8080"
    mbtiles_dir: str = "./tiles"

    anthropic_budget_soft_usd: float = 5.0
    anthropic_budget_hard_usd: float = 8.0

    llm_mock_mode: bool = False


settings = Settings()
