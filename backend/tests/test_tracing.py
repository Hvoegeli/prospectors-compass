import os
from types import SimpleNamespace

import pytest

from prospector.llm import tracing


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("LANGSMITH_TRACING", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT"):
        monkeypatch.delenv(key, raising=False)


def _stub_settings(*, tracing_on: bool, api_key: str) -> SimpleNamespace:
    return SimpleNamespace(
        langsmith_tracing=tracing_on,
        langsmith_api_key=api_key,
        langsmith_project="test-project",
    )


def test_init_tracing_returns_false_when_flag_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tracing, "settings", _stub_settings(tracing_on=False, api_key="abc"))
    assert tracing.init_tracing() is False
    assert "LANGSMITH_API_KEY" not in os.environ


def test_init_tracing_returns_false_when_no_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tracing, "settings", _stub_settings(tracing_on=True, api_key=""))
    assert tracing.init_tracing() is False
    assert "LANGSMITH_API_KEY" not in os.environ


def test_init_tracing_sets_env_vars_when_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tracing, "settings", _stub_settings(tracing_on=True, api_key="ls_test"))
    assert tracing.init_tracing() is True
    assert os.environ["LANGSMITH_TRACING"] == "true"
    assert os.environ["LANGSMITH_API_KEY"] == "ls_test"
    assert os.environ["LANGSMITH_PROJECT"] == "test-project"
