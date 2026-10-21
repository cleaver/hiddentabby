playwright-mcp:
    #!/usr/bin/env bash
    set -euo pipefail
    if codex mcp get playwright >/dev/null 2>&1; then
      echo "Playwright MCP is already registered with Codex."
    else
      codex mcp add playwright -- npx --yes @playwright/mcp@latest
      echo "Playwright MCP registered with Codex. Restart Codex to load it."
    fi

refresh: package
    rm -rf dist/HiddenTabby
    unzip -q dist/HiddenTabby.zip -d dist/HiddenTabby

package:
    npm run package
