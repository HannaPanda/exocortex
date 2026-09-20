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

    def recall(self, query, project, *, max_chars, limit):
        self.calls.append(
            {"recall": query, "project": project, "maxChars": max_chars, "limit": limit}
        )
        if self._error is not None:
            raise self._error
        return self._answer


def make_provider(client) -> ExocortexMemoryProvider:
    config = ProviderConfig.from_mapping({"project": "hermes", "token": "t"}, environ={})
    return ExocortexMemoryProvider(config, client=client)


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
        session_id="session-7",
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
            [{"role": "user", "content": "etwas"}],
            require_checkpoint=True,
            session_id="session-7",
        )


def test_stays_quiet_when_the_caller_did_not_require_a_checkpoint():
    provider = make_provider(FakeClient(error=CheckpointError("connection refused")))

    assert (
        provider.on_pre_compress(
            [{"role": "user", "content": "etwas"}],
            require_checkpoint=False,
            session_id="session-7",
        )
        is None
    )


def test_refuses_without_a_session_id():
    provider = make_provider(FakeClient(answer=result()))

    with pytest.raises(CheckpointError):
        provider.on_pre_compress([{"role": "user", "content": "x"}], require_checkpoint=True)


def test_an_empty_window_is_not_a_failure():
    # Refusing to compact an empty window would stall the agent forever.
    provider = make_provider(FakeClient(answer=result()))

    assert provider.on_pre_compress([], require_checkpoint=True, session_id="s") is None


def test_a_repeated_window_is_reported_as_already_saved():
    provider = make_provider(FakeClient(answer=result(deduplicated=True, new_messages=0)))

    line = provider.on_pre_compress(
        [{"role": "user", "content": "x"}], require_checkpoint=True, session_id="s"
    )

    assert "bereits gesichert" in line


def test_nothing_worth_keeping_still_lets_the_compaction_happen():
    provider = make_provider(FakeClient(answer=result(document_id=None, title=None)))

    line = provider.on_pre_compress(
        [{"role": "user", "content": "x"}], require_checkpoint=True, session_id="s"
    )

    assert "nichts Erhaltenswertes" in line


def test_session_end_never_raises():
    provider = make_provider(FakeClient(error=CheckpointError("down")))
    provider.on_session_start(session_id="s")

    provider.on_session_end([{"role": "user", "content": "x"}])


def test_prefetch_is_off_until_it_is_turned_on():
    provider = make_provider(FakeClient(answer="etwas Gedächtnis"))

    assert provider.prefetch("woran arbeiten wir") is None

    config = ProviderConfig.from_mapping(
        {"project": "hermes", "token": "t", "prefetch_enabled": True}, environ={}
    )
    on = ExocortexMemoryProvider(config, client=FakeClient(answer="etwas Gedächtnis"))
    assert on.prefetch("woran arbeiten wir") == "etwas Gedächtnis"


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

    def test_falls_back_to_the_public_deployment(self):
        config = ProviderConfig.from_mapping({}, environ={})
        assert config.base_url == "https://exocortex.app"


def test_the_request_body_is_json_serialisable():
    # It goes through `json.dumps` in the client; a generator or a dataclass in
    # there would only show up at the moment of a real compaction.
    client = FakeClient(answer=result())
    provider = make_provider(client)
    provider.on_pre_compress(
        [{"role": "user", "content": ["a", "b"]}], require_checkpoint=True, session_id="s"
    )
    json.dumps(client.calls[0])
