# Changelog

## Unreleased

- Extend the sticky group heading across the card so it covers scrolling content.
- Add a Reload groups action when the Workspace Manager cannot load its state.
- Retry a workspace load once after a brief tab-edit lock, while coalescing storage-triggered refreshes.
- Close a browser window when Workspace Manager deletes its final live tab, while protecting a full-page manager tab that is the only tab in its window.

## 0.2.0 — 2026-10-18

- Preserve saved tabs when Chrome auto-closes a workspace-only window as its last tab is removed during switching.
- Refresh open popup and manager views when local workspace state changes.
- Restore each group's useful window layout, keep pinned windows open, and forget active-group tabs when users close a nonfinal window.
- Preserve group snapshots when the final normal browser window closes; keep empty groups usable with pinned windows or one temporary placeholder window.
- Focus a useful selected-group window after switching, including when the window that initiated the switch closes.
- Forget tabs closed while the background worker starts, preventing them from returning on workspace switches.
- Add compact top-aligned tab actions and allow deleting open tabs or saved tab snapshots.
- Add tab favicons, friendlier window labels, and compact selectable URLs to the manager.
- Drag tabs between workspace groups in the manager.
- Dismiss the tab move panel on outside click and add a Cancel action.
- Cap expanded groups at a scrollable height and limit masonry layout to three responsive columns.
- Organize saved and open tabs inside expandable workspace groups in the manager.
- Show each tab's move controls on demand with an accessible icon button.
- Float the move selector above tab rows without changing their layout.
- Prevent long popup group names from creating horizontal overflow.

## 0.1.5 — 2026-10-16

- Explain checksum and artifact attestation verification and their limits.

## 0.1.4 — 2026-10-16

- Add the MIT license to the repository and downloadable extension package.

## 0.1.3 — 2026-10-16

- Use a high-resolution logo in the workspace manager.
- Publish tagged ZIP packages with checksums and GitHub build provenance.

## 0.1.2 — 2026-10-15

- Use HiddenTabby artwork in the popup and workspace manager.
- Keep supported group colors visible in a compact, responsive palette.

## 0.1.1 — 2026-10-15

- Add HiddenTabby artwork for the toolbar and Chrome Web Store icon.
- Remove manually closed tabs from saved workspaces so they are not restored later.
- Document local tab-data handling and privacy practices.
