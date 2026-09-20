"""The Hermes memory provider itself.

One method carries the weight: `on_pre_compress`. Hermes calls it just before it
summarises the old part of a conversation and throws the wording away, and with
`compression.checkpoint_required: true` its `MemoryManager` re-raises whatever
this method raises, which is what keeps the uncompressed transcript. So it
raises on every failure and returns only once eXocortex has confirmed a durable
write.

Everything else is deliberately small. This provider adds no tools, because the
`exo_*` catalogue already reaches everything through MCP and a second, smaller
copy of it inside the memory lifecycle would be two answers to one question.
Prefetch is off unless somebody turns it on.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, Iterable, List, Mapping, Sequence

from .base import HermesMemoryProvider, spawn_background
from .client import CheckpointError, CheckpointResult, ExocortexClient
from .config import ProviderConfig, config_schema

logger = logging.getLogger(__name__)

#: How many messages one checkpoint may carry. The API refuses more.
MAX_MESSAGES = 2_000
#: How many characters of evidence one checkpoint may carry. The API refuses more.
MAX_EVIDENCE_CHARS = 400_000


class ExocortexMemoryProvider(HermesMemoryProvider):
    """eXocortex as Hermes' long-term memory."""

    #: Hermes reads this to decide whether this provider may gate a compaction.
    #: 2 means "fail-closed checkpoint", 1 would mean "best effort, ignored".
    pre_compress_checkpoint_api_version = 2

    def __init__(
        self,
        config: ProviderConfig | None = None,
        *,
        options: Mapping[str, Any] | None = None,
        client: ExocortexClient | None = None,
    ) -> None:
        self.config = config or ProviderConfig.from_mapping(options)
        self._client = client
        # A session id Hermes has not handed over yet. Replaced in `initialize`.
        self._session_id = f"exocortex-{uuid.uuid4().hex[:16]}"
        self._agent_context = "primary"
        self._recalled = ""

    # -- what Hermes requires ---------------------------------------------

    @property
    def name(self) -> str:
        return "exocortex"

    def is_available(self) -> bool:
        """Configuration only, no network.

        Hermes calls this before activating the provider and again from the
        dashboard, so a request here would put a round trip in front of every
        listing. Whether the deployment actually answers is the checkpoint's
        problem, and it has a loud way of saying so.
        """
        return bool(self.config.token and self.config.base_url)

    def unavailable_reason(self) -> str:
        if not self.config.base_url:
            return "No eXocortex address configured (memory.exocortex.base_url)."
        if not self.config.token:
            return "No eXocortex API token in the environment (EXOCORTEX_API_TOKEN)."
        return ""

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        """Binds the conversation this provider is checkpointing.

        The session id is what groups checkpoints, and it is the reason a second
        compaction of the same conversation costs only its new turns. Hermes
        always passes one; the constructor's fallback covers the path where a
        provider is built by hand.
        """
        if session_id:
            self._session_id = str(session_id)
        self._agent_context = str(kwargs.get("agent_context") or "primary")

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        """None. The `exo_*` MCP catalogue is how a model reaches eXocortex."""
        return []

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return config_schema()

    def shutdown(self) -> None:
        """Nothing to flush: every checkpoint was already durable when it returned."""

    # -- the lifecycle that matters ---------------------------------------

    def on_pre_compress(
        self,
        messages: Sequence[Mapping[str, Any]],
        *,
        require_checkpoint: bool = False,
    ) -> str:
        """Persists the evidence about to be compacted away.

        Returns a short line Hermes folds into the summary prompt, so the
        compacted history itself says where the detail went. Raises when nothing
        was written and `require_checkpoint` is set, which is how the compaction
        is stopped.
        """
        payload = list(normalize_messages(messages))
        if not payload:
            # Nothing to lose, nothing to write. Not a failure: refusing to
            # compact an empty window would stall the agent forever.
            return ""

        body = {
            "project": self.config.project,
            "client": self.config.client,
            "sessionId": self._session_id,
            "messages": payload,
            # Provenance, not instruction. A cron run and a chat are the same
            # conversation shape and a very different thing to read later.
            "hint": f"Hermes pre-compress checkpoint ({self._agent_context})",
        }

        try:
            result = self.client.checkpoint(body)
        except CheckpointError as error:
            logger.warning("eXocortex checkpoint failed: %s", error)
            if require_checkpoint:
                raise
            return ""

        return describe(result)

    def on_session_switch(self, new_session_id: str, **kwargs: Any) -> None:
        """Rebinds when `/resume`, `/branch` or a compaction reassigns the id."""
        if new_session_id:
            self._session_id = str(new_session_id)
        if kwargs.get("reset"):
            self._recalled = ""

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """One last checkpoint, and never a reason to fail.

        The session is over: nothing waits on the answer and there is no
        compaction left to stop, so a failure is a note that was not written
        rather than an incident.
        """
        try:
            self.on_pre_compress(messages, require_checkpoint=False)
        except Exception:  # pragma: no cover - on_pre_compress already swallows
            logger.debug("eXocortex end-of-session checkpoint failed", exc_info=True)

    # -- recall, off by default -------------------------------------------

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Whatever the last background recall found, and never a request.

        Hermes requires this to be fast because it sits in front of a turn. So
        it hands back what `queue_prefetch` already fetched and clears it: a
        recall shown twice would look like two memories.
        """
        if not self.config.prefetch_enabled:
            return ""
        recalled, self._recalled = self._recalled, ""
        return recalled

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Starts the recall whose result the next `prefetch` returns."""
        if not self.config.prefetch_enabled or not query.strip():
            return
        spawn_background(lambda: self._recall_into_cache(query), name="exocortex-recall").start()

    def _recall_into_cache(self, query: str) -> None:
        try:
            self._recalled = self.client.recall(
                query,
                self.config.project,
                max_chars=self.config.recall_max_chars,
                limit=self.config.recall_limit,
                timeout_seconds=self.config.recall_timeout_seconds,
            )
        except CheckpointError as error:
            # A recall that failed is a turn without extra context, never a turn
            # that does not happen.
            logger.debug("eXocortex recall failed: %s", error)
            self._recalled = ""

    # -- internals ---------------------------------------------------------

    @property
    def client(self) -> ExocortexClient:
        if self._client is None:
            self._client = ExocortexClient(
                self.config.base_url,
                self.config.token,
                timeout_seconds=self.config.timeout_seconds,
            )
        return self._client

    @property
    def session_id(self) -> str:
        """Which conversation this provider is currently checkpointing."""
        return self._session_id


