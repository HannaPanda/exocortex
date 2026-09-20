"""The Hermes memory provider itself.

One method carries the weight: `on_pre_compress`. Hermes calls it just before it
summarises the old part of a conversation and throws the wording away, and with
`compression.checkpoint_required: true` it will only go ahead if this returns.
So this raises on every failure and returns only once eXocortex has confirmed a
durable write.

Everything else here is deliberately small. `prefetch` is off unless somebody
turns it on, and even then it is capped in characters, because a provider that
pastes a profile into every turn is the opposite of what a compaction budget is
for.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Sequence

from .client import CheckpointError, CheckpointResult, ExocortexClient
from .config import ProviderConfig

#: How many messages one checkpoint may carry. The API refuses more.
MAX_MESSAGES = 2_000
#: How many characters of evidence one checkpoint may carry. The API refuses more.
MAX_EVIDENCE_CHARS = 400_000


class ExocortexMemoryProvider:
    """eXocortex as Hermes' long-term memory.

    Kept free of a Hermes base class on purpose: the plugin API is duck-typed,
    and inheriting from it would make this package refuse to import wherever
    Hermes is not installed, including in its own tests.
    """

    #: Hermes reads this to decide whether the provider may gate a compaction.
    pre_compress_checkpoint_api_version = 2

    name = "exocortex"

    def __init__(
        self,
        config: ProviderConfig | None = None,
        *,
        options: Mapping[str, Any] | None = None,
        client: ExocortexClient | None = None,
    ) -> None:
        self.config = config or ProviderConfig.from_mapping(options)
        self._client = client
        self._session_id: str | None = None

    # -- lifecycle ---------------------------------------------------------

    def on_session_start(self, session_id: str | None = None, **_: Any) -> None:
        """Remembers which conversation this is, so checkpoints can be grouped."""
        if session_id:
            self._session_id = str(session_id)

    def on_pre_compress(
        self,
        messages: Sequence[Mapping[str, Any]],
        *,
        require_checkpoint: bool = False,
        session_id: str | None = None,
        **_: Any,
    ) -> str | None:
        """Persists the evidence about to be compacted away.

        Returns a short line Hermes may keep in the compacted history, so the
        conversation itself says where the detail went. Raises when nothing was
        written and `require_checkpoint` is set, which is how the compaction is
        stopped.
        """
        session = str(session_id or self._session_id or "")
        if not session:
            return self._refuse(
                "eXocortex needs a session id to group checkpoints by", require_checkpoint
            )

        payload = list(normalize_messages(messages))
        if not payload:
            # Nothing to lose, nothing to write. Not a failure: refusing a
            # compaction of an empty window would stall the agent forever.
            return None

        body = {
            "project": self.config.project,
            "client": self.config.client,
            "sessionId": session,
            "messages": payload,
        }

        try:
            result = self.client.checkpoint(body)
        except CheckpointError as error:
            return self._refuse(str(error), require_checkpoint)

        self._session_id = session
        return describe(result)

    def on_session_end(self, messages: Sequence[Mapping[str, Any]], **kwargs: Any) -> None:
        """One last checkpoint, and never a reason to fail.

        The session is over: nothing is waiting on the answer and there is no
        compaction left to stop, so a failure here is a note that was not
        written rather than an incident.
        """
        try:
            self.on_pre_compress(messages, require_checkpoint=False, **kwargs)
        except Exception:  # pragma: no cover - `on_pre_compress` already swallows
            return

    def prefetch(self, query: str | None = None, **_: Any) -> str | None:
        """A few distilled lines from the memory, inside a fixed budget.

        Off unless configured. A provider that injects a profile before every
        model call spends the context budget that compaction just freed.
        """
        if not self.config.prefetch_enabled:
            return None
        try:
            text = self.client.recall(
                query,
                self.config.project,
                max_chars=self.config.recall_max_chars,
                limit=self.config.recall_limit,
            )
        except CheckpointError:
            # A recall that failed is a turn without extra context, never a
            # turn that does not happen.
            return None
        return text or None

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

    def _refuse(self, reason: str, require_checkpoint: bool) -> None:
        if require_checkpoint:
            raise CheckpointError(f"eXocortex checkpoint failed: {reason}")
        return None


def normalize_messages(messages: Iterable[Mapping[str, Any]]) -> Iterable[dict[str, str]]:
    """Hermes' messages as the endpoint wants them: a role and flat text.

    Tolerant about the content shape, because a message's content is a string in
    some turns and a list of blocks in others, and a provider that only
    understood one of them would silently checkpoint half a conversation.
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
        # The API counts the whole payload, so the cut has to happen here or the
        # request comes back as a validation error at the worst possible moment.
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
    """The line Hermes may keep in place of what it dropped."""
    if result.deduplicated:
        return f"eXocortex checkpoint: {result.checkpoint_id} (bereits gesichert)"
    if result.document_id is None:
        return (
            f"eXocortex checkpoint: {result.checkpoint_id} "
            "(nichts Erhaltenswertes in diesem Abschnitt)"
        )
    where = result.url or result.document_id
    return f"eXocortex checkpoint: {result.checkpoint_id} · {result.title or 'Notiz'} · {where}"
