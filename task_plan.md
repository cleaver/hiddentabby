# Group Window Lifecycle Plan

## Goal and Scope

Make each HiddenTabby group restore its useful windows and close windows the selected group does not need. Keep windows with pinned tabs open. User-closed content must not return through later group switches. This is part of the planned 0.2.x work.

No designated main window, single-window mode, or new settings UI. This document tracks the implementation in reviewable slices and defines a verification gate for each.

## Agreed Behavior

1. A group's layout is the set of logical windows with meaningful unpinned tabs belonging to that group. Reuse existing logical window identities; window labels are not browser IDs.
2. Switching saves the outgoing group's meaningful content, restores the destination group's needed windows, and closes unnecessary physical windows. Windows shared by both layouts stay open and have their group tabs switched.
3. A window with any pinned tabs stays open during switching. Pinned tabs remain outside groups, retain their pinning/order, and do not make that window a saved member of an otherwise empty group.
4. A group/window containing no unpinned tabs, only extension placeholders, or only recognized browser New Tab pages is not saved as part of that group's layout. Apply this cleanup when saving/switching, not by closing a blank window while the user is working in it.
5. Extension placeholders are never saved group content. Proposed detail: ordinary browser New Tab tabs may remain alongside meaningful tabs in an otherwise useful window; a New-Tab-only window is omitted. Do not classify a page by its title.
6. Navigating a placeholder/New Tab to a meaningful page adds content to the active group. Respect pending navigation so a tab loading a real URL is not discarded as blank.
7. User-closing a nonfinal window permanently removes the actual group tabs being closed. Preserve inactive groups' saved content associated with the same logical window. Retain dormant window metadata only while other group content or recovery operations still reference it.
8. Extension-driven window closure during switching preserves outgoing group content. Intent must be written before closing anything and recognized by both tab/window lifecycle handlers, including after worker restart.
9. When switching to an empty group, keep an existing pinned window usable; if none exists, retain or create one temporary window with an excluded placeholder. This is temporary browser continuity, not a main-window role or remembered layout.
10. Before automatic closure could remove the last usable normal window, establish a destination window or temporary placeholder window. Create it without stealing focus unnecessarily; focus an appropriate destination window when switching completes.
11. Incognito and nonnormal windows remain excluded. Local-only storage and existing permission scope remain the baseline.

## Final Window / Browser Exit Policy

User approved preserving tabs when the final normal browser window closes. A window close while other normal windows remain is treated as explicit closure of that window and forgets its visible group tabs. The final-window policy covers the final window only; do not imply that closing several windows one by one preserves every one of them. Test this distinction in Chromium and Brave and document the supported guarantee.

## Implementation Steps and Verification Gates

Each step is one reviewable increment. Add a failing test for the behavior, implement the smallest coherent change, then pass that step's checks before proceeding. Repeat a step when failures reveal additional cases. Mark completed work here and record commands/results in progress.md. Do not commit, tag, push, or release unless requested.

### 1. Establish the lifecycle contract and regression cases
Status: complete. Dependencies: agreed behavior above; final-window preservation is approved.

- Reproduce the user's four-group scenario with Default using two windows and Group 3 owning a third window.
- Add expectations that user-closing Group 3's window forgets its tab, preserves Default's two-window layout, and never recreates the deleted third window.
- Separate tests that currently require all window closes to preserve snapshots into user closure, extension closure, and shutdown/restart cases.
- Classify meaningful pages, extension placeholders, and browser New Tab pages using current/pending URLs. Confirm the URL variants through unit cases now and Chromium/Brave browser profiles in step 7; treat unknown/custom pages conservatively.
- Verification: observe the new regression fail on the baseline; run focused Node tests for classification and close semantics. Include a legitimate page titled New Tab, pending navigation, a mixed content/New Tab window, pinned-only windows, and duplicate URLs.

### 2. Unify user-close handling
Status: complete. Dependencies: step 1.

- Add one pure transition for user window closure, shared by tab-removal and window-removal handling.
- Remove records for the tabs actually closed, using stable record identities captured before browser IDs are cleared. Preserve inactive snapshots, even when they share the logical window.
- Make processing idempotent across multiple tab events, duplicate events, and window events delivered before or after tab events.
- Extend startup capture to window-close intent where needed, retaining the previous tab-close fix and durable-write ordering.
- Verification: focused unit/controller tests cover warm and cold workers, repeated/reordered events, inactive snapshots sharing a logical window, final-window preservation, and a startup write failure followed by retry. Default's other saved windows remain intact.

### 3. Plan group window layouts explicitly
Status: complete. Dependencies: steps 1–2.

- Extend the pure switch planner to calculate windows to reuse, open, retain for pinned tabs, close, and temporarily retain for continuity.
- Derive membership from group/window tab records; avoid duplicating a persistent membership list unless implementation proves it necessary.
- Prune only blank-only group/window content; keep meaningful inactive snapshots and separate tabs with identical URLs. Do not delete a window's records merely because the currently selected group does not use it.
- Keep stable logical identities distinct from session-specific physical browser IDs. Garbage-collect unused dormant records only when no group or pending operation references them.
- Verification: planner tests for A(two windows) → B(one) → A(two), groups with disjoint layouts, shared windows, blank-only windows, pinned exceptions, empty groups, cross-window tab moves, and no remaining references to removed windows.

### 4. Execute window switching with durable recovery
Status: complete. Dependencies: step 3.

