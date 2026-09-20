"""What the provider promises Hermes.

Three things are worth a test and the rest is plumbing: that a checkpoint
reaches the endpoint in the shape the endpoint accepts, that a failure with
`require_checkpoint` raises rather than returning quietly, and that the
message flattening survives the several shapes a Hermes message has.
"""

from __future__ import annotations

import json

import pytest

from exocortex_memory import CheckpointError, ExocortexMemoryProvider, ProviderConfig
from exocortex_memory.provider import MAX_EVIDENCE_CHARS, flatten_content, normalize_messages


class FakeClient:
    """Records the calls and answers whatever it was told to."""

    def __init__(self, answer=None, error: Exception | None = None) -> None:
        self.calls: list[dict] = []
        self._answer = answer
        self._error = error

    def checkpoint(self, body):
        self.calls.append(dict(body))
        if self._error is not None:
            raise self._error
        return self._answer

    def recall(self, query, project, *, max_chars, limit, timeout_seconds=None):
        self.calls.append(
            {"recall": query, "project": project, "maxChars": max_chars, "limit": limit}
        )
        if self._error is not None:
            raise self._error
        return self._answer


def make_provider(client, *, session="session-7", **options) -> ExocortexMemoryProvider:
    config = ProviderConfig.from_mapping(
        {"project": "hermes", **options}, environ={"EXOCORTEX_API_TOKEN": "t"}
    )
    provider = ExocortexMemoryProvider(config, client=client)
    if session is not None:
        provider.initialize(session)
    return provider


def result(**overrides):
    from exocortex_memory import CheckpointResult

    defaults = dict(
        checkpoint_id="cp-1",
        digest="abc",
        deduplicated=False,
        new_messages=2,
        document_id="doc-1",
        title="Entscheidung zum Provider",
        url="https://exocortex.app/x",
    )
    defaults.update(overrides)
    return CheckpointResult(**defaults)


def test_sends_the_evidence_and_answers_with_a_line_for_the_history():
    client = FakeClient(answer=result())
    provider = make_provider(client)

    line = provider.on_pre_compress(
        [{"role": "user", "content": "Bau den Provider"}, {"role": "assistant", "content": "Ok"}],
        require_checkpoint=True,
    )

    assert client.calls[0]["sessionId"] == "session-7"
    assert client.calls[0]["messages"] == [
        {"role": "user", "text": "Bau den Provider"},
        {"role": "assistant", "text": "Ok"},
    ]
    assert "cp-1" in line
    assert "Entscheidung zum Provider" in line


def test_fails_closed_when_the_deployment_is_unreachable():
    # The whole point of the endpoint: Hermes reads this exception as "do not
    # compact", and the wording of the conversation survives.
    provider = make_provider(FakeClient(error=CheckpointError("connection refused")))

    with pytest.raises(CheckpointError):
        provider.on_pre_compress(
            [{"role": "user", "content": "etwas"}], require_checkpoint=True
        )


def test_stays_quiet_when_the_caller_did_not_require_a_checkpoint():
    provider = make_provider(FakeClient(error=CheckpointError("connection refused")))

    assert (
        provider.on_pre_compress([{"role": "user", "content": "etwas"}], require_checkpoint=False)
        == ""
    )


def test_invents_a_session_id_rather_than_blocking_the_compaction():
    # Hermes always calls `initialize`, but a provider built by hand has no id
    # yet. Refusing there would block every compaction over a detail nobody
    # configured; a per-instance id groups the checkpoints of exactly one run,
    # which is the lifetime a session has anyway.
    provider = make_provider(FakeClient(answer=result()), session=None)

    assert provider.session_id.startswith("exocortex-")
    provider.on_pre_compress([{"role": "user", "content": "x"}], require_checkpoint=True)


def test_initialize_binds_the_session_and_on_session_switch_rebinds_it():
    provider = make_provider(FakeClient(answer=result()), session=None)

    provider.initialize("session-a", agent_context="cron")
    provider.on_pre_compress([{"role": "user", "content": "x"}], require_checkpoint=True)
    provider.on_session_switch("session-b")
    provider.on_pre_compress([{"role": "user", "content": "y"}], require_checkpoint=True)

    assert [call["sessionId"] for call in provider.client.calls] == ["session-a", "session-b"]
    # The agent context travels as provenance, so a cron run reads as one later.
    assert "cron" in provider.client.calls[0]["hint"]


def test_an_empty_window_is_not_a_failure():
    # Refusing to compact an empty window would stall the agent forever.
    provider = make_provider(FakeClient(answer=result()))

    assert provider.on_pre_compress([], require_checkpoint=True) == ""


def test_a_repeated_window_is_reported_as_already_saved():
    provider = make_provider(FakeClient(answer=result(deduplicated=True, new_messages=0)))

    line = provider.on_pre_compress([{"role": "user", "content": "x"}], require_checkpoint=True)

    assert "bereits gesichert" in line


def test_nothing_worth_keeping_still_lets_the_compaction_happen():
    provider = make_provider(FakeClient(answer=result(document_id=None, title=None)))

    line = provider.on_pre_compress([{"role": "user", "content": "x"}], require_checkpoint=True)

    assert "nichts Erhaltenswertes" in line


