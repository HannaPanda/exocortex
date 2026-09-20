#!/usr/bin/env bash
# Compare the pinned Web Interface Guidelines against the current upstream file
# and, only after the diff has been read, write the new pin.
#
#   bash .claude/skills/web-design-guidelines/update.sh          # show the diff
#   bash .claude/skills/web-design-guidelines/update.sh --write  # adopt it
#
# The upstream skill re-fetches these rules from a moving branch on every run.
# This repository pins them instead, so a review compares against rules somebody
# decided to adopt. That decision is this script's only reason to exist: it
# refuses to write without --write, and it prints what would change first.
set -euo pipefail

dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
pin="$dir/guidelines.md"
skill="$dir/SKILL.md"
repo='vercel-labs/web-interface-guidelines'
path='command.md'

write=0
[ "${1:-}" = '--write' ] && write=1

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

sha="$(gh api "repos/$repo/commits/main" --jq '.sha')"
gh api "repos/$repo/contents/$path?ref=$sha" --jq '.content' | base64 -d > "$tmp"

blob="$(git hash-object "$tmp")"
pinned_blob="$(git hash-object "$pin")"

if [ "$blob" = "$pinned_blob" ]; then
  echo "Unverändert. Pin steht auf $blob, Upstream-Commit $sha."
  exit 0
fi

echo "Upstream-Commit: $sha"
echo "Upstream-Blob:   $blob"
echo "Gepinnter Blob:  $pinned_blob"
echo
diff -u "$pin" "$tmp" || true

if [ "$write" -eq 0 ]; then
  echo
  echo "Nichts geschrieben. Diff lesen, dann: bash ${BASH_SOURCE[0]} --write"
  exit 1
fi

cp "$tmp" "$pin"
date="$(gh api "repos/$repo/commits/$sha" --jq '.commit.committer.date' | cut -c1-10)"
sed -i \
  -e "s|^- Pinned commit: \`.*\`.*|- Pinned commit: \`$sha\` ($date)|" \
  -e "s|^- Pinned blob: \`.*\`|- Pinned blob: \`$blob\`|" \
  "$skill"
echo
echo "Pin geschrieben: $sha / $blob. SKILL.md aktualisiert, Änderung committen."
