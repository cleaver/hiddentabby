#!/usr/bin/env bash
# Install HiddenTabby's local agent bridge for the current user (Linux).
#   agent-bridge/install.sh [EXTENSION_ID]
# EXTENSION_ID defaults to the Chrome Web Store ID. For an unpacked build, copy
# the ID shown on the extension card in chrome://extensions or brave://extensions.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ext_id="${1:-nonjheegmgeonamccahabomomcfjlafh}"
name="hiddentabby_agent_bridge"
[[ "$ext_id" =~ ^[a-p]{32}$ ]] || { echo "Invalid extension ID: $ext_id" >&2; exit 1; }

chmod 755 "$here/host.py" "$here/hiddentabby-tabs"
installed=0
for profile_root in "$HOME/.config/google-chrome" "$HOME/.config/chromium" "$HOME/.config/BraveSoftware/Brave-Browser"; do
  [ -d "$profile_root" ] || continue
  host_dir="$profile_root/NativeMessagingHosts"
  mkdir -p "$host_dir"
  cat > "$host_dir/$name.json" <<JSON
{
  "name": "$name",
  "description": "HiddenTabby local agent bridge",
  "path": "$here/host.py",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ext_id/"]
}
JSON
  echo "Installed $host_dir/$name.json"
  installed=1
done
[ "$installed" = 1 ] || { echo "No Chrome, Chromium or Brave profile directory found." >&2; exit 1; }
mkdir -p "$HOME/.local/bin"
ln -sfn "$here/hiddentabby-tabs" "$HOME/.local/bin/hiddentabby-tabs"
echo "Linked ~/.local/bin/hiddentabby-tabs"