def test_session_end_never_raises():
    provider = make_provider(FakeClient(error=CheckpointError("down")))

    provider.on_session_end([{"role": "user", "content": "x"}])


def test_prefetch_is_off_until_it_is_turned_on():
    off = make_provider(FakeClient(answer="etwas Gedächtnis"))
    off.queue_prefetch("woran arbeiten wir")
    assert off.prefetch("woran arbeiten wir") == ""
    assert off.client.calls == []


def test_prefetch_answers_from_the_background_recall_and_only_once():
    # Hermes needs prefetch to be fast because it sits in front of a turn, so
    # the request happens in `queue_prefetch` and this only hands back what it
    # found. Showing it twice would read as two memories.
    on = make_provider(FakeClient(answer="etwas Gedächtnis"), prefetch_enabled=True)

    on.queue_prefetch("woran arbeiten wir")
    _drain(on)

    assert on.prefetch("woran arbeiten wir") == "etwas Gedächtnis"
    assert on.prefetch("woran arbeiten wir") == ""


def test_a_failed_recall_is_a_turn_without_context_not_a_failed_turn():
    on = make_provider(FakeClient(error=CheckpointError("down")), prefetch_enabled=True)

    on.queue_prefetch("woran arbeiten wir")
    _drain(on)

    assert on.prefetch("woran arbeiten wir") == ""


def _drain(provider) -> None:
    """Waits for the background recall this provider started."""
    import threading

    for thread in threading.enumerate():
        if thread.name == "exocortex-recall":
            thread.join(timeout=5)


class TestHermesContract:
    """The shapes Hermes checks before it will use a provider at all."""

    def test_declares_the_fail_closed_checkpoint_api(self):
        assert ExocortexMemoryProvider.pre_compress_checkpoint_api_version == 2

    def test_is_unavailable_without_a_token_and_says_why(self):
        config = ProviderConfig.from_mapping({"project": "hermes"}, environ={})
        provider = ExocortexMemoryProvider(config)

        assert provider.is_available() is False
        assert "EXOCORTEX_API_TOKEN" in provider.unavailable_reason()

    def test_adds_no_tools(self):
        # The `exo_*` MCP catalogue is how a model reaches eXocortex; a second,
        # smaller copy inside the memory lifecycle would be two answers to one
        # question.
        assert make_provider(FakeClient()).get_tool_schemas() == []

    def test_the_token_field_is_marked_secret_so_it_lands_in_env(self):
        from exocortex_memory import config_schema

        token = next(field for field in config_schema() if field["key"] == "token")
        assert token["secret"] is True
        assert token["env_var"] == "EXOCORTEX_API_TOKEN"

    def test_register_announces_the_provider_on_the_context(self):
        from exocortex_memory import register

        class Ctx:
            def __init__(self):
                self.provider = None

            def register_memory_provider(self, provider):
                self.provider = provider

        ctx = Ctx()
        returned = register(ctx)
        assert ctx.provider is returned
        assert isinstance(returned, ExocortexMemoryProvider)


class TestFlattening:
    def test_reads_a_plain_string(self):
        assert flatten_content("  hallo  ") == "hallo"

    def test_reads_a_list_of_blocks(self):
        assert flatten_content([{"type": "text", "text": "eins"}, {"text": "zwei"}]) == "eins\nzwei"

    def test_drops_a_message_with_no_text(self):
        messages = list(normalize_messages([{"role": "tool", "content": None}]))
        assert messages == []

    def test_cuts_the_evidence_at_the_limit_the_api_enforces(self):
        # Cut here rather than at the API, or a long conversation turns into a
        # validation error at the one moment the caller cannot retry.
        huge = [{"role": "user", "content": "x" * 300_000} for _ in range(3)]
        total = sum(len(message["text"]) for message in normalize_messages(huge))
        assert total <= MAX_EVIDENCE_CHARS


class TestConfig:
    def test_reads_the_token_from_the_environment_not_the_config_file(self):
        config = ProviderConfig.from_mapping({}, environ={"EXOCORTEX_API_TOKEN": "secret"})
        assert config.token == "secret"

    def test_ignores_a_token_somebody_put_in_the_config_file(self):
        # It would work, and then it would sit in a file that gets committed
        # and backed up. The schema marks the field secret so `hermes memory
        # setup` writes it to `.env`; honouring it here would undo that.
        config = ProviderConfig.from_mapping({"token": "committed"}, environ={})
        assert config.token == ""

    def test_falls_back_to_the_public_deployment(self):
        config = ProviderConfig.from_mapping({}, environ={})
        assert config.base_url == "https://exocortex.app"


def test_the_request_body_is_json_serialisable():
    # It goes through `json.dumps` in the client; a generator or a dataclass in
    # there would only show up at the moment of a real compaction.
    client = FakeClient(answer=result())
    provider = make_provider(client)
    provider.on_pre_compress([{"role": "user", "content": ["a", "b"]}], require_checkpoint=True)
    json.dumps(client.calls[0])
