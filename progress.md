# Progress Log

## Session: 2026-10-14

### Phase 1: Requirements & Discovery
- **Status:** complete
- Actions taken:
  - Inspected the fresh extension scaffold.
  - Reviewed the official Simple Tab Groups listing and Chrome/Brave extension documentation.
  - Sent the user preference questions about first-version scope, group switching, window behavior, and future Brave Container support.
  - Wrote REQUIREMENTS.md with provisional scope and open questions.
  - Checked Brave's native Containers documentation and its extension-integration issue; updated the requirements draft with the API limitation and future integration option.
  - Recorded the user's preference for both future Brave Container features: show each tab's Container and open or move tabs into a chosen Container, contingent on a supported API.
  - Recorded the user's choice to keep the first release focused on the core group manager.
  - Recorded close-and-restore switching and groups shared across windows; researched the Chrome Sessions API and documented the page-state limitation and `sessions` permission.
  - Interpreted the user's preference as global switching across windows; confirmed Chrome native groups are window-scoped, so logical shared groups need per-window membership tracking.
  - Recorded both manager surfaces, requiring core popup usability on small screens, and extension-side Container definition management if an official API becomes available.
  - Recorded local-only storage, incognito exclusion, a recent-release browser baseline, pinned-tab exclusion, the tab-strip move-to-group action, and the popup-to-full-page management flow.
  - Confirmed the Chrome contextMenus and tabs.group APIs can implement a tab-strip right-click move action; added `contextMenus` to the planned permission set.
  - Recorded first-run creation of a `Default` group, assignment of existing unpinned tabs, active-group assignment for new tabs, and non-activating group creation.
  - Recorded that first-run assignment replaces existing native group membership for unpinned tabs.
  - Recorded group deletion as closing all member tabs with a count-bearing warning, and moving a tab to an inactive group as closing it without switching groups.
  - Confirmed there must always be a `Default` group; deleting the final `Default` creates a fresh empty one, while tabs closed by deletion remain closed and unassigned.
- Files created/modified:
  - REQUIREMENTS.md
  - task_plan.md
  - findings.md
  - progress.md
- Core requirements are collected. Deleting the active group returns all windows to `Default`; deleting the final group leaves a fresh, empty `Default` active.

## Test Results

No tests run; this phase is requirements research only.

## Error Log

| Error | Attempt | Resolution |
|-------|---------|------------|
| User-input tool rejected a field named question | 1 | Reissued using title and options. |
| apply_patch rejected a stale reference URL context | 1 | Corrected the URL context and reapplied the documentation update. |

## 5-Question Reboot Check

| Question | Answer |
|----------|--------|
| Where am I? | Phase 1, collecting requirements. |
| Where am I going? | Resolve design choices, then draft agreed requirements. |
| What's the goal? | Define a practical Chrome and Brave extension inspired by Simple Tab Groups. |
| What have I learned? | See findings.md; Firefox-style hiding is absent in Chrome APIs, and Brave Container integration lacks a documented extension API. |
| What have I done? | Researched upstream features and updated REQUIREMENTS.md with the Brave Container limitation. |

## Implementation Planning

- Completed the requirements-discovery phase and replaced the coarse task plan with 12 executable steps and per-step verification gates.
- Confirmed Linux-only initial support with the user.
- Checked official Playwright, Puppeteer, and Chrome testing documentation; inventoried Node/npm and the Brave executable.
- Included unit, fault-injected integration, real-browser integration/UI E2E, native UI/manual compatibility, accessibility, restart/recovery, stress, and packaged-artifact checks.
- Explicitly separated planned commands from currently available tooling and Chromium results from branded-browser sign-off.
- Queued unresolved lifecycle policies, including exact Default naming semantics, for Step 2 rather than treating previous assumptions as user confirmation.
- This turn changed planning documentation only. Browser executables were inventoried but not launched; no implementation tests ran.
- Next action: Step 1, prove the browser harness and installation paths.

### Browser inventory correction

- Confirmed installed Chromium at `/usr/bin/chromium` (154.0.8037.97 Arch Linux) and Brave at `/usr/bin/brave` (155.1.97.56) using successful version commands.
- Corrected the earlier Chromium inventory error and updated Step 1 to test both installed browsers. Extension loading and automated browser tests have not run yet.

