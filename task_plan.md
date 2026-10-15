# HiddenTabby Implementation and Verification Plan

## Goal and Status

Deliver the agreed Chromium/Brave group manager in `REQUIREMENTS.md`, initially on **Linux only**. Core requirements and packaged-browser acceptance pass in both browsers; remaining non-core follow-ups are explicitly scoped in Step 12.

**Current implementation step:** Step 13, native last-tab close behavior. Full packaged suites pass 3/3 in Chromium 154 and Brave 155 after verifying singleton tabs remain logically assigned but native-ungrouped; the refined requirement and browser-source diagnosis are recorded below.

## Iteration Protocol — Apply to Every Step

1. Select a small acceptance scenario from the current step and define its expected browser/storage outcome.
2. Add a meaningful failing test when implementing behavior; for environment/documentation work, define a reproducible check instead.
3. Implement the smallest complete change and run the step's verification gate.
4. On failure, reproduce, fix, and rerun the affected checks. Add a regression test for a newly discovered bug. Do not make retries hide failures.
5. Run the existing fast suite and affected real-browser scenarios before marking the step complete. Run the full suite at the integration/release gates.
6. Record commands, browser/OS versions, results, and artifact locations in `progress.md`. Record limitations and decisions in `findings.md`. Continue until every acceptance item passes; report an unavailable check as blocked, never passed.

## Itemized Steps

### 1. Prove the browser harness and platform behavior

- [x] Implement: Set up development-only unit/integration tooling with Node's built-in test runner and a dependency-free CDP harness for disposable browser profiles. The extension package remains dependency-free.
- [x] Investigate: Ran the packaged extension from `/usr/bin/chromium` and `/usr/bin/brave`; Chromium is the accepted Chrome proxy. The custom Node/WebSocket CDP harness was sufficient, so Playwright/Puppeteer were not added.
- [x] Verify smoke and core API behavior: `npm run test:e2e` and `npm run test:e2e:brave` each pass three packaged-artifact scenarios. They inspect extension pages, exercise real tabs/windows, storage/sessions/native grouping and Incognito exclusion, and save screenshots.
- [x] Verify headed popup and native tab-strip behavior: Click the toolbar action, dismiss the popup with Escape, and use the real tab context menu to move a tab in Chromium and Brave.
- [x] Verify headed side panels: Open and visually inspect the manager in both browsers; screenshots are in `/tmp/hiddentabby-headed-sidepanel.png` and `/tmp/hiddentabby-headed-brave-sidepanel.png`.
- [x] Verify Chromium setup edges: Adopt three pre-existing unpinned tabs into Default and enable incognito access to confirm private tabs remain outside HiddenTabby state.
- [x] Verify first-run initialization over existing native groups: In packaged Chromium and Brave, create two old native groups, clear only HiddenTabby's stored state, stop its worker, then verify all unpinned tabs join one new Default native group.
- [x] Verify incognito exclusion with extension access enabled: The packaged Chromium and Brave E2E suites create real private windows/tabs and confirm their IDs and URLs remain outside HiddenTabby's model/state.
- [x] Scope final-window closure: Chromium exercises closing/restoring after the last normal window; Brave 155 retains its final window in the headless API test. This is a browser shutdown edge, not part of HiddenTabby's global group switch, which preserves windows with placeholders.
- **Gate:** Packaged E2E passes in both installed browsers. The remaining browser setup and lifecycle checks are listed in Steps 5, 6, 10, and 12. Browser launch was made possible after the user bypassed the sandbox; earlier Crashpad failures are historical.

### 2. Specify state, invariants, and lifecycle policies

- [x] Implement: Document logical groups, tab snapshots, per-window membership, active/last-active tabs, schema versioning, browser API boundaries, and durable operation records. Treat browser tab/window/session IDs as transient and keep extension-owned identities.
- [x] Resolve: Set implementation defaults for manual tab closure, whole-window closure, pin/unpin, browser-created New Tabs, placeholder identity, and startup reconciliation. The user chose an ungrouped placeholder whenever a window has no tabs in the selected group; navigation promotes it and a restored group tab removes it.
- [x] Verify: Write an acceptance matrix mapping every requirement to test IDs. Review sample traces for first run, two-window switching, moving to an inactive group, and deleting the last group. Every managed tab has exactly one owner; pinned/incognito tabs are excluded; deleted records cannot be restored by stale operations.
- **Status:** complete. Lifecycle defaults and acceptance IDs are documented in `docs/architecture.md`; unit traces pass in Step 3.

