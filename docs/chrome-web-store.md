# Chrome Web Store Submission Notes

## Listing copy

**Name:** HiddenTabby

**Short description:** Organize tabs into local workspaces across windows. Tab titles and URLs stay in this browser profile.

**Description:**

HiddenTabby organizes unpinned tabs into named workspaces shared across your normal browser windows. Switch workspaces from the toolbar popup to close the current group's tabs and restore another group's tabs. The browser may not preserve unsaved form data, in-memory state, or running scripts when tabs are restored.

Create, rename, reorder, and color groups in the full-page manager. Move tabs from the browser's tab context menu or the manager. Use the popup, full-page manager, or side panel to manage workspaces. Pinned tabs and incognito windows are excluded. Group names, tab titles, and URLs stay in this browser profile; HiddenTabby does not sync or upload them to an external service.

**Privacy policy:** `https://github.com/cleaver/hiddentabby/blob/main/PRIVACY.md`

**Support URL:** `https://github.com/cleaver/hiddentabby/issues`

## Permission explanations

- `tabs`: read tab titles and URLs and create, close, and restore workspace tabs.
- `tabGroups`: place tabs in and update native browser tab groups.
- `sessions`: restore tabs closed during workspace switching.
- `contextMenus`: add the tab-strip action for moving a tab to a workspace.
- `storage`: save workspace and tab metadata locally in the browser profile.
- `sidePanel`: offer the workspace manager in the browser side panel.

There are no host permissions.

## Privacy practices

Disclose local use of web-browsing activity (tab titles and URLs) in the Developer Dashboard. State that it is used only for workspace management and restoration, stored in the current browser profile, and not uploaded to the developer or analytics/advertising services. The browser makes its normal request to a saved URL when restoring a tab. Link the privacy policy above and complete the Limited Use certification.

## Required listing images

- The extension ZIP contains the 128×128 PNG icon.
- Upload at least one 1280×800 (preferred) or 640×400 screenshot of the actual extension UI.
- Upload the required 440×280 small promotional image.

The current end-to-end screenshots are test captures with fixture content and are not prepared as store listing images.

## Publisher account

Register a Chrome Web Store developer account, accept the developer terms, pay the one-time registration fee, verify the contact email, and enable 2-Step Verification before publishing. Fill in the Store listing and Privacy sections in the Developer Dashboard.