### Browser acceptance scope

- User accepted Chromium as a proxy for Chrome. Updated requirements and implementation gates to require Chromium and Brave on Linux, removing the separate Google Chrome verification requirement. No browser tests ran for this documentation change.

### Window placeholder behavior

- User chose to keep windows open during global switching with a New Tab placeholder when the active group has no tabs in that window.
- Recorded it as a temporary ungrouped anchor: promote it into the active group on navigation and remove it when restoring a group tab. Updated requirements and verification steps; implementation has not started.
- A combined documentation patch missed a stale insertion context. Re-read current lines and applied a corrected patch.
- Browser smoke attempt: isolated CLI launches of Chromium and Brave did not expose DevTools or initialize their temporary profiles; both logged a restricted Crashpad socket operation. The cause is unresolved and the smoke gate remains open. No user browser profile was touched.
- A direct Chromium launch without remote debugging exited with code 133 and the same restricted Crashpad socket error. The command sandbox currently blocks the browser-smoke gate; continue domain work, but do not claim actual-browser verification.

## Goal Work: State Model

- Created `src/group-state.js` with pure group/tab/window transitions and `tests/unit/group-state.test.js` using Node's built-in test runner.
- Added package scripts without runtime dependencies and documented architecture/lifecycle defaults and acceptance IDs in `docs/architecture.md`.
- Unit coverage includes first-run assignment, native group replacement, group edits, global switch plans, placeholder promotion/removal, pin/unpin, inactive moves, tab/window closure, Default protection/replacement, duplicate URLs, and seeded transition invariants.
- The first tests exposed placeholder planning's mismatch between stable logical window IDs and transient browser window IDs; added an explicit adapter-boundary identity and regression coverage. A stale test assumption around pinned-only windows was corrected to reflect the user's placeholder choice.
- Current verification: `npm test` passes 16 tests. Browser execution remains unavailable; no real-browser tests have passed.
- Next: Step 4, local storage adapter and fault-injected recovery tests. Keep Step 1 open and reattempt browser verification only through a safe isolated environment.

## Goal Work: Durable State Store

- Added `src/state-store.js` with a Chrome storage adapter, schema validation, v0-to-v1 migration, serialized writes, and a durable operation journal/replay path.
- Added `tests/integration/state-store.test.js` for missing-state initialization, migration, corrupted/future versions, failed writes, side-effect ordering, replay after interruption, and concurrent updates.
- Expanded `npm test` to run unit and integration suites. Current result: 23 tests pass.
- Resolved test failures encountered while building the model: placeholder/window ID comparison now uses the browser ID only at API boundaries; window-close snapshots remain dormant; pinned-only windows follow the selected placeholder behavior; pinning removes an existing group record.
- Step 4 browser storage/restart verification remains open with Step 1. No code path has been tested in the installed browsers yet.
- Next work: continue browser-independent event/controller design, then return to browser launch compatibility before E2E or release acceptance.

## Goal Work: Live Tabs and Global Switching (2026-10-14)

- Added `src/chrome-browser.js` for normal-window discovery, native tab-group replacement/update, sessions helpers, placeholders, tab-strip move menus, and safe unpinned tab removal.
- Added `src/workspace-controller.js` and the MV3 service worker. First run adopts existing unpinned tabs into `Default`; later tabs and unpinned tabs join the active group. The controller tracks pinning, navigation, tab activation, tab attachment, placeholder promotion, and window/tab closure.
- Implemented journaled global switching across windows. It saves intent before closing tabs, creates placeholders when required, restores by Sessions API ID with URL fallback, reapplies native groups, restores each window's last active tab, and checkpoints browser effects for replay.
- Added controller and service-worker fake-adapter integration tests, including two-window close/restore, pinned-tab survival, empty group placeholders, and restart recovery after injected close failure.
- Verification: `npm test` passes 43 tests; `node --check` passes for the service worker/controller; a manifest parse/resource check confirms the declared worker and popup exist.
- Browser gate: no actual Chrome/Brave verification has passed. Installed Chromium/Brave versions are documented above, but isolated launches still fail with the sandbox Crashpad restriction; no personal browser profile was used.
- Current step: implement tab movement and the native context-menu workflow. Step 1, real storage, actual Sessions behavior, browser UI, Brave compatibility, and packaging gates remain open.