### 3. Build and test the group domain model

- [x] Implement: Pure JavaScript operations for group creation, rename, ordering, color, membership, active-group changes, and deletion. Use stable IDs rather than names as identity. Creating a group must not activate it.
- [x] Verify: Table-driven unit tests for valid/invalid input, duplicate names/URLs, empty groups, active-group deletion, and final-group replacement with an empty `Default`. Add deterministic generated operation sequences that assert membership and active-group invariants after each action.
- **Status:** complete. The latest `npm run test:coverage` run passes all 69 unit/integration tests; see `progress.md` for coverage.

### 4. Implement local persistence and restart-safe operations

- [x] Implement: A storage adapter, schema validation/migration, serialized mutations, and durable operation checkpoints. Save recoverable snapshots before closing tabs. Record deletion intent so interrupted operations cannot resurrect deleted groups. Handle quota/write errors before destructive calls.
- [x] Verify: Fault-injected tests cover rejected writes, malformed/future data, migration, concurrent mutations, interrupted operations, and replay. A failed durable write is proven to prevent the external effect.
- [x] Verify in browser: The packaged E2E reads/writes real `chrome.storage.local`; a second scenario cleanly closes and relaunches the same disposable profile and verifies group IDs, active group, and stored state.
- **Status:** implementation and browser persistence/restart checks pass in Chromium and Brave. Operation-failure replay remains covered by fault-injected integration tests.

### 5. Implement first-run assignment and live tab tracking

- [x] Implement: The MV3 service worker and listeners for tab creation, activation, navigation, removal, pinning, and tab attachment. First run assigns all existing normal unpinned tabs to `Default`; subsequent new unpinned tabs join the active group. Reconcile browser state with storage after startup.
- [x] Verify with fakes: First-run adoption, pinned/incognito exclusion, restart reconciliation, placeholder promotion, and tab/window close behavior pass in `tests/integration/workspace-controller.test.js`.
- [x] Verify in both packaged browsers: Startup Default assignment, new-tab assignment, pinned exclusion, title updates, pin/unpin, duplicate URLs, manual tab closure, window closure/recreation, and placeholder navigation/promotion/removal were exercised against real tabs. Browser restart retains saved group definitions.
- [x] Verify first-run with multiple existing tabs: A fresh Chromium profile assigned all three pre-existing URLs to Default and grouped the live tabs.
- [x] Verify first-run over existing native groups: The packaged Chromium and Brave suites created two old groups, reset HiddenTabby storage/worker state, and confirmed initialization replaced both with Default.
- [x] Verify incognito exclusion with extension access enabled: Chromium and Brave can see the private tabs, but HiddenTabby state omits their IDs and URLs.
- [x] Scope external native-group edits after initialization: HiddenTabby owns its logical group definitions; the agreed first-run behavior replaces existing native group assignment and is verified in both browsers.
- **Status:** Core tracking, first-run adoption, pinning, Incognito exclusion, and lifecycle behavior pass in Chromium and Brave.

### 6. Implement global close-and-restore switching

- [x] Implement: A serialized global switch coordinator: persist outgoing state, close its unpinned tabs, restore the selected group, reconstruct per-window native groups, and restore last-active-tab selection. Prefer session IDs; use saved URLs when sessions expire or cannot be matched. Recreate missing windows according to Step 2's policy.
- [x] Verify with fakes: Two-window switching, pinned-tab survival, empty-group placeholders, restored-tab grouping, and recovery after an injected close failure pass in `tests/integration/workspace-controller.test.js`.
- [x] Verify in both packaged browsers: Global A→B→A switching over two windows, pinned-tab survival, session-backed restore, duplicate URL identity, original and manually changed tab order, last-active selection, empty-window placeholders, placeholder navigation, and a return switch all passed.
- [x] Verify restore fallbacks and races: Integration tests cover expired Sessions entries using saved URLs, restricted URLs falling back to New Tab, partial restoration preserving failed snapshots, tab create/removal races, rapid switches, and injected close failure recovery.
- [x] Verify placeholder behavior: Empty windows retained one ungrouped placeholder; navigation promoted it, and restoring group tabs removed it.
- [x] Verify final-window lifecycle in Chromium: An external extension worker closes all normal windows, the final active-group tab is retained as a dormant snapshot, and switching back recreates its logical window and tab. Brave 155 keeps its final normal window open in the headless API test; this browser shutdown edge is scoped under Step 1.
- **Status:** Core packaged switching, placeholders, expired-session fallback, restricted-URL handling, and partial restore recovery pass; exact mid-call worker termination is scoped under Step 11.

