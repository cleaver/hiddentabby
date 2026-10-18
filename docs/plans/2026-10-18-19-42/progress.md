# Group Window Lifecycle Progress

## 2026-10-18 — Planning
- Read repository guidelines and planning skill.
- Confirmed clean working tree before planning.
- Collected the user's window-lifecycle requirements and excluded a main-window concept.
- Reviewed existing window storage, switch behavior, close handling, and previous regression coverage.
- The user approved preserving tabs when the final normal browser window closes; closing a window while others remain forgets its visible group tabs.
- Created planning documents; no runtime code changed and no tests run for this documentation task.

- Completed the itemized implementation plan with eight increments, a verification gate for each, and an acceptance checklist.
- Included pinned-only windows, blank/pending navigation classification, user-versus-extension close intent, warm/cold workers, interruption recovery, migration, empty groups, and popup/manager closure.
- Recorded the API limitation around shutdown intent and kept the final-window policy open pending the user's answer.
- Runtime code and tests remain unchanged; implementation is pending.

## 2026-10-18 — Implementation started
- Re-read the plan and implementation targets.
- Began slice 1 with URL-based meaningful-tab classification tests.

- Slice 1 RED: added the four-group nonfinal-window-close regression; baseline fails because Group 3's saved tab returns.
- Slice 1 GREEN: added `isMeaningfulTab()` classification for placeholders, Chromium/Brave New Tab URLs, pending navigation, pinned tabs, and unknown pages; its focused unit test passes.
- Browser URL observation and full scenario remain scheduled for real-browser acceptance in step 7.
- Slice 2 is now in progress.

## 2026-10-18 — Slice 2: user-closed window handling
- Unified window-close transitions so a final normal-window close preserves group snapshots, while a nonfinal user close removes the active group's content for that logical window and keeps inactive-group snapshots.
- Covered tab-removal-before-window-removal and the reverse order, duplicate late events, worker startup with the window already gone, and a failed startup write followed by durable retry.
- Focused unit/controller verification passed; full `npm test` passed 90 tests after the startup retry case, and `git diff --check` passed. Step 2 is complete.

## 2026-10-18 — Slice 3: explicit group-window planning
- Added failing planner tests for a two-window group switching to a one-window group and back, shared windows, blank-only windows, pinned windows, empty groups, and duplicate URL snapshots.
- The tests initially failed because the planner did not return window operations and restored New Tab records.
- Added `closeWindowIds`, `recreateWindowIds`, empty-group continuity planning, pinned-window retention, and `discardTabIds`. Blank-only records are omitted from the planned state; mixed windows keep meaningful tabs and genuine duplicate URLs.
- Preserved pending navigation URLs when adopting/updating tabs so a loading page is not discarded based on its old New Tab URL. Extension placeholders are filtered through the browser adapter predicate.
- Full `npm test` passes 96 tests; `git diff --check` and syntax checks pass. Step 3 is complete; Step 4 (durable physical window execution) is now in progress.

## 2026-10-18 — Slices 4–8: window execution, recovery, acceptance, and docs
- Added durable switch journaling for logical-window creation and closure, including replay after worker interruption and checkpoint failures. Destination windows are established before closing outgoing windows; shared windows are reused.
- Added live pin-state checks before closure, pinned-window retention without extra placeholders, cleanup of blank-only windows, and temporary continuity for empty groups. Closing the manager/popup that initiated a switch no longer prevents the service worker from completing it.
- Applied the approved shutdown rule: a final normal-window close preserves useful snapshots; closing a nonfinal window forgets its active-group tabs while leaving inactive-group snapshots intact. Closed logical-window metadata is collected only after all snapshots and operations release it.
- Extended unit, adapter, controller, recovery, and packaged browser tests for window layout, New Tab classification, manual closure, pinned tabs, creation/close failures, restart/retry, manager-initiated switching, and duplicate tab identities.
- Updated README, architecture notes, and the Unreleased changelog to describe the implemented window behavior and browser-specific test limitation.
- The completion audit added explicit destination-window focus selection through `windows.update({focused:true})`, with adapter and controller tests. The Chromium E2E confirms the manager window can initiate a switch and close, and that a selected-group tab is active afterward.
- Added a crash-like recovery gate: the disposable Chromium/Brave profile is forcibly stopped with SIGKILL after state is persisted, then reopened and checked for the final-window snapshot. The restart test passes in both browsers.
- Final verification: `npm test` passes 119 tests; packaged Chromium E2E passes 3/3; packaged Brave E2E passes 3/3; `git diff --check` and JavaScript syntax checks pass. `npm run package` creates the 20-file ZIP, and `unzip -t` reports no errors. The E2E suite loads that ZIP in disposable profiles. Chromium exercised final-window closure and restoration. Brave headless keeps its final normal window open, so that specific close path is unavailable in the Brave run.
- Desktop-level foreground focus remains unverified: no graphical display or Xvfb is available, and headless Chromium reported multiple focused windows. The browser focus request is covered by controller and adapter tests.
- Implementation steps and agreed acceptance cases are complete with the limitations above documented. No version bump, commit, tag, push, or release was made.
