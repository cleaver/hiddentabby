# Tab duplication investigation findings

## Scope and confidence

The user reported one tab unexpectedly duplicated during group switching. The audit traced the production controller, browser adapter, state store, tests, architecture documentation, and previous fixes. Five disposable simulations using the real controller/store demonstrated possible duplication; no capture identifies the user's actual incident and real browser event timing has not been verified.

## Findings

1. Restart matching: findSnapshot first uses live browser ID, then exact URL with title constraints. Changed IDs plus changed title can create a new live record while the old record becomes closed and later restores. Relevant: src/workspace-controller.js, findSnapshot and #reconcile.
2. Pin race: switch preparation clears browserTabId. The close adapter excludes pinned tabs; pin handling removes membership by browser ID and can miss the closed outgoing record. Relevant: switchGroup prepare, onTabUpdated, src/group-state.js assignTab, src/chrome-browser.js removeTabs.
3. Checkpoint failure: the restore catch includes the durable checkpoint after browser success. It can collect the storage error and allow journal completion; later matching can miss the live counterpart. Relevant: #performGroupSwitch restore loop and StateStore.runJournaled.
4. Open twin: onTabCreated chooses a general candidate before requiring it to be a closed active-group snapshot. An open closer twin can hide the eligible closed record, producing a new record when an external restoration was fulfilling the closed one. This depends on restoration provenance; a genuine new user-created duplicate should remain a separate tab.
5. Move/cleanup failure: after session restore into another window, a failed move triggers cleanup whose rejection is ignored, then creates fallback content while the original remains. The simulated path returned no restore failure.

## Shared design weakness

Saved records lose or fail to recover a unique association with live tabs across asynchronous browser work. Separate causes are ambiguous matching, early identity clearing, and incomplete handling of partial success. The state validator forbids two records sharing a live browser ID but cannot detect one closed snapshot plus a newly adopted live record representing the same original tab.

## Existing protections to preserve

- Snapshot adoption on created events; duplicate URLs intentionally remain separate identities.
- Journaled browser mutations, serialization, startup removal capture, and planned-close reconciliation.
- Final-window preservation, nonfinal user-window deletion, logical window keys, and pinned-tab protection.
- Existing commits include 2988765 (manual-close snapshots), 1bfa3ee (startup removals), and 929276c (snapshots on group window close).

## Audit verification from the preceding turn

- npm test: 133 passing, zero failures.
- Five standalone diagnostic simulations demonstrated the failure outcomes. They used synthetic event/failure conditions; the production adapter and browser semantics must be incorporated in permanent regressions.
- The disposable harness was /tmp/hiddentabby-audit.mjs. It is temporary and not a durable dependency of this plan.

## Recovery constraints

URL/title equality is not proof that two records are accidental duplicates. Browser IDs can change after a full browser restart. Without a supported durable browser identity mechanism, an acknowledgement lost between creation and persistence can remain ambiguous. Prevent blind retry and preserve content rather than automatically deleting or merging ambiguous records.

## Implementation outcome

- Startup reconciliation now prefers one-to-one active-group URL matches across browser ID and title changes.
- Group switching rechecks live tabs after the browser close adapter returns. If a requested outgoing tab is still pinned, its exact saved snapshot and close intent are removed.
- Restore/create attempts are journaled with a live-tab baseline before the browser side effect. Retries reconnect one unambiguous new matching tab. An uncertain result, failed durable checkpoint, or failed move/cleanup keeps the operation pending and avoids another create.
- A failed checkpoint regression now dispatches `onTabCreated` before the operation unwinds; recovery removes the temporary duplicate record and reconnects the tab to the saved record.
- An out-of-band browser restore with an open identical twin remains unresolved when it has the same observable URL/title/window/index as a genuine new tab. The implementation preserves intentional duplicate tabs and makes no claim that the reported user incident is proven to be this path.
- Verification: 140 unit/integration tests pass; packaged Chromium and Brave suites each pass all 6 tests. Brave had one transient DevTools evaluation timeout on its first full run; the isolated case and full rerun passed.
