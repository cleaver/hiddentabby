# Architecture and Acceptance Matrix

## Runtime Boundaries

- `src/group-state.js` contains pure state transitions. It has no browser API dependencies and runs in Node's built-in test runner.
- A Manifest V3 service worker owns Chrome/Chromium/Brave APIs, event listeners, serialization, and state reconciliation. Persist all meaningful state in `chrome.storage.local`; service-worker memory is only a cache.
- Popup and full-page manager render state and send commands to the service worker. They do not mutate storage directly.
- Browser behavior is behind a small adapter so unit tests can inject deterministic APIs and failures. Real-browser E2E uses disposable profiles and local pages.
- Keep the extension runtime free of third-party libraries and remote code. Test tooling is development-only.

## State Model

- A group has an extension-owned stable ID, unique case-insensitive name, supported native color, and display order. Exactly one group is named `Default`; it cannot be renamed away. Group creation does not change the active group.
- A managed tab record has an extension-owned ID, group ID, stable logical window ID, current browser tab/window IDs (transient), URL/title/icon/index snapshot, optional sessions restore ID, and open/closed status. Duplicate URLs remain separate tabs.
- A window record has a stable logical ID, current browser window ID, open/dormant status, pinned tab IDs, and an optional temporary placeholder tab ID.
- Pinned tabs stay open and outside groups. Pinning removes a tab from its group; unpinning assigns it to the active group. Incognito tabs/windows are ignored.
- Native groups are only a tab-strip aid: apply one when at least two managed unpinned tabs from the same HiddenTabby group are open in a window. Keep singleton tabs logically assigned but natively ungrouped, and re-evaluate after close, pin, move, or cross-window transfer. This prevents the browser's native last-tab group-deletion dialog without deleting the HiddenTabby group.
- Group deletion removes all of its records. It creates a fresh empty `Default` if needed, closes live tabs after confirmation, and never restores or reassigns those tabs.

## Lifecycle Policies

These implementation defaults complete cases the user has not separately specified:

- A user closing one managed tab removes its record but never deletes its HiddenTabby group. If that was the window's last member, the window has no membership in that group and receives the normal ungrouped placeholder. Reconcile native grouping immediately so a remaining singleton is ungrouped. If the parent window closes, keep its tab snapshots as dormant group members so they can be restored in a recreated window when that group is selected.
- A browser-created New Tab page is ordinary active-group content. If a still-open window has no tabs in the selected group, HiddenTabby creates its own identifiable extension placeholder. The placeholder is ungrouped and excluded from saved group content. Navigating it promotes it into the active group; restoring a real tab into the window removes it.
- Create a required placeholder before closing the final managed tab in a window. On switch, persist outgoing snapshots and the operation intent before any close; then reconcile planned closes against live tabs in still-open windows so tabs manually closed just before the switch are forgotten. Restore the target group's remaining snapshots to their logical windows, recreating a closed window when needed. Remove placeholders after restored tabs arrive and focus the group's last active tab.
- Match restored tabs by extension-owned/session identity first. Use URL/title/index/window context only as a fallback; duplicate URLs must never collapse into one record. When an API or persistence operation fails, retain the snapshot and retry reconciliation on the next browser event/startup.
- Serialize switch, move, delete, and tab lifecycle changes. If a planned tab is removed before HiddenTabby issues its `tabs.remove()` request, treat it as a user close and remove it from the pending restore records. After the browser close request is issued, retain those snapshots for recovery. Recovery must never revive a deleted group.

## Acceptance Matrix

| ID | Scenario | Evidence |
|---|---|---|
| INIT-01 | First install creates `Default` and adopts existing normal unpinned tabs | Unit, adapter integration, Chromium and Brave |
| GROUP-01 | Create/rename/reorder/recolor without implicit activation; one `Default` remains | Unit, popup/manager E2E |
| GROUP-02 | Native grouping is used for 2+ tabs per group/window; singleton tabs remain logical but ungrouped | Adapter integration, Chromium and Brave E2E |
| TAB-01 | New/unpinned tabs join active group; pinning removes membership; incognito stays untouched | Unit, browser integration |
| SWITCH-01 | Global A→B→A closes inactive tabs and restores each tab/window and last active selection | Adapter integration, Chromium and Brave |
| SWITCH-02 | Empty windows keep one identifiable placeholder; navigation promotes it; restore removes it | Unit, browser integration, restart test |
| MOVE-01 | Moving to inactive group closes/saves immediately without activating it | Unit, native tab-menu E2E |
| DELETE-01 | Warning cancellation is inert; confirmation closes tabs, forgets records, and creates empty `Default` as needed | Unit, UI E2E, restart/fault injection |
| LIFE-01 | Manual tab close removes window membership without deleting the group; window close preserves dormant snapshots; restart reconciles once | Adapter integration, Chromium and Brave E2E |
| PRIV-01 | Local storage only; pinned/incognito exclusion; no remote executable resources | Static/package checks, browser profile inspection |
| BRAVE-01 | Core behavior matches Chromium; Container controls appear only behind supported APIs | Brave E2E/manual compatibility |

## Platform Evidence

Chrome's tab removal event exposes `isWindowClosing`, allowing the adapter to distinguish an individual tab close from tabs removed as a parent window closes. `runtime.onStartup` fires when the profile starts; MV3 workers can stop at any time, so state writes cannot rely on a final suspend callback. Source references are in `findings.md`.
