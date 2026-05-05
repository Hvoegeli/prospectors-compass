from prospector.llm.cache import cached_system, cached_tools


def test_cached_system_marks_block_with_ephemeral_cache() -> None:
    blocks = cached_system("You are a geology subagent.")
    assert blocks == [
        {
            "type": "text",
            "text": "You are a geology subagent.",
            "cache_control": {"type": "ephemeral"},
        }
    ]


def test_cached_tools_marks_only_last_tool() -> None:
    tools = [
        {"name": "geo_query", "description": "..."},
        {"name": "mrds_query", "description": "..."},
    ]
    cached = cached_tools(tools)
    assert "cache_control" not in cached[0]
    assert cached[1]["cache_control"] == {"type": "ephemeral"}


def test_cached_tools_handles_empty() -> None:
    assert cached_tools([]) == []


def test_cached_tools_does_not_mutate_input() -> None:
    tools = [{"name": "geo_query"}]
    cached_tools(tools)
    assert "cache_control" not in tools[0]