### 7. Implement moving tabs and native context-menu actions

- [x] Implement: Move to the active group without closing; move to an inactive group by saving and closing immediately without switching. Generate destination menu entries from current groups and exclude pinned/incognito tabs. The manager can also move saved snapshots by stable record ID.
- [x] Verify with fakes: Tests cover the clicked tab ID, stale destinations, pinned tabs, session capture/restore, placeholder behavior after moving the final active tab, and persistence failure before close.
- [x] Verify registration: Both browser E2E runs confirm the root and per-group tab-context menu entries are already registered. The manager UI also moves a real tab into an inactive group and the browser closes/restores it as intended.
- [x] Verify native interaction: In headed Chromium and Brave, right-click an actual tab-strip tab and choose a destination; confirm the tab closes and is saved under that group.
- **Status:** API registration, manager movement, and actual native menu selection pass in both browsers.

### 8. Implement warned group deletion and the empty fallback

- [x] Implement: The manager confirmation shows the group name and live/saved counts. Cancellation leaves state unchanged. Confirmed deletion journals removal, closes live member tabs, clears snapshots, and maintains the `Default` fallback without reassigning tabs.
- [x] Verify with fakes: Tests cover active/final-group deletion, the empty `Default` fallback, and recovery that never adopts a tab back after an interrupted deletion.
- [x] Verify in both packaged browsers: Canceling Default deletion preserves it; confirming closes its live tabs and creates an empty active Default; deleting the final inactive group leaves its tabs closed and unassigned.
- [x] Verify remaining cases: Integration tests cover active non-Default deletion, recovery after a failed close, and browser API close failures; packaged E2E confirms warning/cancel/confirm and both active and inactive group deletion outcomes.
- **Gate:** Deleted tabs stay closed and are absent from extension records after recovery. User-driven browser history/session restore is outside this guarantee; the extension does not erase history.

### 9. Deliver popup and full-page management/settings

- [x] Implement: Popup switching, non-activating group creation, and a full-page manager/settings link. The manager supports group create/rename/reorder/color/delete and moving open or saved tabs. Errors are announced, and the page adapts to narrow screens.
- [x] Verify statically: Manifest/page resource checks, local-script checks, safe DOM rendering checks, and JavaScript syntax checks pass.
- [x] Verify core UI flows in both packaged browsers: The popup page creates and switches groups; manager controls move and delete tabs; browser storage and tab outcomes are asserted.
- [x] Verify action popup in both packaged browsers: `chrome.action.openPopup()` opens the actual action-popup target; a trusted browser input creates a group and confirms it stays inactive.
- [x] Verify headed popup behavior: Clicking the toolbar icon opens the action popup in Chromium and Brave; Escape dismisses it.
- [x] Scope extended UI polish: Name validation and group invariants are tested; long-name visual review, duplicate-submit behavior, and full keyboard/focus review are follow-ups beyond the agreed core release checks.
- [x] Verify visual/accessibility basics: Wide and 390px manager screenshots have no horizontal overflow; the accessibility tree exposes the create action and the delete button carries a group-specific `aria-label`; static checks cover safe DOM text rendering. Brave's DevTools accessibility snapshot omits the dynamic group controls, so the delete label is checked in the DOM.
- [x] Scope full accessibility audit: Automated semantic/name checks and responsive layouts pass; a manual WCAG audit is a later release-hardening task.
- **Status:** Core page UI, responsive sizing, accessible labels, and headed popup open/dismiss pass; extended polish is scoped as follow-up.

### 10. Add optional side panel and honest Brave integration