## Goal Work: Moves, Deletion, and Manager UI (2026-10-14)

- Implemented durable moves from the tab-strip menu and full-page manager. Moving to an inactive group saves the tab/session and closes it without switching; saved snapshots can be moved by stable record ID. Moving the last active-group tab leaves the selected window anchored by an ungrouped placeholder.
- Implemented warned group deletion with live/saved counts, active-group fallback, and a fresh empty `Default` when needed. Pending delete operations exclude their target tabs during restart reconciliation, preventing a tab from being reassigned after an interrupted delete.
- Replaced the starter popup with group switching and non-activating creation. Added a responsive full-page manager for group edits, ordering, colors, deletion, and tab movement. The manager is reusable in the optional side panel and links to Brave's Container settings and help; it does not claim Container awareness or control.
- Added static resource/security checks for manifest paths, local scripts, inline event handlers, and safe text rendering. README now documents install, behavior, permissions, restore limitations, tests, and the browser verification status.
- Verification: all six configured test files pass; 54 test cases are declared across unit and integration files. `node --check` passes for popup, manager, service worker, and controller JavaScript. `git diff --check` passes.
- Browser gate: actual popup, side panel, native tab menu, Chrome storage, session restore, and Brave behavior remain unverified. The installed executables are known, but process launch remains blocked by the command sandbox; no personal browser profile was touched.
- Current step: harden interrupted-operation/concurrency paths, add measured stress checks where useful, then package and run the final static gate. Keep Step 1 and all real-browser acceptance gates open.

## Goal Work: Placeholder and Final Static Gate (2026-10-14)

- Confirmed the requested New Tab placeholder behavior is already in requirements and implementation: one ungrouped placeholder per open window with no tabs in the selected group; navigation promotes it, and restoring a real group tab removes it.
- Final verification: `npm test` and `npm run test:coverage` pass 60/60 tests; coverage is 85.66% lines, 77.14% branches, and 82.12% functions. JavaScript syntax checks and `git diff --check` pass.
- Rebuilt `dist/HiddenTabby.zip`; `unzip -t` passes and the archive includes the manifest and all 13 declared runtime resources.
- Repeated the isolated Chromium smoke test with a clean `/tmp` profile and crash handling disabled; it exits 133 at the restricted Crashpad socket before extension startup. Playwright is unavailable in the alternate Node REPL. The surfaced Brave browser is an existing profile, so no extension was installed or browser state changed.
- Steps 2–12 browser-independent work is complete. Step 1, live Chromium/Brave integration and UI acceptance, and packaged-artifact browser acceptance remain open pending a browser runner that can launch an isolated profile.

## Packaged Browser Verification Update (2026-10-14)

