# Findings & Decisions

## Requirements

### Confirmed by the user

- Build a Chrome extension that also works in Brave.
- Use Firefox's Simple Tab Groups as the feature-set reference.
- Collect requirements before implementation.
- For Brave's native Containers, the user wants both per-tab Container awareness and the ability to open or move tabs into a chosen Container, gated on a supported Brave extension API. Chrome should retain the common tab-group feature set without Container controls.
- Keep version 1 focused on the core group manager; defer advanced items such as search, drag-and-drop, sorting, backup/restore, undo, themes, and icons.
- Switching groups should close tabs in inactive groups and restore the selected group's tabs.
- Group definitions should be shared across browser windows.
- Switching should apply globally across normal windows, closing tabs in inactive groups and restoring the selected group's tabs to their original windows. This is the interpretation of the user's preference for a shared group model.
- Use the toolbar popup for group switching and a link to the full-page manager/settings; provide the side panel as an optional additional surface.
- If supported APIs become available, let users manage Container definitions in HiddenTabby and keep Brave Settings available. Until then, provide a settings link and no direct Container controls.
- Manage all unpinned tabs while leaving pinned tabs out of groups; provide a tab-strip right-click action to move the clicked tab to another group.
- Store data locally only, ignore incognito, and target browser stable releases no more than roughly three months behind current at release time.
- Use Chrome's Sessions API for closed-tab restoration, which the user accepts, while recognizing live page state may not survive.
- On first run, create a `Default` group and put all currently open unpinned tabs across normal windows in it, replacing their existing native group assignments. New unpinned tabs join the active group. Creating a group from the popup leaves the current group active.
- Keep at least one group named `Default`. Deleting a group closes all its member tabs across windows and removes its saved records. Show a confirmation with the group name and tab count; do not delete browser history or reassign/restore the closed tabs. If deletion would remove the final `Default`, create a fresh empty one; if no groups would remain, it becomes the sole group.
- Moving a tab into an inactive group closes/saves it immediately and does not activate that group.
- During a global switch, keep each otherwise-empty window open with one temporary ungrouped New Tab placeholder. If the user navigates that tab, assign it to the active group; remove it when a group tab is restored. Treat it as a window anchor, not group content.

### Confirmed version 1 core scope

- Create, rename, reorder, color, and delete tab groups.
- Add the current tab to a group and move tabs between groups.
- Switch groups and remember the last active tab in each group.
- Keep group and tab membership through browser restarts.

### Later-release candidates

- Search and keyboard navigation.
- Drag-and-drop tab and group ordering.
- JSON backup and restore, plus undo group removal.
- Advanced cross-window management tools beyond global group switching.

## Research Findings

- The current Simple Tab Groups listing describes multiple-window support, per-group last-active-tab memory, group management, search, drag-and-drop, sorting, JSON backup/restore, custom icons, undo removal, dark theme, and a sidebar.
- The add-on listing declares Firefox's tabHide permission for hiding tabs. It also lists permissions related to containers, storage, sessions, notifications, downloads, and menus.
- Chrome's tabGroups API supports group titles, colors, and a collapsed state. Each native group has a windowId, so cross-window logical groups need extension-managed records with per-window membership. The documented Chromium APIs reviewed do not provide Firefox's tabHide behavior; this is the main known parity gap.
- Chrome's Sessions API can query recently closed tabs/windows and restore an entry by session ID. This needs the `sessions` permission. Reopening a tab does not guarantee that live in-page state, such as unsaved form content or running scripts, will be preserved.
- Chrome's `contextMenus` API supports items in a tab-strip context menu (`contexts: ["tab"]`) and requires the `contextMenus` permission. Its `tabs.group()` API moves selected tab IDs into an existing or new native group. Pinned tabs expose a `pinned` property; HiddenTabby can exclude them from group membership and switching operations.
- Brave 1.92+ desktop has built-in Containers, which isolate cookies and site data and can coexist with ordinary tab organization.
- A Brave browser issue opened in July 2026 and still marked open reports that extension cookie operations on a Container tab target the default cookie store. The issue asks for the tab's container store ID or an equivalent documented API. No supported public extension API for detecting, creating, or assigning Brave Containers was found during this research.
- The user confirmed both future Brave-only Container goals: show each tab's Container and open or move tabs into a chosen Container. Do not use cookies or undocumented Brave internals to infer membership; implement these only if Brave provides a supported API.
- Chrome's sidePanel API can host persistent extension UI and is available from Chrome 114. Brave says it supports nearly all Chromium-compatible extensions.
- The repository currently contains a small Manifest V3 popup starter, not a tab-group manager.
- A provisional requirements document is in REQUIREMENTS.md; it clearly separates core proposals from unanswered product decisions.

## Technical Validation Items