- Extend journal payloads with logical/physical window identities, expected closed tab identities, and progress for window creation/removal.
- Add browser-adapter window-close support if needed. Snapshot outgoing content and persist intent before any destructive browser call.
- Reuse shared windows; establish needed destination windows before removing the final outgoing window. Restore tabs with existing session/URL fallback and saved order.
- Recheck live tabs, pending navigation, and pin state immediately before automatic closure. If the user adds/pins a tab before the request is issued, recompute the affected close plan.
- Treat already-created/already-closed windows as completed work on replay. Map new browser IDs back to logical windows; avoid reopening a window the user explicitly closed during restoration.
- Verification: adapter/controller fault injection at each durable boundary, failed window creation/closure, partial restore failure, a worker stop between browser success and checkpoint, rapid A→B→A requests, and manual close/pin/create during switch preparation. Recovery must not duplicate windows or tabs or revive deleted content.

### 5. Complete pinned, empty-group, and interaction behavior
Status: complete. Dependencies: step 4.

- Keep pinned windows open even when the destination has no content there. Avoid adding a placeholder when pinned tabs already provide a usable tab.
- Allow pinning/unpinning and moving a tab to change useful window membership on the next switch. Automatically close an unused unpinned window only as part of switching/cleanup, not simply when a user opens a blank window.
- Resolve which surviving/restored destination window to focus without introducing a persistent main-window role. Preserve last-active tab selection where available.
- Ensure switching still completes if it closes the window containing the popup, manager, or sidebar that initiated the command.
- Verification: interaction tests for pin/unpin, pinned-only and mixed windows, zero-content groups, all windows becoming unnecessary, manager-window closure, and continued service-worker execution after its initiating UI disappears.

### 6. Reconcile existing storage and restart behavior
Status: complete. Dependencies: steps 4–5; apply the approved final-window policy above.

- Reuse the current schema when possible; if journal/window changes require a new schema, add explicit migration and version validation before use.
- Remove old blank-only saved memberships without dropping meaningful tabs or legitimate duplicates. Preserve unknown meaningful content conservatively; do not infer that a stale saved duplicate was user-deleted merely from its URL.
- Reconcile browser-restored windows against saved logical identities, pending operations, and captured explicit removals. Missing live windows alone are not proof of intentional deletion.
- Implement and document the approved final-window policy. Verify normal browser exit, explicit final-window close, reopening, and crash-like termination separately; record platform limitations.
- Verification: persisted fixtures from current storage, browser ID changes, restart with and without browser session restoration, pending operations from the old version, startup events in different orders, and every supported shutdown case.

### 7. Run packaged real-browser acceptance tests
Status: complete. Dependencies: steps 1–6.

- Extend disposable-profile E2E coverage to the user's exact four-group scenario and the two-window → one-window → two-window round trip.
- Assert actual browser windows/tabs, saved state, pinned-tab survival, and absence of deleted content. Count meaningful windows separately from pinned exceptions and any temporary empty-group surface.
- Exercise browser New Tab variants, window/tab X closure, worker shutdown/wakeup during switching, session restoration, and duplicate URLs. Test the manager window closing itself during a switch; verify selected-tab activation in browser E2E and explicit destination-window focus selection in controller and adapter tests.
- Verification commands: npm test; npm run test:e2e; npm run test:e2e:brave; git diff --check. Run package-integrity checks already included by the repository. Record headless limitations; this runner has no graphical display, and headless Chromium reported multiple windows as focused, so desktop-level foreground focus cannot be verified here.

### 8. Update documentation and review completion
Status: complete. Dependencies: step 7.

- Update README.md and docs/architecture.md to replace universal window preservation and always-visible placeholders with the agreed group-window lifecycle.
- Add the user-visible change to CHANGELOG.md under Unreleased when implementation is made. Document pinned exceptions, ignored blank-only windows, manual-close behavior, shutdown policy, and existing page-state restoration limitations.
- Review manifest/package changes; require justification for any new permission or packaged file. Confirm no main-window concept or single-window preference has entered the feature.
- Verification: check documentation against the acceptance cases below; review the complete diff and record passed checks and limitations. Leave version bumps/tags/releases for an explicit release request.

## Acceptance Checklist

- [x] Default with two useful windows → one-window group → Default restores exactly its original two useful windows.
- [x] Closing Group 3's third window forgets that group's closed tab; later switching never recreates it.
- [x] Inactive group tabs sharing a closed physical window remain available to their own group.
- [x] Every window with pinned tabs stays open during switching, without making it a member of unrelated groups.
- [x] Unpinned blank-only windows do not return as saved group windows.
- [x] A pending meaningful navigation is never mistaken for a blank-only window.
- [x] Empty groups remain usable without persistent main-window state or accumulating placeholders.
- [x] User close versus extension-driven switch closure remains correct across warm/cold workers, event ordering, interruption, and retry.
- [x] Browser startup/shutdown behavior matches the explicitly selected policy and documented platform evidence.
- [x] Existing stored groups and genuine duplicate tabs survive migration/reconciliation correctly.
- [x] Chromium and Brave acceptance checks pass; documentation and changelog match behavior.

## Current Planning Status

All eight implementation slices are complete. The final-window preservation policy is approved. The document reflects tested behavior for mixed New Tab windows, pinned windows, empty groups, user-closed windows, and crash-like profile recovery. Browser-reported focus selection is tested, but desktop-level foreground focus remains unverified because this runner has no graphical display; headless Chromium reports inconsistent focused-window state.

## Errors Encountered

The first packaged Chromium run exposed stale E2E expectations about preserving nonfinal user-closed windows and adding placeholders beside pinned tabs. The tests and behavior were aligned with the agreed lifecycle rules. Recovery testing also found that a storage checkpoint error after creating a window was being swallowed; checkpoint failures now leave the operation journaled for startup recovery.