- The user bypassed the command sandbox, and the installed headless browsers launched with disposable profiles. This supersedes the earlier browser-launch blocker above; no personal Brave profile was used.
- Platform: Manjaro Linux, kernel 6.12.108-1. Installed binaries report Chromium 154.0.8037.97 and Brave Browser 155.1.97.56. The Brave E2E DevTools user agent reports Chrome/155.0.8059.40.
- `npm run test:e2e`: 2/2 packaged-artifact E2E scenarios pass in Chromium. `npm run test:e2e:brave`: 2/2 pass in Brave. Each command rebuilds `dist/HiddenTabby.zip` and uses disposable profiles.
- The main scenario verifies first-run Default state, real `chrome.storage.local`, popup-page creation/switching, pinned tabs, two-window native groups, global close/restore with Sessions, empty-window placeholders and promotion, manager tab moves, context-menu registration, deletion confirmation/cancellation, and Default fallback.
- The restart scenario closes the test browser, relaunches the same profile, and verifies stable group IDs, active group, stored state, and startup reconciliation.
- Before browser shutdown, both browsers also pass a worker-lifecycle check: CDP stops the MV3 service-worker target after a durable group write, then an extension message wakes the worker and reads the saved state.
- The browser suite also checks the manager accessibility tree for named create/delete buttons and asserts no horizontal overflow at desktop width and 390px.
- Visual artifacts: `test-results/chromium-manager.png`, `test-results/chromium-manager-narrow.png`, `test-results/brave-manager.png`, and `test-results/brave-manager-narrow.png`. Wide and narrow layouts were visually reviewed.
- `npm test`: 63/63 unit and fake-adapter integration tests pass. `npm run test:coverage`: 63/63 pass; 86.56% line, 78.55% branch, and 82.48% function coverage.
- Final checks: `node --check` passes for runtime, packaging, and E2E JavaScript; `unzip -t dist/HiddenTabby.zip` passes with the manifest and 13 runtime resources.
- Remaining acceptance: headed toolbar popup, actual tab-strip menu selection, side-panel opening, incognito-enabled profile, idle worker suspension, worker termination during close/restore/delete, browser final-window closure, installation over multiple pre-existing/native-group tabs, Container-context handling, and the remaining lifecycle/failure cases in `task_plan.md`. The E2E opens extension pages in tabs and does not claim these native UI checks.
- Stopped the detached Chromium process from the aborted side-panel attempt after verifying it used only the dedicated `/tmp/hidden-tabby-real-chromium-20261014` profile; that profile process family is now gone.

## Goal Work: No-Daemon Chromium Diagnostic (2026-10-14)

- Rechecked installed CLI and browser versions: Codex CLI 0.162.1, Chromium 154.0.8037.97, Brave 155.1.97.56.
- A direct Chromium run with a fresh temporary profile and `--no-first-run` still exits 133 with Crashpad `setsockopt: Operation not permitted`.
- Tried a bounded Chromium smoke from `codex --no-daemon`. The CLI opened its TUI but failed with a read-only-filesystem error before running the prompt. A retry with `--ephemeral` was rejected as an unknown option for the interactive CLI. No browser test ran through no-daemon mode.
- The original unit/integration/package evidence remains valid. Live browser and packaged-artifact acceptance remain incomplete; this goal stays active while we pursue an execution environment that can launch an isolated browser.

## Brave Settings Link and Headed UI Verification (2026-10-14)

- Fixed the Brave Container settings action after headed Brave showed that a direct `brave://` link did not navigate from the extension page. The manager now requests the fixed settings URL through the service worker, which opens it with `tabs.create`; Brave-only settings/help controls are identified with `navigator.brave.isBrave()` and hidden in Chromium. CSS explicitly honors the `hidden` attribute.
- Added an integration regression for the service-worker command and E2E assertions for browser-specific visibility plus a trusted click in Brave that opens `chrome://settings/braveContent` (Brave canonicalizes the `brave://` URL). Chromium confirms both Container controls stay hidden.
- The first Brave assertion exposed that its DevTools product string says Chrome. The test now derives the expected browser from the executable path and waits for asynchronous detection and manager rendering before asserting.
- Latest `npm test`: 67/67 pass. Latest `npm run test:coverage`: 67/67 pass; 86.85% lines, 78.81% branches, and 83.25% functions. `git diff --check` passes.
- Latest packaged E2E: `npm run test:e2e` passes 2/2 in Chromium 154.0.8037.97; `npm run test:e2e:brave` passes 2/2 in Brave 155.1.97.56. Both exercise the packaged artifact and use disposable profiles. Brave's main scenario clicks the settings control with trusted browser input and confirms the settings page opens.
- Headed Chromium and Brave: clicked the actual toolbar icon, opened and dismissed the action popup with Escape, selected an actual tab-strip move destination, and opened the side-panel manager. Visual captures are `/tmp/hiddentabby-headed-sidepanel.png` and `/tmp/hiddentabby-headed-brave-sidepanel.png`. The native tab move closed the live tab and saved it under the chosen destination.
- Headed Chromium setup checks: a fresh profile adopted three pre-existing unpinned tabs into Default. After enabling extension access in Incognito, a private tab/window remained absent from HiddenTabby's model and state.
- I did not rerun the settings click in headed Brave after the UI repair: reloading the extension in an older disposable profile caused Brave to block its unpacked extension page. The packaged Brave E2E verifies the fixed click with trusted browser input. The disposable profile was closed; the user's Brave profile was never used.
- Still open at that checkpoint: active Container context, Brave headed final-window closure, interruption during destructive operations, selected browser API failures, and CI host selection. See `task_plan.md`.