1. Validate global close-and-restore behavior and session restoration in Chromium and Brave (Chromium is the accepted Chrome testing proxy).
2. Validate tab-strip context menu behavior and pinned-tab exclusion in Chromium and Brave (Chromium is the accepted Chrome testing proxy).
3. Validate the popup-to-full-page workflow and optional side-panel support.
4. Revisit native Container management when Brave documents a supported API.
5. Verify deletion keeps an empty `Default` available, activates it when the active group is deleted, and leaves deleted tabs closed and unassigned.

## Resources

- Simple Tab Groups listing: https://addons.mozilla.org/en-GB/firefox/addon/simple-tab-groups/
- Chrome tabs API: https://developer.chrome.com/docs/extensions/reference/api/tabs
- Chrome sidePanel API: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- Chrome sessions API: https://developer.chrome.com/docs/extensions/reference/api/sessions
- Chrome contextMenus API: https://developer.chrome.com/docs/extensions/reference/api/contextMenus
- Chrome tabGroups API: https://developer.chrome.com/docs/extensions/reference/api/tabGroups
- Brave extension support: https://support.brave.com/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave
- Brave Containers announcement: https://brave.com/blog/containers/
- Brave Containers help: https://support.brave.app/hc/en-us/articles/39077103885325-How-do-I-use-Containers-in-Brave
- Brave Containers extension API issue: https://github.com/brave/brave-browser/issues/57209

## Issues Encountered

| Issue | Resolution |
|-------|------------|
| First asynchronous user-input call used the wrong field name | Reissued with the supported tool schema. |
| A documentation patch used an outdated reference URL in its context | Corrected the expected URL and applied the update. |

## Implementation Planning Research (2026-10-14)

- Node and npm are available. Rechecking after the user corrected the inventory confirmed `/usr/bin/brave` (`Brave Browser 155.1.97.56`) and `/usr/bin/chromium` (`Chromium 154.0.8037.97 Arch Linux`). The previous claim that Chromium was unavailable was incorrect. Version commands passed; extension loading and browser automation remain unverified.
- Playwright documents extension testing using bundled Chromium and a persistent browser context, including headless support through the `chromium` channel. Branded Chrome/Edge removed the traditional extension sideload command-line flags, so do not assume the Chromium launch recipe works on installed Chrome.
- Puppeteer documents extension installation, extension action triggering, real popup targets, and service-worker access/termination. Evaluate it in the initial harness spike if Playwright cannot cover actual popup behavior or branded-browser installation. Avoid maintaining two runners unless necessary.
- Browser automation must use disposable profiles; browser restarts may intentionally reuse only the test-owned profile. The user accepts Chromium as the Chrome testing proxy for the initial release; Brave compatibility remains a separate gate.
- Chrome's current contextMenus reference explicitly lists the `tab` context. Its support on the selected Chromium/Brave test baseline must still be proven in a real browser; dispatching a handler directly does not test native tab-strip menu placement.
- Native browser chrome (tab-strip menus, toolbar positioning, side-panel behavior) needs headed/manual verification where the selected runner cannot drive it. Opening popup.html in a normal tab tests its DOM but not actual popup lifecycle.
- MV3 shutdown/restart and last-tab window closure are high-priority risks. Verification must include restarts without a debugger keeping the worker alive, durable state before destructive calls, and a separate test controller that survives browser exit.

Sources checked:
- https://playwright.dev/docs/chrome-extensions
- https://pptr.dev/guides/chrome-extensions
- https://developer.chrome.com/docs/extensions/how-to/test/end-to-end-testing
- https://developer.chrome.com/docs/extensions/how-to/test/test-serviceworker-termination-with-puppeteer
- https://developer.chrome.com/docs/extensions/reference/api/contextMenus

- The user confirmed Linux-only support for the initial release. Windows/macOS compatibility is outside the initial acceptance matrix.

- User-approved testing scope: Chromium is close enough to stand in for Chrome. Initial Linux acceptance requires Chromium and Brave evidence, without a separate Google Chrome run. Report actual tested browser names/versions.
- The user chose the New Tab placeholder behavior for windows with no tabs in the selected group. Persist and reconcile placeholder identity across restarts, and distinguish it from user-created New Tab tabs.
- Initial isolated CLI launches of `/usr/bin/chromium` and `/usr/bin/brave` did not create a DevTools endpoint or initialize the temporary profile. Both emitted only a Crashpad `setsockopt: Operation not permitted` diagnostic. This does not establish the root cause or prove the browsers themselves cannot run; actual extension loading remains unverified. Do not use the user's existing Brave profile for test installation.
- A direct isolated Chromium launch attempt exited with code 133 after the same restricted Crashpad socket diagnostic, including with remote debugging disabled. The current execution environment blocks or crashes the browser process; actual extension loading remains unverified. Do not use the user's existing Brave profile for test installation.
- Chrome documents the `tabs.onRemoved` event's `isWindowClosing` flag for distinguishing parent-window closure from individual tab closure: https://developer.chrome.com/docs/extensions/reference/api/tabs
- Chrome documents `runtime.onStartup` and the short-lived MV3 service-worker lifecycle; persist state in extension storage rather than worker globals or asynchronous `onSuspend` cleanup: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- Lifecycle defaults in `docs/architecture.md` resolve manual tab close, whole-window close, placeholder identity, and startup reconciliation so implementation can proceed without more product questions. These are engineering defaults, not additional user-confirmed requirements.
- State storage uses Node's built-in test runner with no runtime or development package dependency. The current suite has 60 unit and fault-injected integration test cases; the real `chrome.storage.local` adapter remains unverified until a browser can launch.

