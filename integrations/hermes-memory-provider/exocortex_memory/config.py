"""Where the provider's settings come from.

Two sources, split along one line: secrets from the environment, everything else
from the `memory.exocortex` block in Hermes' `config.yaml`. The configuration
file is the thing people commit and back up, and a token in it is a token in
somebody's history.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Mapping

DEFAULT_BASE_URL = "https://exocortex.app"
DEFAULT_CLIENT = "hermes"
DEFAULT_PROJECT = "hermes"

DEFAULT_TIMEOUT_SECONDS = 60.0
"""A little above the API's own 45 second distillation timeout, so what reaches
Hermes is the deployment's reasoned failure rather than a socket closing under
it."""

DEFAULT_RECALL_MAX_CHARS = 4_000
DEFAULT_RECALL_LIMIT = 5
DEFAULT_RECALL_TIMEOUT_SECONDS = 15.0

#: The block in `config.yaml` this provider reads, under `memory:`.
CONFIG_KEY = "exocortex"

_TRUE_WORDS = {"1", "true", "yes", "on"}
_FALSE_WORDS = {"0", "false", "no", "off"}


@dataclass(frozen=True)
class ProviderConfig:
    base_url: str
    token: str
    project: str
    client: str
    timeout_seconds: float
    recall_max_chars: int
    recall_limit: int
    recall_timeout_seconds: float
    prefetch_enabled: bool

    @classmethod
    def from_mapping(
        cls,
        options: Mapping[str, Any] | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> "ProviderConfig":
        options = options or {}
        environ = environ if environ is not None else os.environ

        return cls(
            base_url=_text(
                options.get("base_url"), environ.get("EXOCORTEX_BASE_URL"), DEFAULT_BASE_URL
            ).rstrip("/"),
            # Never from the config file, even when somebody puts it there: the
            # schema below marks it a secret, which is what sends it to `.env`.
            token=_text(
                environ.get("EXOCORTEX_API_TOKEN"), environ.get("EXOCORTEX_MEMORY_TOKEN"), ""
            ),
            # A Hermes session has no working directory, so the project it files
            # under is named rather than derived. Without one every session of
            # every agent would land on the same page.
            project=_text(
                options.get("project"), environ.get("EXOCORTEX_MEMORY_PROJECT"), DEFAULT_PROJECT
            ),
            client=_text(options.get("client"), None, DEFAULT_CLIENT),
            timeout_seconds=_number(options.get("timeout_seconds"), DEFAULT_TIMEOUT_SECONDS),
            recall_max_chars=int(_number(options.get("recall_max_chars"), DEFAULT_RECALL_MAX_CHARS)),
            recall_limit=int(_number(options.get("recall_limit"), DEFAULT_RECALL_LIMIT)),
            recall_timeout_seconds=_number(
                options.get("recall_timeout_seconds"), DEFAULT_RECALL_TIMEOUT_SECONDS
            ),
            prefetch_enabled=_boolean(options.get("prefetch_enabled"), False),
        )

    @classmethod
    def from_hermes(cls) -> "ProviderConfig":
        """Reads `memory.exocortex` out of the running Hermes configuration.

        Never raises. A provider that cannot read its own configuration reports
        itself unavailable through `is_available`, which is a warning Hermes
        shows; an exception here would be an agent that does not start.
        """
        return cls.from_mapping(read_hermes_options())


def read_hermes_options() -> dict[str, Any]:
    """The `memory.exocortex` block, or an empty one outside Hermes."""
    try:
        from hermes_cli.config import load_config

        memory = load_config().get("memory", {})
    except Exception:
        return {}
    block = memory.get(CONFIG_KEY, {}) if isinstance(memory, dict) else {}
    return dict(block) if isinstance(block, dict) else {}


def config_schema() -> list[dict[str, Any]]:
    """The fields `hermes memory setup` asks for.

    `secret: True` on the token is what routes it into `.env` instead of
    `config.yaml`, which is the whole reason this list is worth writing.
    """
    return [
        {
            "key": "token",
            "description": "eXocortex API token with the write scope (account must be a member of the memory workspace)",
            "secret": True,
            "required": True,
            "env_var": "EXOCORTEX_API_TOKEN",
        },
        {
            "key": "base_url",
            "description": "Address of the eXocortex deployment",
            "default": DEFAULT_BASE_URL,
            "type": "text",
            "url": "https://exocortex.app",
        },
        {
            "key": "project",
            "description": "Which project page the notes are filed under",
            "default": DEFAULT_PROJECT,
            "type": "text",
        },
        {
            "key": "prefetch_enabled",
            "description": "Inject a few remembered lines before each turn (off by default: it spends the context budget compaction just freed)",
            "default": False,
            "type": "boolean",
        },
        {
            "key": "recall_max_chars",
            "description": "Hard ceiling for what a prefetch may inject",
            "default": DEFAULT_RECALL_MAX_CHARS,
            "type": "integer",
            "minimum": 500,
            "maximum": 20_000,
        },
    ]


def _text(*candidates: Any) -> str:
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
        if candidate not in (None, "") and not isinstance(candidate, str):
            return str(candidate)
    return ""


def _number(value: Any, default: float) -> float:
    try:
        return float(value) if value not in (None, "") else default
    except (TypeError, ValueError):
        return default


def _boolean(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in _TRUE_WORDS:
            return True
        if lowered in _FALSE_WORDS:
            return False
    return default
