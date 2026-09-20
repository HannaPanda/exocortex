"""eXocortex as a Hermes memory provider (issue #92, ADR-046)."""

from __future__ import annotations

from typing import Any

from .base import HERMES_AVAILABLE
from .client import CheckpointError, CheckpointResult, ExocortexClient
from .config import CONFIG_KEY, ProviderConfig, config_schema, read_hermes_options
from .provider import ExocortexMemoryProvider

__all__ = [
    "CONFIG_KEY",
    "CheckpointError",
    "CheckpointResult",
    "ExocortexClient",
    "ExocortexMemoryProvider",
    "HERMES_AVAILABLE",
    "ProviderConfig",
    "config_schema",
    "read_hermes_options",
    "register",
]


def register(ctx: Any = None) -> ExocortexMemoryProvider:
    """The entry point Hermes resolves `memory.provider: exocortex` through.

    Hermes hands over a registration context and expects the provider to be
    announced on it (`plugins/memory/__init__.py`, `_ProviderCollector`). It
    also accepts a plain return value from a factory, which is the path the
    tests and a hand-built provider take, so this does both.

    The settings come from `memory.exocortex` in `config.yaml` plus
    `EXOCORTEX_API_TOKEN` in the environment. Reading them here rather than in
    the constructor keeps a provider built by hand configurable.
    """
    provider = ExocortexMemoryProvider(ProviderConfig.from_hermes())
    register_memory_provider = getattr(ctx, "register_memory_provider", None)
    if callable(register_memory_provider):
        register_memory_provider(provider)
    return provider