- [x] Implement: Reuse the manager in the optional side panel and fall back to the full page when unavailable. Provide a direct Brave Container settings link and official help link. The manager states that Container awareness/management needs a supported extension API.
- [x] Verify capability-present behavior: Chromium and Brave expose `chrome.sidePanel.open`; a trusted input on the popup action opens the side-panel manager page in both packaged browsers.
- [x] Verify headed appearance: The manager side panel opens and was visually checked in Chromium and Brave.
- [x] Verify Brave settings link: The packaged Brave E2E clicks the Brave-only control with browser input and observes the Container settings page open; Chromium confirms both Container controls stay hidden.
- [x] Scope capability absence: Both tested browser versions provide the Side Panel API; the popup always retains a full-page manager link if that API is missing.
- [x] Scope Container context: The requirement is conditional on a supported API. Brave does not expose Container membership to extensions, so HiddenTabby links to native settings/help and makes no context-management claim. Revisit when the API exists.
- **Status:** Side-panel display and Brave settings navigation pass. Container context management is explicitly unavailable until Brave provides a supported extension API.

### 11. Exercise recovery, concurrency, and scale

- [x] Implement: Journal checkpoints, dynamic operation payloads resolved inside the serialized store queue, restart reconciliation for changed tab/window IDs, and recovery handlers for switch/move/delete.
- [x] Verify with fakes: Regression tests cover interrupted closes/deletes, stale-ID recovery, rapid A→B→A switching, rapid moves, duplicate URL session matching, concurrent storage operations, and deterministic model sequences.
- [x] Verify fake scale: A 10/100/500-tab close/switch case passes. One local Node run measured 1.02 ms, 4.94 ms, and 30.77 ms respectively; these are fake-adapter timings, not browser performance claims.
- [x] Verify worker termination after persistence: Both packaged browser runs stop the MV3 service-worker target after a group write, wake it with a state request, and verify the state remains available.
- [x] Verify browser restart: Both packaged browser runs close and relaunch the same disposable profile, then confirm persisted group state and startup reconciliation.
- [x] Verify idle suspension: With extension page and worker debugger connections closed, both browsers terminate the MV3 worker after its idle period; reopening the popup wakes it and reads persisted state.
- [x] Verify recovery paths: Fake-browser tests inject close/delete failures and restart the controller to replay durable operations; browser E2E covers worker termination/wake, idle suspension, and profile restart.
- [x] Scope exact mid-call worker termination: The harness does not kill the worker at an instruction boundary inside a live browser API call; durable checkpoint/replay tests cover the recovery contract.
- **Status:** Persistence, interruption recovery, worker wake/suspension, and profile restart are verified at the adapter and browser levels.

### 12. Automate release gates and verify the packaged artifact

- [x] Implement: Added `npm run package`, which creates `dist/HiddenTabby.zip` from an explicit allowlist of runtime files and excludes tests, tooling, and documentation.
- [x] Verify packaged artifact: `unzip -t dist/HiddenTabby.zip` passes; the archive contains the manifest and 13 runtime resources. `npm run test:coverage` passes 69 tests; current coverage is recorded in `progress.md`.
- [x] Scope hosted CI: No CI provider or remote is configured. Local unit, coverage, package, Chromium, and Brave commands are documented; add a hosted workflow after the project selects a provider.
- [x] Verify packaged E2E: Chromium 154 and Brave 155 each pass all three scenarios for startup/native-group takeover, incognito exclusion, global switching, sessions, movement/deletion, Brave settings, and restart persistence.
- [x] Verify native browser UI: Toolbar icon/popup open and Escape dismissal, native tab-menu selection, and headed side-panel visuals pass in Chromium and Brave.
- [x] Verify Chromium setup: Incognito-enabled access excludes private tabs; three existing unpinned tabs join Default on first startup.
- [x] Scope remaining non-core release cases: External native-group edits after startup and a full keyboard/WCAG audit are deferred; API close/delete failure and interruption recovery are covered by integration tests.
- [x] Deliver: Update README with installation, behavior, restore limitations, permissions, test commands, and troubleshooting. Preserve the existing `AGENTS.md` under the user's no-modification instruction; place new testing instructions in README or dedicated docs.
- [x] Deliver browser evidence: Record installed browser versions, packaged E2E results, and wide/narrow manager screenshots in `progress.md`.
- **Gate:** All agreed core requirements pass in Chromium and Brave. Container membership control is unavailable at the browser API boundary; hosted CI and deeper accessibility review remain project follow-ups. No publishing is included.

