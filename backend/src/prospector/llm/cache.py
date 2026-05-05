from typing import Any


def cached_system(text: str) -> list[dict[str, Any]]:
    return [
        {
            "type": "text",
            "text": text,
            "cache_control": {"type": "ephemeral"},
        }
    ]


def cached_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not tools:
        return tools
    out = [dict(t) for t in tools]
    out[-1] = {**out[-1], "cache_control": {"type": "ephemeral"}}
    return out