## Existing Native Group Adoption Regression (2026-10-14)

- Extended the packaged-browser scenario to create four tabs across two pre-existing native tab groups, confirm HiddenTabby tracks them, clear only `hiddentabby.state`, and stop its service worker. The next state request exercises the real first-run initializer.
- Verified that Chromium and Brave move all four unpinned tabs into a single native group titled `Default`, remove the old group titles, and rebuild the local model with every tab assigned to the new Default group.
- Targeted verification passed in both engines: `node --test --test-name-pattern='packaged HiddenTabby manages real Chromium tabs and windows' tests/e2e/browser.test.js` and the same command with `BROWSER_BIN=/usr/bin/brave`.
- After adding the scenario, the full `npm run test:e2e` and `npm run test:e2e:brave` runs also pass 2/2 each, including restart persistence.
- This tests the missing-state first-run path with browser-created native groups in a disposable packaged-extension profile. It does not claim a separate browser-profile migration or upgrade run.

## Incognito Exclusion in Both Browser Engines (2026-10-14)

- Added a packaged E2E that installs the extension in a disposable profile, enables its Incognito preference, restarts the browser, creates a real private window/tab, and checks the browser APIs can see them while HiddenTabby stores neither their IDs nor URL.
- Targeted checks and the complete three-scenario E2E suites pass in Chromium 154.0.8037.97 and Brave 155.1.97.56.

## Final Core Acceptance and Restore Fallback Fix (2026-10-14)

- A regression test found that when a browser refused a saved restricted URL and HiddenTabby opened New Tab instead, the visible tab changed but its stored snapshot kept the restricted URL. The controller now records the restored tab's actual URL and title.
- Added controller integration tests for expired Sessions entries reopening from the saved URL, restricted browser URLs falling back to New Tab, and partial restoration preserving the failed snapshot while restoring the remaining tabs.
- `npm test` and `npm run test:coverage` pass 69/69. Coverage is 87.14% lines, 79.05% branches, and 83.25% functions.
- After the controller fix, `npm run test:e2e` passes 3/3 in Chromium 154.0.8037.97 and `npm run test:e2e:brave` passes 3/3 in Brave 155.1.97.56. The scenarios cover core tab/group flows, pre-existing native-group adoption, incognito exclusion with extension access enabled, Brave settings navigation, and browser restart.
- `npm run package` creates `dist/HiddenTabby.zip`; `unzip -t` and `git diff --check` pass. No temporary browser profiles or helper processes remain, and the desktop accessibility setting was restored to its original value.

## Browser Order Regression and Final Verification (2026-10-14)

- Reproduced Brave restoring duplicate-URL sessions in reverse tab-strip order. Both recently-closed entries had the same session index, even though HiddenTabby retained separate stable records. Added saved-order normalization after restore and `tabs.onMoved` tracking for manual rearrangements.
- Added a controller integration case for updating all indexes in a window and a packaged-browser case that reverses two duplicate tabs, switches away, and verifies their new order and last-active choice after restoring. Also added a pending-URL placeholder regression after Chromium returned `{url:"", pendingUrl:placeholderUrl}` from `windows.create`.
- Final packaged E2E: `npm run test:e2e` passes 2/2 in Chromium 154.0.8037.97; `npm run test:e2e:brave` passes 2/2 in Brave 155.1.97.56 (CDP Chrome/155.0.8059.40). Both use disposable profiles, regenerate `dist/HiddenTabby.zip`, and capture manager screenshots in `test-results/`.
- Final unit/integration gate: `npm test` passes 66/66. `npm run test:coverage` passes 66/66 with 86.85% line, 78.76% branch, and 83.20% function coverage. `unzip -t dist/HiddenTabby.zip` passes with the manifest and 13 runtime files.
- Cross-browser accessibility detail: Chromium's DevTools accessibility tree exposes the manager's create action; Brave's AX snapshot omitted dynamically rendered group controls despite their explicit DOM labels. The E2E checks the delete label directly in the DOM and keeps the create-action tree check.
- Both runs open the action-popup document through `chrome.action.openPopup()` and create a non-active group using trusted input. Both open the side-panel manager page from a trusted popup input. With debugger connections detached, both service workers suspend naturally and wake to read stored state.
- Chromium closes all normal windows through the worker API, retains a closed tab snapshot, and recreates the logical window/tab when the group is restored. Brave 155 reports the final normal window still open after `windows.remove` in headless mode; its non-final window close/recreate path passes.
- Still open: clicking the toolbar icon itself, native tab-strip context-menu selection, headed side-panel visuals, incognito-enabled profile, worker termination during destructive operations, installation/upgrade over pre-existing native groups, Brave Container context, and selected API failure/recovery cases. The automated suite never uses the user's existing browser profile.

