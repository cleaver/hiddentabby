# Architecture and Acceptance Matrix

## Runtime Boundaries

- `src/group-state.js` contains pure state transitions. It has no browser API dependencies and runs in Node's built-in test runner.
- A Manifest V3 service worker owns Chrome/Chromium/Brave APIs, event listeners, serialization, and state reconciliation. Persist all meaningful state in `chrome.storage.local`; service-worker memory is only a cache.
- Popup and full-page manager render state and send commands to the service worker. They do not mutate storage directly.
- Browser behavior is behind a small adapter so unit tests can inject deterministic APIs and failures. Real-browser E2E uses disposable profiles and local pages.
- Keep the extension runtime free of third-party libraries and remote code. Test tooling is development-only.

## State Model

- A group has an extension-owned stable ID, unique case-insensitive name, supported native color, and display order. `defaultGroupId` identifies the designated main group independently of its name. It starts as `Main`, can be renamed, and is replaced with a fresh empty `Main` group if deleted (with a numeric suffix if that name is already taken). Group creation does not change the active group.
- A managed tab record has an extension-owned ID, group ID, stable logical window ID, current browser tab/window IDs (transient), URL/title/icon/index snapshot, optional sessions restore ID, and open/closed status. Duplicate URLs remain separate tabs.
- A window record has a stable logical ID, current browser window ID, open/dormant status, pinned tab IDs, and an optional temporary placeholder tab ID.
- Pinned tabs stay open and outside groups. Pinning removes a tab from its group; unpinning assigns it to the active group. Incognito tabs/windows are ignored.
- Native groups are only a tab-strip aid: apply one when at least two managed unpinned tabs from the same HiddenTabby group are open in a window. Keep singleton tabs logically assigned but natively ungrouped, and re-evaluate after close, pin, move, or cross-window transfer. This prevents the browser's native last-tab group-deletion dialog without deleting the HiddenTabby group.
- Group deletion removes all of its records. Deleting the designated main group creates a fresh empty `Main`, closes live tabs after confirmation, and never restores or reassigns those tabs.

## Lifecycle Policies

These lifecycle rules apply across normal browser windows; there is no designated main window:

- Capture tab-removal events before awaiting worker initialization. Apply startup removals using the original persisted tab identities, including events arriving during reconciliation or storage writes. Preserve journaled closes and final-window snapshots; persist manual removals before completing initialization.
- A user closing one managed tab removes its record but never deletes its HiddenTabby group. If the browser keeps the window open after its last unpinned member closes, add an ungrouped placeholder only when no pinned tab keeps the window usable. If closing the tab also closes the window, apply the normal window-close policy. Reconcile native grouping immediately so a remaining singleton is ungrouped.
- Workspace Manager deletion of an open tab closes the containing window when that tab is its final live browser tab; do not create a placeholder in that case. Keep the window if any other tab remains, including pinned tabs. If the full-page manager tab is the only tab in its window, disable deleting that row and reject stale delete commands in the controller. The side panel is not a tab and closes with its host window. Keep deletion journaled so lifecycle events and recovery cannot restore the deleted tab; preserve unrelated inactive-group snapshots that share its logical window.
- A user's nonfinal normal-window close permanently removes that window's tabs from the active group. Keep inactive-group snapshots that refer to the same logical window, and keep its metadata only while a group snapshot or pending operation still refers to it. Closing the final normal window preserves useful snapshots for restoration after browser restart; closing windows one by one only preserves the final window's content.
- Pinned tabs stay open during group switching and remain outside groups. A group remembers the logical windows with meaningful unpinned tabs. Keep browser New Tab tabs alongside meaningful tabs in the same group/window; discard New-Tab-only group content. HiddenTabby extension placeholders are never saved. Navigating one promotes it into the active group.
- On switch, persist outgoing snapshots and intent before any close. Reconcile planned closes against live tabs and pinned state so tabs manually closed or pinned just before the switch are handled correctly. Restore the destination group's tabs to its logical windows, recreating dormant windows when needed, and close unneeded unpinned windows. Remove placeholders after restoration, activate each window's last active tab, and focus a still-useful previously focused window or a destination group window if the source window closed.
- An empty group retains windows with pinned tabs without adding placeholders. If no pinned window is available, keep or create one temporary window with an excluded placeholder so the browser remains usable.
- Match restored tabs by extension-owned/session identity first. Use URL/title/index/window context only as a fallback; duplicate URLs must never collapse into one record. When an API or persistence operation fails, retain the snapshot and retry reconciliation on the next browser event/startup.
- Serialize switch, move, delete, and tab lifecycle changes. If a planned tab is removed before HiddenTabby issues its `tabs.remove()` request, treat it as a user close and remove it from the pending restore records. After the browser close request is issued, retain those snapshots for recovery. Recovery must never revive a deleted group.

## Acceptance Matrix

| ID | Scenario | Evidence |
|---|---|---|
| INIT-01 | First install creates `Main` and adopts existing normal unpinned tabs | Unit, adapter integration, Chromium and Brave |
| GROUP-01 | Create/rename/reorder/recolor without implicit activation; main identity remains renameable and unique | Unit, state migration, manager E2E |
| GROUP-02 | Native grouping is used for 2+ tabs per group/window; singleton tabs remain logical but ungrouped | Adapter integration, Chromium and Brave E2E |
| TAB-01 | New/unpinned tabs join active group; pinning removes membership; incognito stays untouched | Unit, browser integration |
| SWITCH-01 | Global A→B→A restores each group's logical windows and last active selection, closing unused unpinned windows | Unit, adapter integration, Chromium and Brave |
| SWITCH-02 | Pinned windows remain open; empty groups retain pinned windows or one temporary placeholder window | Unit, browser integration, Chromium and Brave |
| MOVE-01 | Moving to inactive group closes/saves immediately without activating it | Unit, native tab-menu E2E |
| DELETE-01 | Warning cancellation is inert; confirmation closes tabs, forgets records, and creates empty `Main` when deleting the designated main group | Unit, UI E2E, restart/fault injection |
| DELETE-02 | Manager deletion closes a window when its final tab is deleted, keeps pinned/other tabs, disables deleting the manager's sole full-page tab, and never restores deleted content | Unit, manager UI, Chromium and Brave E2E, interruption recovery |
| LIFE-01 | Manual tab close forgets that tab; nonfinal window close forgets active-group contents but retains inactive snapshots; final-window close preserves useful snapshots | Unit, adapter integration, Chromium and Brave E2E |
| PRIV-01 | Local storage only; pinned/incognito exclusion; no remote executable resources | Static/package checks, browser profile inspection |
| BRAVE-01 | Core behavior matches Chromium; Container controls appear only behind supported APIs | Brave E2E/manual compatibility |

## Platform Evidence

Chrome's tab removal event exposes `isWindowClosing`, allowing the adapter to distinguish an individual tab close from tabs removed as a parent window closes. `runtime.onStartup` fires when the profile starts; MV3 workers can stop at any time, so state writes cannot rely on a final suspend callback. Source references are in `findings.md`.
