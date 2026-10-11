#!/usr/bin/env bash
#
# Fetches the browser and the driver the harness runs (issue #166), into
# e2e/firefox-harness/.bin, without root and without touching the system.
#
#   bash e2e/firefox-harness/setup-tools.sh            latest release of both
#   FIREFOX_VERSION=157.0.1 GECKODRIVER_VERSION=v0.37.1 bash .../setup-tools.sh
#
# The Firefox is the release tarball from download.mozilla.org: the same
# build a desktop user gets, unlike Playwright's patched Firefox and unlike the
# Ubuntu package, which is a snap that geckodriver cannot drive reliably. The
# npm dependencies (selenium-webdriver, ws) are installed beside it with npm,
# outside the pnpm workspace on purpose (see package.json).
set -euo pipefail

DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BIN="$DIR/.bin"
mkdir -p "$BIN"

if [ ! -x "$BIN/firefox/firefox" ] || [ -n "${FIREFOX_VERSION:-}" ]; then
  product="firefox-latest-ssl"
  [ -n "${FIREFOX_VERSION:-}" ] && product="firefox-${FIREFOX_VERSION}-ssl"
  echo "downloading Firefox ($product)"
  rm -rf "$BIN/firefox"
  curl -fsSL -o "$BIN/firefox.tar.xz" "https://download.mozilla.org/?product=${product}&os=linux64&lang=en-US"
  tar -xf "$BIN/firefox.tar.xz" -C "$BIN"
  rm "$BIN/firefox.tar.xz"
fi

if [ ! -x "$BIN/geckodriver" ] || [ -n "${GECKODRIVER_VERSION:-}" ]; then
  version="${GECKODRIVER_VERSION:-$(curl -fsSL https://api.github.com/repos/mozilla/geckodriver/releases/latest | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')}"
  echo "downloading geckodriver $version"
  curl -fsSL -o "$BIN/geckodriver.tar.gz" "https://github.com/mozilla/geckodriver/releases/download/${version}/geckodriver-${version}-linux64.tar.gz"
  tar -xzf "$BIN/geckodriver.tar.gz" -C "$BIN"
  rm "$BIN/geckodriver.tar.gz"
fi

if [ ! -d "$DIR/node_modules/selenium-webdriver" ]; then
  (cd "$DIR" && npm ci --no-audit --no-fund)
fi

"$BIN/firefox/firefox" --version 2>/dev/null | grep -v Sandbox
"$BIN/geckodriver" --version | head -1
