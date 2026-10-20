# HiddenTabby Requirements

**Status:** Core requirements agreed and implemented. Chromium/Brave acceptance evidence is recorded in the archived lifecycle plan and current E2E tests.

## Goal

Build one Manifest V3 extension for Chrome and Brave that brings the main tab-organization workflow of Firefox Simple Tab Groups to Chromium browsers.

## Version 1 Core

- Create, rename, reorder, color, and delete named groups.
- Maintain one designated main group independently of its editable display name. Its initial and replacement name is `Main`; users can rename it. If another group already uses `Main`, a replacement gets the next available name, such as `Main (2)`. Deleting any group closes all its member tabs across windows and removes its saved group/tab records. Show a confirmation warning with the group name and number of tabs that will close; this does not erase browser history. Never reassign or restore tabs closed by group deletion.
- Add the current tab to a group and move existing tabs between groups.
- Manage every unpinned tab in a group; keep pinned tabs pinned and outside groups. During a group switch, if a window has no tabs in the selected group, keep it open with a temporary, ungrouped New Tab placeholder. Assign that tab to the active group if the user navigates it; remove the placeholder when a group tab is restored to the window. Workspace Manager tab deletion follows the separate window-close rule below.
- On first run, create a `Main` group and assign all currently open unpinned tabs across normal windows to it, replacing any existing native group assignments for those tabs.
- Assign newly opened unpinned tabs to the currently active group. Creating a new group from the popup must not activate it.
- Add a tab-strip right-click action to move the clicked tab into another group. Moving it to an inactive group closes/saves it immediately and does not switch the active group.
- Switch groups and return to the last active tab in each group.
- Preserve group membership across browser restarts.
- Make group definitions available across browser windows. Treat a switch as global: close tabs in inactive groups across normal windows and restore the selected group's tabs in their original windows.
- Keep windows open across global switches with the temporary New Tab placeholder described above; it is not group content or a saved tab.
- Avoid Chromium's native “Close tab and delete group?” prompt when closing a group's last tab in a window. Apply native tab grouping only when at least two unpinned tabs from the same HiddenTabby group are open in that window. Keep singleton tabs logically assigned to HiddenTabby but native-ungrouped; regroup when a second tab joins. Closing the singleton removes that tab/window's membership while leaving the HiddenTabby group intact.
- Use the toolbar popup for group switching and provide a link from it to a full-page manager for group management and settings. Offer the side panel as an additional option; full management must not depend on it.

## Platform Constraint

Chrome's native tab group API supports titles, colors, and collapsing groups. Simple Tab Groups uses Firefox's tabHide permission to hide tabs. The Chrome extension APIs reviewed do not expose equivalent tab hiding. The user chose a saved-workspace model: close tabs in inactive groups and restore them when selected. Prefer Chrome's Sessions API to restore recently closed tabs by session ID, with saved tab data as a fallback. Closing a tab can lose live page state such as unsaved form contents or running scripts; URL/session restoration cannot guarantee that state is preserved. Chrome native tab groups are window-scoped, so the extension should maintain logical group definitions and per-window tab membership, then coordinate a global switch across those windows.

## Brave Containers

Brave 1.92+ for desktop includes native Containers that isolate cookies and other site data. A tab group organizes work; a Container separates a site's login and storage context. They can complement each other.

Brave has not documented a supported extension API for Container membership. A Brave issue reports that extension cookie calls use the default store for a Container tab and asks Brave to expose a Container store ID or equivalent API. Research found no supported API to identify the active Container or create and assign Container tabs. Do not guess from cookies or depend on private browser internals.

Keep the Chrome and Brave core experience aligned. The user wants both of these optional Brave-only capabilities: show each tab's Container and open or move tabs into a chosen Container. If Brave exposes a supported API, also allow creating, renaming, and deleting Container definitions from HiddenTabby while retaining access to Brave's native settings. Until a supported API exists, provide a link to Brave's Container settings and do not imply that the extension can identify or control Containers.

## Later Candidates

Search and keyboard navigation, drag-and-drop, group sorting, JSON backup and restore, undo group removal, custom icons, dark theme, and advanced cross-window management tools are listed by Simple Tab Groups. The user chose to keep version 1 focused on the core group manager; consider these for later releases.

## Technical Validation Items

1. Confirm pinned-tab exclusion, session restoration, global switching, tab-strip context menus, and side-panel support in target Chromium and Brave versions, using Chromium as the accepted Chrome testing proxy.

## Deletion and Active Group Behavior

- When deleting the active group, switch all windows to the designated main group. If deleting that group, create a fresh, empty `Main`; if it was the last group, this is the new sole group. Tabs from the deleted group remain closed and are not added to the replacement group.

## Workspace Manager Tab Deletion

- Deleting an open tab in the Workspace Manager closes and permanently removes that tab. If it was the last browser tab in its normal window, close that window instead of creating a HiddenTabby placeholder. Any other live tab, including a pinned tab, keeps the window open; pinned tabs remain untouched.
- If the full-page Workspace Manager tab is the only tab in its window, disable its own Delete button so the user cannot close the manager out from under themselves. The service worker must also reject a stale delete request if the tab/window state changes after the UI was rendered.
- The side panel is not a browser tab; if its host window loses its last tab, the window and side panel close together.
- Deleting a saved tab from an inactive group removes only that saved record and does not close a live window. Deleted tabs must not return on a later group switch; preserve unrelated saved tabs in other groups even if they refer to the same logical window.
- This rule applies only to the Workspace Manager Delete action. Group switching continues to use temporary placeholders for browser continuity, and closing tabs from the browser tab strip follows the browser's normal window-close behavior.

## Data, Privacy, and Compatibility

- Store group and tab metadata locally in the browser profile; do not sync it or use a remote service.
- Ignore incognito windows and tabs.
- Support Linux for the initial release; defer Windows and macOS verification.
- Use Chromium as the accepted proxy for Chrome verification; require separate Brave checks. A Google Chrome installation/run is not an initial release gate.
- Target current stable Chrome and Brave releases and releases from roughly the preceding three months; set exact minimum versions at release time.
- Request only the `tabs`, `tabGroups`, `sessions`, `contextMenus`, and `storage` permissions needed by the feature set. The optional side panel additionally needs `sidePanel`; the popup and full-page manager remain available without it. Explain that `sessions` restores closed group tabs and `contextMenus` adds the tab-strip move action.

## References

- [Simple Tab Groups](https://addons.mozilla.org/en-GB/firefox/addon/simple-tab-groups/)
- [Chrome tab groups API](https://developer.chrome.com/docs/extensions/reference/api/tabGroups)
- [Chrome context menus API](https://developer.chrome.com/docs/extensions/reference/api/contextMenus)
- [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Chrome side panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Chrome sessions API](https://developer.chrome.com/docs/extensions/reference/api/sessions)
- [Brave extension support](https://support.brave.com/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave)
- [Brave Containers announcement](https://brave.com/blog/containers/)
- [Brave Containers help](https://support.brave.app/hc/en-us/articles/39077103885325-How-do-I-use-Containers-in-Brave)
- [Brave extension API issue for Containers](https://github.com/brave/brave-browser/issues/57209)
