#!/usr/bin/env python3
"""Infisical -> Exocortex .env sync (merge-only).

Infisical is the source of truth for the keys it manages; everything else in the
target .env is left exactly as it is. Nothing is ever deleted, and no
unmanaged key is ever rewritten -- the repository root .env holds database
URLs, secrets and local overrides that Infisical knows nothing about.

Why a sync into .env at all, rather than reading Infisical at runtime: the
processes must start without a network round-trip to a second service, and
`@exocortex/config` validates the whole environment once at boot (ADR-013 makes
the `setting` table the runtime authority for *configuration*; credentials are
not configuration and the table is not encrypted).

Default is a DRY RUN that names the affected keys without ever printing a value.
`--apply` backs the file up, merges, and chmods 600.

Configuration comes from /var/www/exocortex/.infisical-sync.env (KEY=VALUE); see
deploy/infisical-sync.env.example. That file holds the machine-identity secret
and is git-ignored.

Exit codes: 0 nothing to do, 10 the .env changed (the reload wrapper watches for
this), non-zero on error.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = REPO_ROOT / ".infisical-sync.env"

# Placeholder written when a secret slot is created before its value is known.
# Treated as "not set yet" so a half-configured Infisical project cannot put the
# literal string into the environment, where it would surface as a confusing
# authentication failure three layers down.
PLACEHOLDER = "BITTE_EINTRAGEN"

REQUIRED_CONFIG = (
    "INFISICAL_BASE",
    "INFISICAL_CLIENT_ID",
    "INFISICAL_CLIENT_SECRET",
    "INFISICAL_PROJECT_ID",
)


def load_kv_file(path: Path) -> dict[str, str]:
    data: dict[str, str] = {}
    if not path.exists():
        return data
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        data[key.strip()] = value.strip()
    return data


def http_json(method: str, url: str, headers: dict[str, str], body: dict | None = None) -> dict:
    payload = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=payload, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        # The body carries Infisical's own reason (wrong project, IP
        # restriction, identity not assigned); without it the caller only sees
        # a bare status code and has nothing to act on.
        detail = error.read().decode(errors="replace")[:400]
        raise SystemExit(f"Infisical {method} {url} -> HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise SystemExit(f"Infisical nicht erreichbar ({url}): {error.reason}") from error


def infisical_login(base: str, client_id: str, client_secret: str) -> str:
    out = http_json(
        "POST",
        f"{base}/api/v1/auth/universal-auth/login",
        {"content-type": "application/json"},
        {"clientId": client_id, "clientSecret": client_secret},
    )
    token = out.get("accessToken", "")
    if not token:
        raise SystemExit("Infisical-Login lieferte kein accessToken (IP-Restriction oder Zuordnung?).")
    return token


def fetch_secrets(base: str, token: str, project_id: str, env: str, path: str) -> dict[str, str]:
    query = urllib.parse.urlencode({"workspaceId": project_id, "environment": env, "secretPath": path})
    out = http_json("GET", f"{base}/api/v3/secrets/raw?{query}", {"Authorization": f"Bearer {token}"})
    return {s["secretKey"]: s.get("secretValue", "") for s in out.get("secrets", [])}


def parse_env(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    if not path.exists():
        return result
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        result[key.strip()] = value
    return result


def merge_env(path: Path, managed: dict[str, str]) -> None:
    """Rewrite managed keys in place, append the missing ones, keep the rest."""
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    seen: set[str] = set()
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key = stripped.partition("=")[0].strip()
        if key in managed:
            lines[index] = f"{key}={managed[key]}"
            seen.add(key)
    appended = [key for key in managed if key not in seen]
    if appended:
        lines.append("")
        lines.append(f"# Verwaltet von Infisical, siehe deploy/infisical-sync-env.py ({time.strftime('%Y-%m-%d')})")
        lines.extend(f"{key}={managed[key]}" for key in appended)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Infisical -> Exocortex .env sync (merge-only)")
    parser.add_argument("--apply", action="store_true", help="Änderungen wirklich schreiben (sonst nur Dry-Run)")
    args = parser.parse_args()

    config = load_kv_file(CONFIG_FILE)
    if not config:
        raise SystemExit(f"Config {CONFIG_FILE} fehlt. Vorlage: deploy/infisical-sync.env.example")
    for key in REQUIRED_CONFIG:
        if not config.get(key):
            raise SystemExit(f"Config {key} fehlt in {CONFIG_FILE}")

    base = config["INFISICAL_BASE"].rstrip("/")
    env_name = config.get("INFISICAL_ENV", "prod")
    secret_path = config.get("INFISICAL_SECRET_PATH", "/")
    target = Path(config.get("TARGET_ENV_FILE", str(REPO_ROOT / ".env")))

    token = infisical_login(base, config["INFISICAL_CLIENT_ID"], config["INFISICAL_CLIENT_SECRET"])
    managed = fetch_secrets(base, token, config["INFISICAL_PROJECT_ID"], env_name, secret_path)
    if not managed:
        raise SystemExit(f"Keine Secrets aus Infisical erhalten (Projekt {config['INFISICAL_PROJECT_ID']}, env {env_name}).")

    exclude = {k.strip() for k in config.get("EXCLUDE_KEYS", "").split(",") if k.strip()}
    excluded = sorted(key for key in managed if key in exclude)
    unset = sorted(key for key, value in managed.items() if value == PLACEHOLDER)
    managed = {
        key: value
        for key, value in managed.items()
        if key not in exclude and value != PLACEHOLDER
    }
    if excluded:
        print(f"Ausgeschlossen (EXCLUDE_KEYS): {', '.join(excluded)}")
    if unset:
        print(f"Noch nicht ausgefüllt, übersprungen: {', '.join(unset)}")
    if not managed:
        print("Keine übertragbaren Secrets. Nichts zu tun.")
        return 0

    current = parse_env(target)
    in_sync = sorted(k for k, v in managed.items() if k in current and current[k] == v)
    differ = sorted(k for k, v in managed.items() if k in current and current[k] != v)
    missing = sorted(k for k in managed if k not in current)

    print(f"Infisical {env_name} verwaltet {len(managed)} Keys. Ziel: {target}")
    print(f"  = in sync         : {', '.join(in_sync) or '-'}")
    print(f"  ~ würde aktual.   : {', '.join(differ) or '-'}")
    print(f"  + würde ergänzen  : {', '.join(missing) or '-'}")
    print(f"  (unangetastet)    : {len([k for k in current if k not in managed])} nicht verwaltete Keys bleiben.")

    if not args.apply:
        print("\nDRY RUN. Nichts geschrieben. Mit --apply anwenden.")
        return 0
    if not (differ or missing):
        print("\nNichts zu tun, .env ist bereits in sync.")
        return 0

    if target.exists():
        backup = target.with_name(f"{target.name}.bak-infisical-{time.strftime('%Y%m%d-%H%M%S')}")
        backup.write_bytes(target.read_bytes())
        os.chmod(backup, 0o600)
        # The timer runs this as root, but the backup holds the same secrets as
        # the .env and belongs to whoever owns that file -- otherwise the owner
        # cannot read their own backup without sudo.
        if os.geteuid() == 0:
            stat = target.stat()
            os.chown(backup, stat.st_uid, stat.st_gid)
        print(f"\nBackup: {backup}")
    merge_env(target, managed)
    os.chmod(target, 0o600)
    print("Angewendet. Die Prozesse lesen .env beim Start, für Live-Wirkung:")
    print("  sudo systemctl restart exocortex-worker")
    return 10


if __name__ == "__main__":
    sys.exit(main())
