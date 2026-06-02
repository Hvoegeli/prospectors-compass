"""SQLAlchemy engine, session factory, and declarative base.

The connection string comes from settings (``DATABASE_URL``). We force the
psycopg (v3) driver because a bare ``postgresql://`` URL makes SQLAlchemy reach
for psycopg2, which isn't installed — only psycopg 3 is.
"""

from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from prospector.config import settings


def _sqlalchemy_url(url: str) -> str:
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


engine = create_engine(_sqlalchemy_url(settings.database_url), future=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, future=True)


class Base(DeclarativeBase):
    """Base class for all ORM models."""
