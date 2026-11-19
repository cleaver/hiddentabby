# HiddenTabby Privacy Policy

Effective date: October 15, 2026

HiddenTabby organizes browser tabs into workspaces. To show and restore those workspaces, it handles the following data from regular (non-incognito) browser windows:

- Tab URLs and page titles.
- Workspace names, colors, order, tab membership, and open or saved status.
- Browser tab, window, and session identifiers needed to reconnect and restore tabs.

HiddenTabby does not read page contents, form entries, or cookies. Pinned tabs and incognito windows are excluded. URLs can contain information present in the address itself, such as search terms or query parameters.

## Storage and use

This data is used only to display and manage workspaces and to restore their tabs when you switch groups. Workspace records are stored in `chrome.storage.local` in the current browser profile. HiddenTabby also uses the browser Sessions API to restore tabs when a saved session is available. HiddenTabby does not upload this workspace data to the developer or analytics and advertising services, and does not use it for analytics, advertising, or profiling. When a saved tab is restored, the browser navigates to its saved URL as a normal browser request.

You can remove tabs or workspaces in the manager. Deleting a workspace closes its open tabs and removes its HiddenTabby records. The browser manages its own history and recently closed session records separately; deleting a workspace does not erase browser history.

## Optional local agent access

HiddenTabby includes an optional local agent bridge that is off by default. If you choose **Allow access** in the manager, HiddenTabby requests the optional `nativeMessaging` permission and connects to a helper program you installed on your computer. That helper can then receive the URLs and titles of your tabs and HiddenTabby workspace records, and can ask HiddenTabby to close tabs. Data stays on your computer and is available to programs running under your user account while access is allowed. You can revoke access in the manager at any time.

## Chrome Web Store Limited Use

HiddenTabby uses information accessed through Chrome extension APIs only to provide its tab-workspace features. This use complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. HiddenTabby does not sell or transfer tab data, use it for personalized advertising, or allow people to read it.

## Contact

For privacy questions, use the [HiddenTabby issue tracker](https://github.com/cleaver/hiddentabby/issues).
