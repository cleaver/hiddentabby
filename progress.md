# Progress: prevent duplicate tabs during switching

## 2026-10-21 — Plan prepared

- User requested a fix plan following an audit and discussion of shared versus independent causes.
- Applied the pi-planning-with-files skill. No active root planning files existed; previous window-lifecycle plans are archived under docs/plans/.
- Reviewed the prior lifecycle plan and carried forward deliberate-duplicate preservation, manual-close semantics, durable operation ordering, and Chrome/Brave acceptance requirements.
- Created task_plan.md with six ordered implementation slices, verification gates, compatibility treatment, and explicit ambiguity handling.
- Recorded the five audit scenarios and evidence limits in findings.md.
- Planning only: no implementation or new test runs in this turn. Prior audit reported 133 passing tests and five standalone failure probes.
- Next action upon implementation request: step 1, permanent regression cases with realistic adapter and event behavior.

## 2026-10-21 — Initial implementation

- User asked to start implementation; began the plan's regression-first slices.
- Added controller integration regressions for restart with changed tab IDs/titles, pinning during outgoing close, retry after a failed restore checkpoint and worker restart, create acknowledgement loss, redirected uncertain outcomes, failed move/cleanup, and preserving a genuine same-URL tab beside a saved duplicate.
- Startup reconciliation now prefers the active group's one-to-one URL match even if the title changed.
- Group switching now removes a pinned outgoing record after observing live browser state following the close request.
- Each restore persists a single per-tab attempt with the pre-restore tab IDs. Retry reconnects a unique newly opened matching URL even if title changes. A failed save after a browser side effect leaves the operation journaled; uncertain or multiple results defer recovery instead of creating another tab.
- Session move failure now requires verified removal before URL fallback. Failed cleanup or verification leaves the operation journaled.
- Updated architecture rules and Unreleased changelog.
- Focused check: `node tests/integration/workspace-controller.test.js` — 77 passing, 0 failing.
- Full npm and packaged Chromium/Brave checks remain.
- One audit case remains inherently ambiguous: an externally restored tab and a genuinely new tab may have the same URL/title/window/index. The implementation preserves legitimate duplicate records and does not merge tabs from URL similarity alone. Operation-owned restores are tracked by journaled baseline; unowned external events may still require a conservative follow-up policy.
- Errors encountered: initial regression tests failed as expected; one test assertion incorrectly counted the outgoing tab after closure and was corrected to assert absence of fallback creation. No unresolved tool errors.

## 2026-10-21 — Recovery implementation and browser acceptance

- Persisted one restore attempt at a time in the switch journal before browser restore/create calls, with the destination window and live-tab baseline. A retry adopts one new matching tab; ambiguous or redirected outcomes stay journaled and stop before another create.
- Moved the post-restore state checkpoint outside the ordinary per-tab browser-error catch so storage failure keeps the operation pending. Added reconciliation for a create API that rejects after creating the tab.
- Required verified cleanup after a session restore lands in the wrong window and movement fails. Cleanup failure or uncertain tab-query results keep the original tab and journal for retry.
- Reconciled pinned outgoing tabs against live browser state after the close adapter returns, removing the precise saved snapshot when the adapter leaves it open.
- Added a delayed `onTabCreated` event to the failed-checkpoint regression. It first exposes the transient extra record, then restart recovery folds it back into the journaled snapshot.
- Verification: `npm test` — 140 passing; `npm run test:e2e` — 6 passing in Chromium; `npm run test:e2e:brave` — 6 passing in Brave; focused controller regression — passing; `git diff --check` — passing.
- Brave's first full run had one DevTools `Runtime.evaluate` timeout in the inactive-window test. That test passed alone, and the full Brave suite passed on rerun.
- Remaining limit: without browser-provided restore provenance, an out-of-band restored tab can be indistinguishable from a user-created tab with the same URL/title as an open twin and a closed snapshot. We preserve both rather than merge based only on URL/title. This does not identify which path caused the user's reported incident.
