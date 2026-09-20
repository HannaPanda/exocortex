"""Where the provider's settings come from.

Secrets read from the environment, everything else from the provider block in
`config.yaml`. The split is the point: the configuration file is the thing
people commit, and a token in it is a token in somebody's history.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Mapping

DEFAULT_BASE_URL = "https://exocortex.app"
DEFAULT_CLIENT = "hermes"
DEFAULT_TIMEOUT_SECONDS = 60.0
"""A little above the API's own 45 second distillation timeout, so the failure
that reaches Hermes is the deployment's reasoned one rather than a socket
closing underneath it."""

DEFAULT_RECALL_MAX_CHARS = 4_000
DEFAULT_RECALL_LIMIT = 5


@dataclass(frozen=True)
class ProviderConfig:
    base_url: str
    token: str
    project: str
    client: str
    timeout_seconds: float
    recall_max_chars: int
    recall_limit: int
    prefetch_enabled: bool

    @classmethod
    def from_mapping(
        cls,
        options: Mapping[str, Any] | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> "ProviderConfig":
        options = options or {}
        environ = environ if environ is not None else os.environ

        token = str(
            options.get("token")
            or environ.get("EXOCORTEX_API_TOKEN")
            or environ.get("EXOCORTEX_MEMORY_TOKEN")
            or ""
        )
        base_url = str(
            options.get("base_url") or environ.get("EXOCORTEX_BASE_URL") or DEFAULT_BASE_URL
        )
        # The project a Hermes session belongs to. A messenger agent has no
        # working directory, so it is named rather than derived; without one
        # every session of every agent would file under the same page.
        project = str(
            options.get("project") or environ.get("EXOCORTEX_MEMORY_PROJECT") or "hermes"
        )

        return cls(
            base_url=base_url,
            token=token,
            project=project,
            client=str(options.get("client") or DEFAULT_CLIENT),
            timeout_seconds=float(options.get("timeout_seconds") or DEFAULT_TIMEOUT_SECONDS),
            recall_max_chars=int(options.get("recall_max_chars") or DEFAULT_RECALL_MAX_CHARS),
            recall_limit=int(options.get("recall_limit") or DEFAULT_RECALL_LIMIT),
            prefetch_enabled=bool(options.get("prefetch_enabled", False)),
        )
