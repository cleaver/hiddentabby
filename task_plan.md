# Prevent duplicate tabs during group switching

## Objective and scope

Prevent duplicate creation in the deterministic switching and recovery paths found in the 2026-10-21 audit. Preserve intentional duplicate URLs, group ownership, pinning, window layout, and manual-close behavior. One out-of-band browser restore case remains ambiguous because the browser exposes no provenance distinguishing it from a user-created identical tab.

Implementation and browser acceptance are complete for the deterministic paths. The external-restore/open-twin ambiguity is documented as an unresolved limit rather than merged by URL alone.

## Required guarantees

1. A live browser tab belongs to at most one saved record, and a record has at most one claimed live counterpart. Reserve claims across the entire pending operation and already-open records, not just the current restore loop.
2. Title, index, and window position are matching hints, not durable identities. A title change alone must not turn a browser-restored tab into both a new record and a restorable old snapshot.
3. Maintain the original record-to-browser-ID association in the operation journal until an outgoing close, pin, user close, or move is resolved. Clearing a record's live ID must not make lifecycle events lose its identity.
4. Persist restore intent before the browser side effect. After an uncertain result or failed checkpoint, reconcile that attempt before another create or session restore.
5. A failed save after a successful browser action keeps the operation pending. Successful per-tab checkpoints survive retries, so completed restores are not repeated.
6. Fallback creation after failed movement requires confirmed cleanup of the restored tab. If the tab remains or its absence cannot be established, preserve its identity and retry recovery; do not create a second tab.
7. Match one-to-one without merging or deleting intentionally repeated URLs. Ambiguous identity remains unresolved and visible to the caller; a missing match is not automatically proof that another tab must be created.

## Implementation sequence

### 1. Turn the audit into reliable regression cases

Status: controller-level regressions and browser acceptance are complete; injected browser failures use the controller harness rather than the production adapter.

- Port the disposable audit probes into the integration suite, correcting synthetic browser assumptions where necessary. Exercise the production browser adapter together with the controller or use adapter-faithful API fakes.
- Add an event-capable harness that dispatches created, updated, attached, removed, and window events without blocking browser API responses on queued controller handlers. Provide deterministic barriers before/after browser actions and storage writes.
- Cover: changed IDs and title after restart; pin after switch preparation; creation success followed by failed checkpoint and a delayed created event; failed move followed by failed cleanup; and the guard that keeps a genuine same-URL user tab separate.
- Assert live tab counts, record counts, ownership, pinning, and journal state. The out-of-band external-restore/open-twin case cannot distinguish restoration from a genuine new tab with the same URL/title, so it remains explicitly ambiguous.
- Cover acknowledgement gaps separately: browser action completed but worker stops before saving its result, and browser action definitely rejected before making a tab.

Gate: each targeted baseline regression demonstrates the intended failure at the real call-site seam. Keep current manual-close and legitimate-duplicate cases passing.

### 2. Centralize identity resolution and live-tab claims

Status: partially implemented. Startup matching now prefers one-to-one active-group URL candidates across title changes, and restore recovery excludes already claimed live tabs. Matching policy is still spread across startup, event adoption, and operation recovery.

- Extract shared matching/claim logic used by startup reconciliation, created-tab adoption, and operation recovery. Keep browser calls in the existing adapter/controller boundaries; introduce a small pure module only if it reduces duplicated policy.
- Prefer exact live IDs and journal associations. For browser restart recovery, match within active-group and pending-operation ownership context, then logical windows, using one-to-one URL candidates and title/index as ranking hints. Preserve outgoing/inactive ownership established by pending closes.
- Handle current and pending URLs explicitly: a pending destination is meaningful; an old committed URL must not conceal it. Avoid broad URL normalization, which could merge distinct documents.
- Exclude tabs claimed by other records and re-evaluate claims during operation recovery. Ordinary creation of the same URL remains a new tab. An out-of-band restore event with an open identical twin remains ambiguous; automatic merging would also consume a genuine user-created duplicate.
- Define explicit match outcomes: matched, absent, ambiguous. Defer automatic creation on ambiguous recovery; retain the snapshot and return actionable failure details through the existing result mechanism.

Gate: restart with changing titles/URLs in flight does not grow record counts; genuine same-URL tabs and same URLs across groups/windows retain distinct ownership. Uncertain candidates are not silently reassigned or deleted.

### 3. Resolve outgoing tab lifecycle changes through the journal

Status: switch-time pin filtering is implemented and covered at the post-close boundary. Move/delete and cross-window lifecycle policy was not changed.

- Keep the original browser tab ID in the switch journal's close record after preparation clears it from the saved snapshot.
- Reconcile live pin state before close and again after the close adapter returns, when adapter filtering could have left a pinned tab open.
- Remove the precise outgoing snapshot and close intent when the post-close live query finds the tab pinned.
- Use the same identity policy for switch, move-to-inactive-group, and delete operations while respecting their different semantics. Explicit deletion must not resurrect a removed snapshot.
- Resolve manual close and cross-window attachment against current journal state; avoid stale handlers recreating obsolete records.

