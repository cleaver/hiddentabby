# Archived Plan: Group Window Lifecycle

- **Plan created:** 2026-10-18, based on the planning files' modification dates.
- **Archived:** 2026-10-18.
- **Goal:** Make each group restore its useful browser windows, keep pinned-tab windows available, discard user-closed content, and close windows that the selected group does not need.

## Outcome

All eight implementation steps and acceptance checks were completed. HiddenTabby now tracks per-group window layouts, distinguishes user window closure from extension-driven switching, handles empty and pinned-only windows, and recovers interrupted switches without restoring deleted tabs. The agreed final-window policy preserves useful snapshots when the last normal browser window closes; closing a nonfinal window forgets that window's active-group tabs. README, architecture notes, and the Unreleased changelog were updated with the behavior.

## Verification and limits

The plan records 119 passing unit tests, packaged Chromium and Brave E2E runs, JavaScript syntax and diff checks, and a ZIP integrity check. The latest follow-up verification recorded 5/5 packaged Chromium E2E cases and a targeted Brave round trip. Desktop foreground focus could not be verified in this headless runner. Brave headless also keeps its final normal window open, so that specific final-window-close path was not available there.

## Related implementation commits

- `1bfa3ee` — forget tabs closed during worker startup
- `8adb8cd` — preserve group window layouts
- `929276c` — retain snapshots on group close

The original plan, findings, and progress logs are preserved alongside this README.

## Later requirement update

The archived plan's rule to avoid closing a blank window while the user is working in it described the original switching and placeholder behavior. The current Workspace Manager deletion contract is now in `REQUIREMENTS.md` and `docs/architecture.md`: deleting the final live tab closes its window, while group switching still retains its temporary placeholder behavior.