### 13. Refine last-tab close behavior and avoid the native group prompt

- [x] Diagnose: The “Close tab and delete group?” dialog is Chromium/Brave's native tab-group deletion dialog, not HiddenTabby's delete confirmation and not Brave Containers.
- [x] Specify: Closing a group's last tab in one window removes only that tab/window's HiddenTabby membership and preserves the logical group. A singleton remains HiddenTabby-managed but is native-ungrouped.
- [x] Implement: Apply native groups only when 2+ managed tabs from one HiddenTabby group share a window. Reconcile after close, pin, move, and cross-window transfer so a singleton is ungrouped and can be closed without deleting a browser group.
- [x] Verify regressions: Adapter/controller tests cover singleton grouping and membership shrink; packaged Chromium 154 and Brave 155 suites pass 3/3, including an actual browser check after switching away and restoring a singleton.
- **Status:** complete. `npm test` passes 71/71; browser artifact and version evidence is in `progress.md`.

## Test Layers and Evidence

| Layer | Purpose | Tools/evidence |
|---|---|---|
| Static/resource checks | Syntax, manifest/resources, permission/CSP mistakes | Node checks; development-only linting if justified; package inspection |
| Unit | Pure transitions, invariants, validation | `node:test`, table-driven and seeded generated cases |
| Adapter integration | Event ordering, persistence, recovery, failure paths | Controllable fake browser/storage ports; explicit fault injection |
| Real-browser integration | Actual tabs/windows/groups/sessions/storage behavior | Node `node:test`, Chrome DevTools Protocol WebSocket, packaged extension, disposable profiles and local fixture |
| UI E2E | Extension-page controls through to actual browser outcomes | CDP page evaluation, eventual assertions, accessibility tree and screenshots |
| Native browser compatibility | Tab-strip menus, real popup and side panel | Headed Chromium/Brave; runner-driven when supported, manual checklist otherwise |
| Accessibility/visual | Keyboard use, semantics, popup/small-screen layout | Automated accessibility checks, screenshots, human review |
| Lifecycle/stress | Worker/browser restarts, race conditions, scale | External controller, restart tests, seeded/repeated scenarios, timings |

Mocked integration is not evidence of real browser compatibility. Chromium is the user-approved proxy for Chrome; Brave still requires its own compatibility checks. Opening `popup.html` in a tab is not proof of toolbar popup behavior.

## Available Commands and Test Layout

- `npm test` — complete unit and fake-adapter integration suite.
- `npm run test:unit` — pure domain tests and generated invariants.
- `npm run test:integration` — adapter/event/recovery tests.
- `npm run test:e2e` — packaged-artifact Chromium E2E in a disposable headless profile.
- `npm run test:e2e:brave` — the same packaged-artifact scenarios in installed Brave.
- `npm run test:coverage` — unit/integration coverage report; investigate regressions in destructive/recovery paths.
- `npm run package` — assemble the distributable extension excluding tests, profiles, and tooling.

Keep tests under `tests/unit/`, `tests/integration/`, `tests/e2e/`, and `tests/fixtures/`; keep browser diagnostics in ignored `test-results/`. Each test maps to an acceptance ID and asserts observable behavior. Never run destructive tests in a personal browser profile. Separate cases by profile; serialize cases within a profile. Use event/condition waits rather than arbitrary sleeps.

Capture failing test name, seed, OS/browser versions, console/extension errors, trace/screenshots where supported, and sanitized test-state snapshots. CI may rerun for diagnosis, but unexplained initial failures remain actionable. No live external sites/accounts are required for the automated suite.

## Completion Checklist

- [x] Requirements discovery completed; remaining lifecycle policies are explicitly queued in Step 2.
- [x] Iterative implementation and verification plan written.
- [x] Linux-only initial support confirmed by the user.
- [x] Core steps 1–13 implemented and verification recorded; non-core follow-ups are explicitly scoped below.
- [x] Packaged-artifact Chromium and Brave core acceptance evidence recorded.
- [x] Full native-UI and lifecycle acceptance matrix passed or explicitly narrowed.

## Previous Planning Errors

| Error | Resolution |
|---|---|
| User-input tool rejected an unsupported field | Reissued with the supported schema. |
| Documentation patch used stale context | Re-read exact text and corrected the patch. |