def normalize_messages(messages: Iterable[Mapping[str, Any]]) -> Iterable[Dict[str, str]]:
    """Hermes' messages as the endpoint wants them: a role and flat text.

    Tolerant about the content shape, because a message's content is a string in
    some turns and a list of blocks in others, and a provider that understood
    only one of them would silently checkpoint half a conversation.
    """
    used = 0
    count = 0
    for message in messages:
        if count >= MAX_MESSAGES or used >= MAX_EVIDENCE_CHARS:
            return
        role = str(message.get("role") or "unknown")[:40]
        text = flatten_content(message.get("content"))
        if not text:
            continue
        # Cut here rather than at the API, or a long conversation comes back as
        # a validation error at the one moment the caller cannot retry.
        remaining = MAX_EVIDENCE_CHARS - used
        if len(text) > remaining:
            text = text[:remaining]
        used += len(text)
        count += 1
        yield {"role": role, "text": text}


def flatten_content(content: Any) -> str:
    """Whatever the message held, as one block of text."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, Mapping):
        for key in ("text", "content", "value"):
            value = content.get(key)
            if isinstance(value, str):
                return value.strip()
        return ""
    if isinstance(content, (list, tuple)):
        parts = [flatten_content(part) for part in content]
        return "\n".join(part for part in parts if part)
    return str(content).strip()


def describe(result: CheckpointResult) -> str:
    """The line Hermes folds into the summary prompt in place of what it dropped."""
    if result.deduplicated:
        return f"eXocortex checkpoint: {result.checkpoint_id} (bereits gesichert)"
    if result.document_id is None:
        return (
            f"eXocortex checkpoint: {result.checkpoint_id} "
            "(nichts Erhaltenswertes in diesem Abschnitt)"
        )
    where = result.url or result.document_id
    return f"eXocortex checkpoint: {result.checkpoint_id} · {result.title or 'Notiz'} · {where}"


__all__ = [
    "ExocortexMemoryProvider",
    "MAX_EVIDENCE_CHARS",
    "MAX_MESSAGES",
    "describe",
    "flatten_content",
    "normalize_messages",
]