## Switch Implementation Research (2026-10-14)

- The current official Chrome Sessions API returns recently closed `Session` records containing an optional `tab` or `window`; the tab's `sessionId` is the value accepted by `sessions.restore()`. `sessions.getRecentlyClosed()` is limited to 25 entries. HiddenTabby therefore stores page metadata and uses URL/title restoration when a matching recent session is unavailable. Source: https://developer.chrome.com/docs/extensions/reference/api/sessions
- The Chrome Tabs API documents tab IDs as unique within a browser session, so extension-owned group/tab IDs remain the durable identity. Source: https://developer.chrome.com/docs/extensions/reference/api/tabs
- Added the MV3 service worker, local store wiring, normal-window browser adapter, controller, and journaled global switch path. Browser-independent tests cover two windows, pinned tabs, empty-group placeholders, session restoration calls, native group application, and replay after an injected close failure.
- Switches persist the transition before tab removal and checkpoint restored IDs/placeholder IDs as they are created. This reduces duplicate restoration after a worker restart, but actual Chrome/Brave session behavior and final-window handling still require browser tests.
- The popup, full-page manager, and side-panel path are implemented with local scripts only. Page-derived titles and URLs are rendered with `textContent`; a static resource test checks manifest paths, local scripts, and absence of `innerHTML` injection.
- Group movement and deletion now use journaled browser effects. Pending deletion records are excluded during startup reconciliation so still-open deleted tabs are not adopted into the fallback group.
- Brave's official help page names `brave://settings/braveContent` for Container settings and Settings > Content > Containers for management. The manager links there and to the help page while stating that HiddenTabby cannot inspect or assign Container membership. Sources: https://brave.com/blog/containers/ and https://support.brave.app/hc/en-us/articles/39077103885325-How-do-I-use-Containers-in-Brave

## Final Static Verification (2026-10-14)

- The New Tab placeholder requirement is explicit in `REQUIREMENTS.md`: every open window without active-group tabs keeps one ungrouped placeholder; navigating it joins the active group, and restoring a group tab removes it.
- `npm test` and `npm run test:coverage` pass all 60 tests. Coverage is 85.66% lines, 77.14% branches, and 82.12% functions.
- `node --check` passes for popup, manager, service worker, controller, and packaging JavaScript; `git diff --check` passes.
- `npm run package` creates `dist/HiddenTabby.zip`; `unzip -t` passes and the archive contains the manifest plus all 13 declared runtime resources.
- A fresh-profile Chromium smoke retry with crash handling disabled still exits 133 at the restricted Crashpad socket before loading the extension. Playwright is not installed in the alternate Node REPL, and the available Brave UI surface is an existing profile; it was left unchanged. Actual Chromium/Brave acceptance remains open.
- The installed Codex CLI is v0.162.1. A bounded `codex --no-daemon --sandbox workspace-write --ask-for-approval never` attempt opened the CLI TUI but exited with a read-only-filesystem error before executing its prompt. Adding `--ephemeral` was rejected by the interactive CLI parser. Thus no-daemon browser behavior is still untested; this environment cannot launch a separate writable CLI session to run it.

## Packaged Browser E2E Results (2026-10-14)

