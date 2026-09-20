"""eXocortex as a Hermes memory provider (issue #92, ADR-046)."""

from __future__ import annotations

from typing import Any, Mapping

from .client import CheckpointError, CheckpointResult, ExocortexClient
from .config import ProviderConfig
from .provider import ExocortexMemoryProvider

__all__ = [
    "CheckpointError",
    "CheckpointResult",
    "ExocortexClient",
    "ExocortexMemoryProvider",
    "ProviderConfig",
    "register",
]


def register(options: Mapping[str, Any] | None = None, **kwargs: Any) -> ExocortexMemoryProvider:
    """The entry point Hermes resolves `memory.provider: exocortex` through.

    Takes the provider block from `config.yaml` either as one mapping or as
    keyword arguments, because both spellings exist in the wild and neither is
    worth a configuration error.
    """
    merged: dict[str, Any] = dict(options or {})
    merged.update(kwargs)
    return ExocortexMemoryProvider(options=merged)
