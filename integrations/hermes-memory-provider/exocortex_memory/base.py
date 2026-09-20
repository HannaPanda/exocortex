"""Where the Hermes base class comes from, and what stands in for it.

Hermes resolves a provider by checking `isinstance(x, MemoryProvider)` against
its own abstract base (`plugins/memory/__init__.py`, `_load_provider_from_entry_point`).
So this package has to subclass the real class when it is importable, or Hermes
loads the entry point, finds nothing it recognises and logs a debug line nobody
reads.

Hermes is not a dependency of this package, though, and must not become one: the
tests run where it is absent, and `pip install` into an unrelated environment
should not drag an agent framework in. Hence the shim below, which exists only
so the module imports. It is never what Hermes loads.
"""

from __future__ import annotations

from typing import Any, Dict, List

try:  # pragma: no cover - depends on where this is imported
    from agent.memory_provider import MemoryProvider as HermesMemoryProvider

    HERMES_AVAILABLE = True
except Exception:  # pragma: no cover - the path the tests take
    HERMES_AVAILABLE = False

    class HermesMemoryProvider:  # type: ignore[no-redef]
        """The parts of Hermes' contract this provider overrides.

        Deliberately not an ABC: a stand-in that refused to instantiate would
        turn a missing framework into an import error, and the point of the
        stand-in is that the module still imports.
        """

        pre_compress_checkpoint_api_version = 1

        @property
        def name(self) -> str:
            raise NotImplementedError

        def is_available(self) -> bool:
            return False

        def unavailable_reason(self) -> str:
            return ""

        def initialize(self, session_id: str, **kwargs: Any) -> None:
            """Called once at agent startup."""

        def system_prompt_block(self) -> str:
            return ""

        def prefetch(self, query: str, *, session_id: str = "") -> str:
            return ""

        def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
            """Queue a background recall; `prefetch` consumes it next turn."""

        def sync_turn(self, user_content: str, assistant_content: str, **kwargs: Any) -> None:
            """Persist a completed turn."""

        def get_tool_schemas(self) -> List[Dict[str, Any]]:
            return []

        def get_config_schema(self) -> List[Dict[str, Any]]:
            return []

        def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
            """Write non-secret setup values to the provider's own config."""

        def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
            """End-of-session extraction."""

        def on_session_switch(self, new_session_id: str, **kwargs: Any) -> None:
            """The session id was reassigned mid-process."""

        def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
            return ""

        def shutdown(self) -> None:
            """Flush queues, close connections."""


def spawn_background(target: Any, *, name: str) -> Any:
    """A thread carrying the caller's contextvars, the way Hermes requires.

    Every background job of a memory provider has to go through Hermes'
    `spawn_context_thread`, because a worker started with an empty context
    silently lands on the default profile or fails closed on secrets. Falls back
    to a plain daemon thread only where Hermes is absent, which is only the
    tests.
    """
    try:  # pragma: no cover - depends on where this is imported
        from agent.memory_provider import spawn_context_thread

        return spawn_context_thread(target, name=name)
    except Exception:
        import threading

        return threading.Thread(target=target, name=name, daemon=True)
