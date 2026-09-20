"""The HTTP half: one POST, no dependencies.

Deliberately not the MCP client Hermes may already hold. The memory-provider
lifecycle runs outside any tool loop, and `on_pre_compress` has to persist
synchronously at a moment when no model is deciding anything. Routing that
through a tool catalogue would mean an agent could decline to call it.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from urllib.parse import urlencode
from typing import Any, Mapping


class CheckpointError(RuntimeError):
    """A checkpoint that did not happen.

    Raised for every failure, including the ones that look like configuration
    mistakes. Hermes reads an exception from `on_pre_compress` as "do not
    compact" when `checkpoint_required` is set, and that is the right answer to
    a misconfigured provider too: a deployment nobody can reach must not quietly
    become permission to forget.
    """

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class CheckpointResult:
    """What the deployment wrote, as far as the provider cares."""

    checkpoint_id: str
    digest: str
    deduplicated: bool
    new_messages: int
    document_id: str | None
    title: str | None
    url: str | None

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "CheckpointResult":
        return cls(
            checkpoint_id=str(payload["checkpointId"]),
            digest=str(payload["digest"]),
            deduplicated=bool(payload.get("deduplicated", False)),
            new_messages=int(payload.get("newMessages", 0)),
            document_id=payload.get("documentId"),
            title=payload.get("title"),
            url=payload.get("url"),
        )


class ExocortexClient:
    """A thin client for the three memory endpoints this provider uses."""

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout_seconds: float = 60.0,
        opener: Any | None = None,
    ) -> None:
        if not base_url:
            raise CheckpointError("eXocortex base URL is not configured")
        if not token:
            raise CheckpointError("eXocortex API token is not configured")
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout_seconds
        # Injected in the tests. Nothing else passes one.
        self._opener = opener or urllib.request.urlopen

    def checkpoint(self, body: Mapping[str, Any]) -> CheckpointResult:
        payload = self._post("/api/memory/checkpoint", body)
        return CheckpointResult.from_payload(payload)

    def recall(
        self,
        query: str | None,
        project: str,
        *,
        max_chars: int,
        limit: int,
        timeout_seconds: float | None = None,
    ) -> str:
        params = [
            ("project", project),
            ("maxChars", str(max_chars)),
            ("limit", str(limit)),
        ]
        if query:
            params.append(("q", query))

        payload = self._get(f"/api/memory/recall?{urlencode(params)}", timeout=timeout_seconds)
        text = payload.get("text")
        return text if isinstance(text, str) else ""

    # -- the transport -----------------------------------------------------

    def _post(self, path: str, body: Mapping[str, Any]) -> Mapping[str, Any]:
        request = urllib.request.Request(
            f"{self._base_url}{path}",
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={
                "content-type": "application/json",
                "accept": "application/json",
                "authorization": f"Bearer {self._token}",
            },
        )
        return self._send(request)

    def _get(self, path: str, *, timeout: float | None = None) -> Mapping[str, Any]:
        request = urllib.request.Request(
            f"{self._base_url}{path}",
            method="GET",
            headers={
                "accept": "application/json",
                "authorization": f"Bearer {self._token}",
            },
        )
        return self._send(request, timeout=timeout)

    def _send(self, request: Any, *, timeout: float | None = None) -> Mapping[str, Any]:
        try:
            with self._opener(request, timeout=timeout or self._timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:  # pragma: no cover - exercised via fakes
            detail = _read_error(error)
            raise CheckpointError(
                f"eXocortex answered {error.code}: {detail}", status=error.code
            ) from error
        except urllib.error.URLError as error:
            raise CheckpointError(f"eXocortex could not be reached: {error.reason}") from error
        except TimeoutError as error:
            raise CheckpointError("eXocortex did not answer in time") from error

        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise CheckpointError("eXocortex answered with something that is not JSON") from error

        if not isinstance(payload, dict):
            raise CheckpointError("eXocortex answered with something that is not an object")
        return payload


def _read_error(error: Any) -> str:
    try:
        body = error.read().decode("utf-8")
    except Exception:  # pragma: no cover - a body that cannot be read is not the story
        return error.reason if hasattr(error, "reason") else "no detail"
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return body[:400]
    # `ApiErrorResponse`: a machine-readable code beside an English message.
    if isinstance(parsed, dict) and "code" in parsed:
        return f"{parsed.get('code', 'error')}: {parsed.get('message', '')}".strip()
    return body[:400]