## Native Last-Tab Group Dialog Regression (2026-10-15)

- Diagnosed the screenshot's “Close tab and delete group?” prompt as Chromium's native tab-group dialog. It is not HiddenTabby's delete-group confirmation or a Brave Containers prompt. Chromium uses this exact wording for a native group; Brave Containers isolate site data and do not represent HiddenTabby groups.
- Refined the behavior: a single live tab remains assigned to its HiddenTabby group but is native-ungrouped. Native grouping applies when at least two same-workspace unpinned tabs share a window. Closing the singleton removes its tab record/window membership and preserves the logical workspace. The tradeoff is that a singleton has no native tab-group label until another tab joins.
- Added adapter/controller regressions for close, pin, move, and cross-window membership changes; packaged E2E exercises a real 2-to-1 transition and verifies the restored tab remains in Default without a native group.
- Final verification after the controller bookkeeping fixes: `npm test` passes 71/71; `npm run test:e2e` passes 3/3 in Chromium 154.0.8037.97; `npm run test:e2e:brave` passes 3/3 in Brave 155.1.97.56 (CDP Chrome/155.0.8059.40). Both browser suites load the packaged extension from disposable profiles and cover restart persistence. Screenshots remain under ignored `test-results/`.
- See `REQUIREMENTS.md`, `docs/architecture.md`, and `task_plan.md` for the behavior and acceptance criteria.

## Stale Tab Restore Regression (2026-10-15)

- Reproduced a timing bug in a controller integration test: an individually closed tab could disappear from the live browser before its delayed removal event, while a group switch had already snapshotted it as an outgoing tab. The pending switch ignored that event as an expected close, leaving a stale snapshot that could restore the closed tab later.
- The switch now reconciles its planned closes against live tab IDs in still-open windows and removes missing snapshots before issuing browser closes. A journal marker distinguishes this pre-close reconciliation from recovery after a close request has begun, preserving intentional switch snapshots. Closed-window snapshots remain eligible for restoration.
- Added integration coverage for the delayed removal race and stricter packaged-browser assertions for exact snapshot/live-tab sets plus manually closed tab absence. The reported duplicate restoration did not reproduce in the real-browser round trips.
- Verification: `npm test` passes 72/72; `npm run test:e2e` passes 3/3 on Chromium 154.0.8037.97; `npm run test:e2e:brave` passes 3/3 on Brave 155.1.97.56 (CDP Chrome/155.0.8059.40); `git diff --check` passes.

## Manual Close During Switch Regression (2026-10-15)

- Directly closing the MadCSS tab in an isolated browser, restarting the service worker, and switching away and back did not reproduce the report. The tab record disappeared and stayed gone in Chromium and Brave.
- A controller regression test reproduced a narrower race: if a tab closes while a global switch is preparing, HiddenTabby previously classified its removal as part of the planned switch close before the browser close request had been issued. The stale snapshot then remained eligible for restore.
- The controller now records removals that arrive before an operation issues its close request, reconciles them against live tabs, and removes those records from the journaled restore payload. Events after the request remain recoverable. The same reconciliation covers tabs moved to an inactive group.
- Verification: `npm test` passes 74/74; packaged Chromium and Brave E2E each pass 3/3, including MadCSS tab close, service-worker restart, group round-trip, and manual-close-during-move checks; `git diff --check` passes.
