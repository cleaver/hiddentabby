# HiddenTabby

HiddenTabby is a local-only Manifest V3 extension for Chrome and Brave. It organizes unpinned tabs into named groups shared across normal windows. Each group remembers the windows containing its tabs; switching restores that layout, closes unneeded unpinned windows, and focuses a useful window for the selected group.

## Load it locally

1. Open `chrome://extensions` in Chrome/Chromium or `brave://extensions` in Brave.
2. Turn on **Developer mode** and choose **Load unpacked**.
3. Select this repository's root directory.

On first run, HiddenTabby creates **Default** and adds existing unpinned tabs from normal windows. New unpinned tabs join the active group. Pinned tabs and incognito windows are excluded. A new group does not become active when created.

Use the toolbar popup to switch groups or create one. Choose **Manage groups and tabs** for rename, color, ordering, deletion, and tab moves. The same manager can open in the side panel when the browser supports it.

When only one tab from a HiddenTabby group is open in a window, HiddenTabby leaves it outside the browser's native tab group to avoid the browser's confirmation when closing that last tab. The tab remains assigned to its HiddenTabby group.

## Restore behavior and privacy

Inactive group tabs are closed so that windows can show only the selected group. Windows with pinned tabs stay open, and pinned tabs remain outside every group. A New Tab page is saved only when its group has another meaningful tab in that same logical window; New-Tab-only windows and HiddenTabby placeholders are not remembered. Empty groups keep pinned windows without extra placeholders, or retain one temporary window when no pinned window is available. Navigating its placeholder adds the page to the active group.

HiddenTabby asks the browser Sessions API to restore closed tabs, then falls back to their saved URLs when no session is available. A restored page may lose unsaved form data, in-memory state, or running scripts. Closing a nonfinal normal window manually forgets the active group's tabs in that window; saved tabs from inactive groups that share the logical window remain available. Closing the final normal window preserves useful group snapshots for the next browser start. This applies only to the final window: windows closed earlier while other normal windows remained are forgotten.

Group and tab metadata, including page titles and URLs, stays in `chrome.storage.local` in the current browser profile so HiddenTabby can manage and restore workspaces. HiddenTabby does not sync or upload this data to an external service. See the [Privacy Policy](PRIVACY.md). The extension requests `tabs` and `tabGroups` to inspect/manage groups, `sessions` for tab restoration, `contextMenus` for the tab-strip move action, `storage` for local persistence, and `sidePanel` for the optional manager surface.

Brave Containers are managed separately from HiddenTabby groups. The manager links to Brave's Container settings, but the extension does not identify, create, or assign Containers because a supported extension API is not available yet.

## Development and tests

There is no build step or package dependency. Run the browser-independent suites with:

```sh
npm test
npm run test:unit
npm run test:integration
npm run test:coverage
npm run package
npm run test:e2e
npm run test:e2e:brave
```

The package command requires the system zip utility and writes `dist/HiddenTabby.zip` with the runtime extension files and MIT license. The packaged E2E commands require `unzip` and the installed Linux browsers at `/usr/bin/chromium` and `/usr/bin/brave`. They load the ZIP contents in headless browser profiles, exercise real tab/window/group/session/storage APIs, cover first-run adoption over existing native groups, enable incognito access and verify private tabs stay excluded, open and use the action popup and side-panel manager, test the Brave settings link, verify service-worker idle suspension/wake, and confirm state across a browser restart. Chromium closes its final normal window and restores its dormant tabs; Brave keeps the last normal window open in this headless setup. The runs save wide and narrow manager screenshots under `test-results/` and discard their profiles.

Toolbar and extension-list icons are generated in `icons/` from the source illustration `hidden-tabby.png`; the workspace manager uses a high-resolution variant. Runtime icons are included in the package.

GitHub Actions runs the unit, integration, and Chromium E2E suites on pushes and pull requests. A successful run attaches `HiddenTabby.zip` as a downloadable artifact; get it from the run's **Artifacts** section within 30 days. Pushing a version tag such as `v0.1.5` runs `.github/workflows/release.yml`, which checks the tag against `manifest.json`, rebuilds and tests the ZIP, creates a SHA-256 checksum and GitHub artifact attestation, then attaches the ZIP and checksum to a GitHub release.

### Verify a release package

Download the ZIP and checksum from a GitHub release, then use the [GitHub CLI](https://cli.github.com/) to verify the checksum and that the exact ZIP was attested by this repository's release workflow:

```sh
gh release download v0.1.5 -R cleaver/hiddentabby
sha256sum -c HiddenTabby.zip.sha256
gh attestation verify HiddenTabby.zip \
  -R cleaver/hiddentabby \
  --signer-workflow cleaver/hiddentabby/.github/workflows/release.yml
```

The SHA-256 checksum is a fingerprint: checking it confirms that your downloaded ZIP matches the published checksum, but it does not identify the ZIP's source. The GitHub artifact attestation is a signed build record that links the ZIP to this repository, the source revision associated with the release tag, and the workflow that built it. Verifying both gives evidence that the ZIP came from this release's source and build process. This is not a code review or a guarantee that the code is bug-free or secure; the source, maintainer account, and build service still require trust. Review the tagged source and workflow if you want to assess the code yourself.

Run `npm run test:e2e` for packaged Chromium checks and `npm run test:e2e:brave` for Brave. Reload the unpacked extension after editing files. The suite tests the extension in disposable headless browser profiles; separate headed checks have clicked the toolbar icon, dismissed the popup with Escape, selected a native tab-strip move destination, and opened the side-panel manager in Chromium and Brave. The Brave E2E also clicks the Container settings control and verifies that Brave opens its settings page. Initial support targets Linux, with Chromium as the Chrome proxy and a separate Brave run.

## License

HiddenTabby is licensed under the MIT License. See [LICENSE](LICENSE) for the terms.
