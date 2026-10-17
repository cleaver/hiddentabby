# Archived Plan: Initial HiddenTabby Release

## Dates

- **Created:** 2026-10-14, based on the planning files' filesystem creation times.
- **Archived:** 2026-10-16.

## Purpose

This plan tracked the first Linux release of HiddenTabby: a local-only Manifest V3 workspace manager for Chrome and Brave. Its 13 steps covered requirements, group state and persistence, tab lifecycle and switching, moving and deleting groups, popup and manager interfaces, optional side panel support, recovery, and packaged-browser verification.

## Outcome

The core requirements and packaged acceptance gates were completed. The recorded final regression run passed `npm test` (74/74), Chromium E2E (3/3), and Brave E2E (3/3). The repository has since reached [v0.1.5](https://github.com/cleaver/hiddentabby/releases/tag/v0.1.5), with CI and release workflows in place.

The plan's deferred work remains useful input to 0.2.x: a full keyboard/WCAG audit, reconciliation of native tab-group edits made outside HiddenTabby, and testing worker termination during an in-flight browser API call. Brave Container membership remains unavailable to extensions without a supported browser API.

## Archived Files

- [`task_plan.md`](task_plan.md) — itemized implementation steps, iteration protocol, and test gates.
- [`findings.md`](findings.md) — requirements decisions, API research, and technical constraints.
- [`progress.md`](progress.md) — implementation notes and verification evidence.

Related project records: [requirements](../../../REQUIREMENTS.md), [architecture](../../architecture.md), [CI workflow](../../../.github/workflows/ci.yml), and [release workflow](../../../.github/workflows/release.yml). The final lifecycle regression is recorded in [commit 2988765](https://github.com/cleaver/hiddentabby/commit/2988765).
