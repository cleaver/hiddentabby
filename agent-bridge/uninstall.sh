#!/usr/bin/env bash
# Remove HiddenTabby's local agent bridge registration for the current user.
set -euo pipefail
for profile_root in "$HOME/.config/google-chrome" "$HOME/.config/chromium" "$HOME/.config/BraveSoftware/Brave-Browser"; do
  rm -f "$profile_root/NativeMessagingHosts/hiddentabby_agent_bridge.json"
done
rm -f "$HOME/.local/bin/hiddentabby-tabs"
echo "Removed HiddenTabby agent bridge registration."