Gate: early/late pin events, pin/unpin, manual closure, and attachment races never leave a pinned tab's stale snapshot available for restoration. Existing startup-close fixes remain effective.

### 4. Make restoration and persistence recovery explicit

Status: implemented for the audited restore failure paths; broader fault injection at every browser call and durable write remains future coverage.

- Add durable per-record restore attempt state with record/window identity and a live-tab baseline. Persist intent before restoring/creating; the saved record continues to hold the intended URL and session ID.
- Record a live-tab baseline or equivalent provenance sufficient to distinguish pre-existing tabs from candidates created by an attempt within the same browser session. Baseline browser IDs are not durable across a full browser restart; use startup reconciliation there.
- Separate browser failures from checkpoint failures. A failed checkpoint after browser success must escape the per-tab best-effort catch and retain the operation journal. Do not count a restore as complete until its association is saved.
- On retry in the same worker or a fresh worker, reconcile attempts and claim surviving tabs first. Replay only unfinished work. A known open tab must never be selected for a different record.
- Model wrong-window restoration as a tracked live tab awaiting movement. If moving fails, retain the tab ID. Verify cleanup before fallback; if cleanup fails or is uncertain, retain the operation and expose the error.
- Define how partial failures return state without repeatedly mutating the browser on manager refreshes. Unresolved ambiguity must not spin forever, erase the journal, or permit a later switch to bypass unfinished recovery.
- Ensure recovery after a manual close respects explicit removal and cannot recreate the tab merely because its attempt was incomplete.

Gate results: checkpoint failure with a delayed created event, create acknowledgement loss, redirected uncertain outcome, and failed move/cleanup are covered. Full fault injection before/after every API call is not implemented.

### 5. Preserve compatibility and document recovery limits

Status: complete for additive journal compatibility and documentation. No state version or manifest permission change was needed.

- Prefer additive journal fields with safe defaults. Inspect old pending switch, move, and delete payloads; introduce a state version migration only if required by changed durable semantics. Test both completed old state and old interrupted operations.
- Do not automatically deduplicate existing snapshots by URL/title. Old corruption cannot always be distinguished from deliberate duplicate tabs. Preserve ambiguous saved content, and explicitly document that prevention does not prove historical repair.
- Update docs/architecture.md with identity, claims, pinning, partial-success, and ambiguity rules. Add a user-visible CHANGELOG.md entry under Unreleased when implementation lands.
- Keep current permissions and dependency-free runtime unless implementation demonstrates a concrete unmet requirement. Do not assume a browser API can attach custom durable identity to tabs without verifying platform support first.

Gate: old saved content and pending operations load without losing valid records; any ambiguity or unsupported historical repair is stated accurately.

### 6. Verify in Chromium and Brave

Status: complete. Full unit/integration and packaged Chromium/Brave suites pass.

- Run focused regressions during each slice, then npm test.
- Existing packaged browser coverage exercises browser restart, repeated group switching, multi-window restoration, and tab-count stability. Failure interleavings remain controller-harness tests, not claimed real-browser reproductions.
- Run npm run test:e2e, npm run test:e2e:brave, and git diff --check. Check affected switching behavior in both browsers, including internal/restricted pages and URL fallback.
- Assert tab-count stability over repeated switches, correct record ownership, no orphan restored tabs, stable completed checkpoints, and correct handling of unresolved attempts. Existing window layout, manual-close, delete, placeholder, and intentional-duplicate cases remain passing.
- Review the final diff and document browser coverage and limitations. Do not commit, push, tag, or release without a request.

Gate results: `npm test` passed 140 tests; Chromium and Brave E2E each passed 6 tests; `git diff --check` passed. One Brave full-suite `Runtime.evaluate` timeout was transient: the test passed in isolation and on full-suite rerun.

## Decisions and risks

- Implement reviewable slices in the order above. Share identity policy across callers rather than adding five unrelated URL checks.
- Browser side effects and extension storage are not one atomic transaction. A journal alone cannot guarantee identity if the worker loses the create acknowledgement and multiple identical tabs appear. Preserve uncertainty and defer another create rather than promise impossible exactly-once behavior from heuristics.
- Loosening title matching globally risks stealing tabs across groups; candidate eligibility and one-to-one claims must land with it.
- The existing store serializes reducers and journal execution, but controller event handlers can read state before their updates execute. Serialized writes alone do not eliminate stale decisions.
- Existing audit results are simulations, not evidence of the exact user's incident. Verify seams and browser assumptions before treating them as regressions fixed in production.

## Completion criteria

- All deterministic audited paths have regression coverage and pass. The out-of-band external restore/open-twin case remains ambiguous and is not silently merged.
- Repeated switches and retries do not increase live tab or saved record counts except for explicit user-created tabs.
- Legitimate duplicates, pinned tabs, group/window ownership, and manual-close semantics are preserved.
- An unresolved operation-owned side effect cannot silently clear its recovery intent or trigger a second create.
- Documentation, changelog, and Chromium/Brave verification reflect the final behavior.

## Errors encountered while planning

None.