- The earlier conclusion that isolated browsers could not launch was superseded after the user bypassed the command sandbox. A Node built-in test harness now launches the installed browsers with disposable profiles and loads the packaged ZIP over Chrome DevTools Protocol. No Playwright/Puppeteer dependency was added.
- Chromium 154.0.8037.97 (Arch Linux package) and Brave Browser 155.1.97.56 both pass `npm run test:e2e` / `npm run test:e2e:brave` respectively: two scenarios each, covering packaged extension behavior and same-profile browser restart. Brave's CDP user agent reports Chrome/155.0.8059.40.
- The main scenario covers real tab/window/group/session/storage operations, duplicate-tab identity and manual order restoration, inactive-group close/restore, placeholder behavior, manager move/delete, native context-menu registration, side-panel opening, and Default recovery. The restart scenario confirms persisted groups and active selection survive browser relaunch; it opens and uses the real action-popup target, exercises worker termination and natural idle suspension/wake, and closes the final normal window in Chromium.
- The manager's 1280px and 390px layouts have no horizontal overflow. Chromium's accessibility tree exposes the create action; Brave's snapshot omits dynamically rendered group controls despite their explicit DOM `aria-label` values, so the delete label is verified in the DOM. Screenshots are stored under ignored `test-results/`.
- This is headless browser automation. The action popup is opened with `chrome.action.openPopup()` and the side-panel manager is opened via its browser API, but the suite does not click the toolbar icon or select a tab-strip menu item. It does not cover headed side-panel visuals, incognito-enabled access, worker termination during destructive operations, installation over existing native groups, or Brave Container context preservation. Chromium closes its final normal window and restores the dormant snapshot; Brave 155 keeps its last normal window open when `windows.remove` is called in this headless run, so that behavior remains a headed check. See `task_plan.md`.

## Browser Regression: Restored Tab Order (2026-10-14)

- The real-browser suite showed that Brave restored two same-URL sessions as distinct tabs but reversed their live tab-strip order. Its recently-closed records reported the same index for both entries, so session metadata could not distinguish their original positions.
- After restoring a group's tabs, the controller now orders managed tabs explicitly by saved indexes, after pinned tabs. Chromium and Brave preserve this order within native tab groups.
- Added `tabs.onMoved` tracking so manual tab-strip rearrangements update each managed tab's saved index. The browser suite now reorders duplicate tabs, switches away, and verifies their new order and last-active selection on restore.
- A related Chromium API edge is covered: `windows.create` can return a placeholder with an empty `url` and the extension URL only in `pendingUrl`. The adapter reuses that pending placeholder instead of creating a duplicate.
- `chrome.action.openPopup()` opens the action-popup target in both installed browsers, and a trusted input event creates a group there without activating it. A second trusted input event opens the side-panel manager in both browsers and the page loads. After all extension debugger connections are detached, both MV3 workers enter idle suspension and wake on the next popup state request.

## Brave Controls Regression Check (2026-10-14)

- A direct `brave://settings/braveContent` anchor was ignored when activated inside the extension page in headed Brave. Opening the same URL through `chrome.tabs.create()` from the service worker works; Brave canonicalizes it to `chrome://settings/braveContent`.
- The settings action now uses that worker route. Brave detection uses `navigator.brave.isBrave()`; the DevTools product string still says Chrome in Brave 155, so E2E derives its expected browser from the configured executable path.
- A packaged Brave E2E click with trusted browser input opens the settings page. Chromium confirms the Container controls stay hidden. The tests wait for asynchronous detection and manager rendering before checking the UI.
- Headed popup open/dismiss, native tab-strip destination selection, and side-panel appearance were verified in both browsers. Chromium also passed headed first-run adoption of three pre-existing tabs; packaged incognito exclusion with extension access enabled now passes in both Chromium and Brave.
- A follow-up headed settings-link run was not completed: reloading the extension in an older test-owned Brave profile led Brave to block its unpacked extension page. That profile was closed. The packaged Brave click regression is the verified result; no user browser profile was touched.
- The first-run adoption path is now also exercised against pre-existing native groups in both packaged browsers: two prior groups are replaced by one Default group after clearing only the extension's local state and restarting its worker. This validates the initializer in a controlled profile; a separate browser-profile migration/upgrade scenario is still out of scope.
- An integration regression found that a restricted saved URL replaced with New Tab was not reflected in the restored tab snapshot. The controller now stores the actual restored URL/title. Coverage includes expired-session saved-URL fallback, restricted-URL fallback, and partial restoration with one failed tab preserved.

## Native Tab-Group Close Prompt (2026-10-15)

- The exact “Close tab and delete group?” dialog shown by the user is Chromium's native tab-group deletion prompt. Its source includes the confirmation and “Don't ask again” checkbox: https://chromium.googlesource.com/chromium/src/%2B/4f528b54f816ac7071a3063fe6719fb074058e08%5E%21/.
- It is separate from Brave Containers, which isolate cookies/site data and are managed through Brave settings: https://support.brave.app/hc/en-us/articles/39077103885325-How-do-I-use-Containers-in-Brave.
- HiddenTabby applied native groups even to a one-tab workspace/window. A native singleton group can produce that browser confirmation when its only tab closes. The chosen implementation keeps the singleton logically assigned while removing its native group; 2+ matching tabs still receive normal native tab-strip grouping. The logical workspace survives tab closure.
- Browser tests confirm the new close behavior in Chromium 154 and Brave 155. Native tab grouping is a visual aid and has no equivalent label for a singleton.
