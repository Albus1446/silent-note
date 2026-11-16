#!/bin/zsh
# Build the xpi + updates.json and publish them as a GitHub release.
# Usage: ./release.sh 0.2.2   (bumps manifest version, commits, tags, releases)
set -euo pipefail
cd "${0:A:h}"
V=${1:?usage: ./release.sh <version>}
REPO=Albus1446/silent-note
ID=claude-code@zotero.local

python3 - "$V" <<'PY'
import json, sys
m = json.load(open("manifest.json")); m["version"] = sys.argv[1]
json.dump(m, open("manifest.json", "w"), indent=2)
PY

rm -rf build && mkdir build
node --check bootstrap.js
zip -q build/claude-code-zotero.xpi manifest.json bootstrap.js prefs.js
HASH=sha256:$(shasum -a 256 build/claude-code-zotero.xpi | cut -d' ' -f1)
cat > build/updates.json <<JSON
{
  "addons": {
    "$ID": {
      "updates": [{
        "version": "$V",
        "update_link": "https://github.com/$REPO/releases/download/v$V/claude-code-zotero.xpi",
        "update_hash": "$HASH",
        "applications": { "zotero": { "strict_min_version": "7.0.0" } }
      }]
    }
  }
}
JSON

git add -A && { git diff --cached --quiet || git commit -qm "Release v$V"; } && git tag "v$V"
git push -q origin HEAD --tags
gh release create "v$V" build/claude-code-zotero.xpi build/updates.json --repo "$REPO" --title "v$V" --notes "Release v$V"
echo "Released v$V"
