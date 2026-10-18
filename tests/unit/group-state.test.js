import test from "node:test";
import assert from "node:assert/strict";
import {
  assignTab,
  createEmptyState,
  createFirstRunState,
  createGroup,
  deleteGroup,
  handleTabRemoved,
  handleWindowRemoved,
  isMeaningfulTab,
  markTabClosed,
  moveTab,
  planGroupSwitch,
  promotePlaceholder,
  recolorGroup,
  renameGroup,
  reorderGroups,
  setWindowPlaceholder,
} from "../../src/group-state.js";

function idFactory() {
  let next = 0;
  return () => `id-${++next}`;
}

test("meaningful-tab detection ignores placeholders and browser New Tab pages, including pending navigation", () => {
  const isPlaceholderUrl = (url) => url?.startsWith("chrome-extension://test/placeholder.html") ?? false;
  assert.equal(isMeaningfulTab({ url: "https://example.com/" }, isPlaceholderUrl), true);
  assert.equal(isMeaningfulTab({ url: "https://example.com/", title: "New Tab" }, isPlaceholderUrl), true,
    "A page title must not determine whether its content is blank.");
  assert.equal(isMeaningfulTab({ url: "chrome://newtab/" }, isPlaceholderUrl), false);
  assert.equal(isMeaningfulTab({ url: "brave://newtab/" }, isPlaceholderUrl), false);
  assert.equal(isMeaningfulTab({ url: "chrome-search://local-ntp/local-ntp.html" }, isPlaceholderUrl), false);
  assert.equal(isMeaningfulTab({ url: "chrome-extension://test/placeholder.html?window=one" }, isPlaceholderUrl), false);
  assert.equal(isMeaningfulTab({ url: "chrome://newtab/", pendingUrl: "https://loading.example/" }, isPlaceholderUrl), true,
    "A meaningful pending destination must protect a tab still reporting its New Tab URL.");
  assert.equal(isMeaningfulTab({ url: "https://example.com/", pendingUrl: "chrome://newtab/" }, isPlaceholderUrl), false,
    "The pending destination determines membership during navigation.");
  assert.equal(isMeaningfulTab({ url: "about:blank", title: "New Tab" }, isPlaceholderUrl), true,
    "Unknown blank-looking pages are retained conservatively.");
  assert.equal(isMeaningfulTab({ url: "https://pinned.example/", pinned: true }, isPlaceholderUrl), false);
});

test("a browser New Tab stays with a useful tab in the same group and logical window", () => {
  const ids = idFactory();
  const state = createFirstRunState([
    { id: 501, windowId: 50, index: 0, url: "https://useful.example", title: "Useful" },
    { id: 502, windowId: 50, index: 1, url: "chrome://newtab/", title: "New Tab" },
  ], { createId: ids });
  const closedState = {
    ...state,
    windows: state.windows.map((window) => ({ ...window, isOpen: false })),
    tabs: state.tabs.map((tab) => ({ ...tab, browserTabId: null, status: "closed" })),
  };

  const plan = planGroupSwitch(closedState, state.activeGroupId);

  assert.deepEqual(plan.restoreTabs.map((tab) => tab.url), [
    "https://useful.example",
    "chrome://newtab/",
  ]);
  assert.deepEqual(plan.recreateWindowIds, [50]);
  assert.deepEqual(plan.discardTabIds, []);
});

test("first run assigns every normal unpinned tab and excludes pinned and incognito tabs", () => {
  const state = createFirstRunState([
    { id: 1, windowId: 11, url: "https://one.example", groupId: 90 },
    { id: 2, windowId: 12, url: "https://two.example", pinned: true },
    { id: 3, windowId: 12, url: "https://private.example", incognito: true },
  ], { createId: idFactory() });

  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0].name, "Default");
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].groupId, state.activeGroupId);
  assert.equal(state.tabs[0].windowId, state.windows[0].id);
  assert.notEqual(state.tabs[0].windowId, state.tabs[0].browserWindowId);
  assert.deepEqual(state.windows.map((window) => window.browserWindowId), [11, 12]);
  assert.deepEqual(state.windows[1].pinnedTabIds, [2]);
});

test("first-run snapshots prefer a meaningful pending URL over a browser New Tab URL", () => {
  const state = createFirstRunState([
    { id: 4, windowId: 14, url: "chrome://newtab/", pendingUrl: "https://loading.example/" },
  ], { createId: idFactory() });

  assert.equal(state.tabs[0].url, "https://loading.example/");
  assert.equal(isMeaningfulTab(state.tabs[0]), true);
});

test("group creation, rename, recolor, and reordering preserve active group", () => {
  const ids = idFactory();
  const initial = createEmptyState({ createId: ids });
  const second = createGroup(initial, { name: "Research", color: "blue" }, { createId: ids });
  const secondId = second.groups[1].id;

  assert.equal(second.activeGroupId, initial.activeGroupId);
  const renamed = renameGroup(second, secondId, "  Reading  ");
  const recolored = recolorGroup(renamed, secondId, "green");
  const reordered = reorderGroups(recolored, [secondId, initial.activeGroupId]);
  assert.equal(reordered.groups[0].name, "Reading");
  assert.equal(reordered.groups[0].color, "green");
  assert.equal(reordered.activeGroupId, initial.activeGroupId);
  assert.throws(() => createGroup(reordered, { name: "reading" }), /already exists/);
  assert.throws(() => recolorGroup(reordered, secondId, "chartreuse"), /supported/);
  assert.throws(() => reorderGroups(reordered, [secondId, secondId]), /exactly once/);
});

test("switch plan closes inactive tabs and unused windows while restoring destination tabs", () => {
  const ids = idFactory();
  let state = createFirstRunState([
    { id: 101, windowId: 7, url: "https://active.example" },
    { id: 102, windowId: 8, url: "https://other.example" },
  ], { createId: ids });
  const defaultId = state.activeGroupId;
  state = createGroup(state, { name: "Other" }, { createId: ids });
  const otherId = state.groups[1].id;
  state = { ...state, tabs: state.tabs.map((tab) => tab.browserWindowId === 8
    ? { ...tab, groupId: otherId, status: "closed", browserTabId: null }
    : tab) };

  const plan = planGroupSwitch(state, otherId);
  assert.equal(plan.state.activeGroupId, otherId);
  assert.deepEqual(plan.closeTabs.map((tab) => tab.browserTabId), [101]);
  assert.deepEqual(plan.restoreTabs.map((tab) => tab.browserWindowId), [8]);
  assert.deepEqual(plan.placeholderWindowIds, []);
  assert.deepEqual(plan.closeWindowIds, [7]);
  assert.deepEqual(plan.recreateWindowIds, []);
  assert.equal(plan.state.groups.find((group) => group.id === defaultId).name, "Default");
});

test("switch layout reuses a shared destination window and closes unused unpinned windows", () => {
  const ids = idFactory();
  let state = createFirstRunState([
    { id: 2101, windowId: 210, url: "https://default-one.example" },
    { id: 2201, windowId: 220, url: "https://default-two.example" },
  ], { createId: ids });
  const defaultGroupId = state.activeGroupId;
  state = createGroup(state, { name: "One Window" }, { createId: ids });
  const oneWindowId = state.groups[1].id;
  state = assignTab(state, { id: 2102, windowId: 210, url: "https://other.example" }, oneWindowId);
  state = {
    ...state,
    tabs: state.tabs.map((tab) => tab.browserTabId === 2102
      ? { ...tab, browserTabId: null, status: "closed" }
      : tab),
  };

  const toOneWindow = planGroupSwitch(state, oneWindowId);
  assert.deepEqual(toOneWindow.closeWindowIds, [220]);
  assert.deepEqual(toOneWindow.recreateWindowIds, []);
  assert.deepEqual(toOneWindow.restoreTabs.map((tab) => tab.url), ["https://other.example"]);

  const defaultInSecondWindow = state.tabs.find((tab) => tab.browserWindowId === 220);
  const afterOneWindow = {
    ...toOneWindow.state,
    windows: state.windows.map((window) => window.browserWindowId === 220
      ? { ...window, isOpen: false }
      : window),
    tabs: state.tabs.map((tab) => tab.id === defaultInSecondWindow.id
      ? { ...tab, browserTabId: null, status: "closed" }
      : tab.groupId === oneWindowId
        ? { ...tab, browserTabId: 2102, status: "open" }
        : { ...tab, browserTabId: null, status: "closed" }),
  };
  const backToDefault = planGroupSwitch(afterOneWindow, defaultGroupId);
  assert.deepEqual(backToDefault.recreateWindowIds, [220],
    "Returning to the two-window group must recreate its dormant logical window.");
  assert.deepEqual(backToDefault.closeWindowIds, []);
  assert.deepEqual(new Set(backToDefault.restoreTabs.map((tab) => tab.browserWindowId)), new Set([210, 220]));
});

test("blank-only group windows are discarded while mixed windows retain meaningful duplicate tabs", () => {
  const ids = idFactory();
  let state = createFirstRunState([
    { id: 3101, windowId: 310, url: "https://same.example" },
    { id: 3102, windowId: 310, url: "https://same.example" },
    { id: 3103, windowId: 310, url: "chrome://newtab/" },
    { id: 3104, windowId: 310, url: "chrome-extension://test/placeholder.html?window=logical" },
    { id: 3201, windowId: 320, url: "brave://newtab/" },
  ], { createId: ids });
  state = createGroup(state, { name: "Research" }, { createId: ids });
  const researchId = state.groups[1].id;
  state = {
    ...state,
    tabs: state.tabs.map((tab) => ({
      ...tab,
      groupId: researchId,
      browserTabId: null,
      status: "closed",
    })),
  };

  const isPlaceholderUrl = (url) => url.startsWith("chrome-extension://test/placeholder.html");
  const plan = planGroupSwitch(state, researchId, { isPlaceholderUrl });
  assert.deepEqual(plan.restoreTabs.map((tab) => tab.browserTabId), [null, null, null]);
  assert.deepEqual(plan.restoreTabs.map((tab) => tab.url), [
    "https://same.example",
    "https://same.example",
    "chrome://newtab/",
  ], "The duplicate tabs and mixed-window New Tab remain distinct saved tabs.");
  const newTabOnlyWindowId = state.tabs.find((tab) => tab.url === "brave://newtab/").windowId;
  assert.deepEqual(plan.discardTabIds, state.tabs
    .filter((tab) => isPlaceholderUrl(tab.url) || tab.windowId === newTabOnlyWindowId)
    .map((tab) => tab.id));
  assert.deepEqual(plan.closeWindowIds, [320],
    "A New-Tab-only window is not part of the destination group's layout.");
});

test("empty groups retain pinned windows and one temporary window only when needed", () => {
  const ids = idFactory();
  let state = createFirstRunState([
    { id: 4101, windowId: 410, url: "https://outgoing-one.example" },
    { id: 4201, windowId: 420, pinned: true, url: "https://pinned.example" },
    { id: 4301, windowId: 430, url: "https://outgoing-two.example" },
  ], { createId: ids });
  state = createGroup(state, { name: "Empty" }, { createId: ids });
  const emptyGroupId = state.groups[1].id;

  const withPinned = planGroupSwitch(state, emptyGroupId);
  assert.deepEqual(withPinned.closeWindowIds, [410, 430]);
  assert.deepEqual(withPinned.placeholderWindowIds, [],
    "Pinned tabs keep their window usable without an extension placeholder.");
  assert.equal(withPinned.createTemporaryWindow, false);

  const withoutPinnedState = {
    ...state,
    windows: state.windows.map((window) => ({ ...window, pinnedTabIds: [] })),
  };
  const withoutPinned = planGroupSwitch(withoutPinnedState, emptyGroupId);
  assert.deepEqual(withoutPinned.closeWindowIds, [420, 430]);
  assert.deepEqual(withoutPinned.placeholderWindowIds, [410],
    "Keep one existing window for temporary continuity and close the rest.");
  assert.equal(withoutPinned.createTemporaryWindow, false);

  const noOpenWindows = {
    ...withoutPinnedState,
    windows: withoutPinnedState.windows.map((window) => ({ ...window, isOpen: false })),
  };
  const noWindow = planGroupSwitch(noOpenWindows, emptyGroupId);
  assert.deepEqual(noWindow.closeWindowIds, []);
  assert.deepEqual(noWindow.placeholderWindowIds, []);
  assert.equal(noWindow.createTemporaryWindow, true,
    "An empty group remains usable when there is no normal window to retain.");
});

test("switching back removes placeholders only in windows receiving restored group tabs", () => {
  const ids = idFactory();
  let state = createFirstRunState([{ id: 201, windowId: 20, url: "https://first.example" }], { createId: ids });
  const defaultId = state.activeGroupId;
  state = createGroup(state, { name: "Empty" }, { createId: ids });
  const emptyId = state.groups[1].id;
  state = setWindowPlaceholder(state, 20, 999);

  const toEmpty = planGroupSwitch(state, emptyId);
  assert.deepEqual(toEmpty.placeholderWindowIds, []);
  assert.deepEqual(toEmpty.removePlaceholderWindowIds, []);
  const emptyState = {
    ...toEmpty.state,
    tabs: toEmpty.state.tabs.map((tab) => ({ ...tab, status: "closed", browserTabId: null })),
  };
  const toDefault = planGroupSwitch(emptyState, defaultId);
  assert.deepEqual(toDefault.removePlaceholderWindowIds, [20]);
});

test("moving to an inactive group closes the tab but does not activate its group", () => {
  const ids = idFactory();
  let state = createFirstRunState([{ id: 301, windowId: 30, url: "https://move.example" }], { createId: ids });
  state = createGroup(state, { name: "Later" }, { createId: ids });
  const result = moveTab(state, state.tabs[0].id, state.groups[1].id);

  assert.equal(result.closeBrowserTab, 301);
  assert.equal(result.shouldActivateGroup, false);
  assert.equal(result.state.activeGroupId, state.activeGroupId);
  assert.equal(result.state.tabs[0].status, "closed");
  assert.equal(result.state.tabs[0].browserTabId, null);
  assert.equal(result.state.tabs[0].url, "https://move.example");
});

test("navigating the temporary placeholder promotes it into the active group", () => {
  const ids = idFactory();
  let state = createEmptyState({ createId: ids });
  state = { ...state, windows: [{ id: "window-key", browserWindowId: 40, placeholderTabId: 401 }] };
  state = promotePlaceholder(state, { id: 401, windowId: 40, url: "https://opened.example", title: "Opened" }, { createId: ids });

  assert.equal(state.windows[0].placeholderTabId, null);
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].groupId, state.activeGroupId);
  assert.equal(state.tabs[0].url, "https://opened.example");
});

test("deleting the last group closes and forgets its tabs, then creates an empty Default", () => {
  const ids = idFactory();
  const state = createFirstRunState([
    { id: 501, windowId: 50, url: "https://gone.example" },
    { id: 502, windowId: 50, url: "https://also-gone.example" },
  ], { createId: ids });
  const result = deleteGroup(state, state.activeGroupId, { createId: ids });

  assert.deepEqual(result.closeTabs.map((tab) => tab.browserTabId), [501, 502]);
  assert.deepEqual(result.deletedTabIds, state.tabs.map((tab) => tab.id));
  assert.deepEqual(result.placeholderWindowIds, [50]);
  assert.equal(result.state.groups.length, 1);
  assert.equal(result.state.groups[0].name, "Default");
  assert.equal(result.state.activeGroupId, result.state.groups[0].id);
  assert.deepEqual(result.state.tabs, []);
});

test("deleting Default while other groups exist creates a replacement Default", () => {
  const ids = idFactory();
  let state = createFirstRunState([{ id: 601, windowId: 60, url: "https://deleted.example" }], { createId: ids });
  state = createGroup(state, { name: "Keep" }, { createId: ids });
  const defaultId = state.groups.find((group) => group.name === "Default").id;
  const result = deleteGroup(state, defaultId, { createId: ids });

  assert.equal(result.state.groups.some((group) => group.name === "Default"), true);
  assert.equal(result.state.groups.find((group) => group.name === "Keep").id, state.groups[1].id);
  assert.equal(result.state.tabs.length, 0);
});

test("deleting the active non-Default group activates Default across the model", () => {
  const ids = idFactory();
  let state = createEmptyState({ createId: ids });
  const defaultId = state.activeGroupId;
  state = createGroup(state, { name: "Work" }, { createId: ids });
  const workId = state.groups[1].id;
  state = { ...state, activeGroupId: workId };
  const result = deleteGroup(state, workId, { createId: ids });

  assert.equal(result.state.activeGroupId, defaultId);
  assert.deepEqual(result.state.groups.map((group) => group.name), ["Default"]);
});

test("renaming the final Default is rejected", () => {
  const state = createEmptyState({ createId: idFactory() });
  assert.throws(() => renameGroup(state, state.activeGroupId, "Work"), /must remain named Default/);
});

test("a pinned-only window stays open without an unnecessary group placeholder", () => {
  const ids = idFactory();
  let state = createFirstRunState([
    { id: 901, windowId: 90, url: "https://managed.example" },
    { id: 902, windowId: 91, url: "https://pinned.example", pinned: true },
  ], { createId: ids });
  state = createGroup(state, { name: "Empty" }, { createId: ids });
  const plan = planGroupSwitch(state, state.groups[1].id);
  assert.deepEqual(plan.closeWindowIds, [90]);
  assert.deepEqual(plan.placeholderWindowIds, []);
  assert.equal(plan.createTemporaryWindow, false);
});

test("closed tab snapshots remain restorable and duplicate URLs retain separate identities", () => {
  const ids = idFactory();
  let state = createFirstRunState([
    { id: 701, windowId: 70, url: "https://duplicate.example" },
    { id: 702, windowId: 70, url: "https://duplicate.example" },
  ], { createId: ids });
  const tabIds = state.tabs.map((tab) => tab.id);
  state = markTabClosed(state, 701, "session-a");

  assert.deepEqual(new Set(state.tabs.map((tab) => tab.id)), new Set(tabIds));
  assert.equal(state.tabs.find((tab) => tab.id === tabIds[0]).sessionId, "session-a");
  assert.equal(state.tabs.find((tab) => tab.id === tabIds[1]).status, "open");
});

test("manually closing one tab removes it, while closing a window keeps snapshots for later restoration", () => {
  const ids = idFactory();
  let state = createFirstRunState([
    { id: 1101, windowId: 110, url: "https://window.example" },
    { id: 1102, windowId: 110, url: "https://manual.example" },
  ], { createId: ids });
  const manualId = state.tabs.find((tab) => tab.browserTabId === 1102).id;
  state = handleTabRemoved(state, 1102);
  assert.equal(state.tabs.some((tab) => tab.id === manualId), false);

  const defaultId = state.activeGroupId;
  const windowTabId = state.tabs[0].id;
  state = handleTabRemoved(state, 1101, { isWindowClosing: true, windowId: 110 });
  assert.equal(state.tabs.some((tab) => tab.id === windowTabId), true);
  assert.equal(state.tabs.find((tab) => tab.id === windowTabId).status, "closed");
  assert.equal(state.windows[0].isOpen, false);

  state = createGroup(state, { name: "Later" }, { createId: ids });
  const laterId = state.groups[1].id;
  const toLater = planGroupSwitch(state, laterId);
  const toDefault = planGroupSwitch(toLater.state, defaultId);
  assert.deepEqual(toDefault.recreateWindowIds, [110]);
  assert.deepEqual(toDefault.restoreTabs.map((tab) => tab.id), [windowTabId]);
});

test("closing a nonfinal window forgets its active-group tabs but retains inactive snapshots", () => {
  const ids = idFactory();
  let state = createFirstRunState([
    { id: 1201, windowId: 120, url: "https://active.example" },
    { id: 1202, windowId: 120, url: "https://inactive.example" },
    { id: 1203, windowId: 120, url: "https://stale-active-snapshot.example" },
    { id: 1301, windowId: 130, url: "https://other-window.example" },
  ], { createId: ids });
  const activeGroupId = state.activeGroupId;
  const inactiveGroup = createGroup(state, { name: "Inactive" }, { createId: ids });
  const inactiveGroupId = inactiveGroup.groups[1].id;
  const inactiveSnapshot = state.tabs.find((tab) => tab.browserTabId === 1202);
  state = {
    ...inactiveGroup,
    tabs: inactiveGroup.tabs.map((tab) => tab.id === inactiveSnapshot.id
      ? { ...tab, groupId: inactiveGroupId, browserTabId: null, status: "closed", sessionId: "saved-inactive" }
      : tab.browserTabId === 1203
        ? { ...tab, browserTabId: null, status: "closed", sessionId: "stale-active-session" }
      : tab),
  };

  const closed = handleWindowRemoved(state, 120);
  assert.equal(closed.tabs.some((tab) => tab.browserTabId === 1201), false,
    "The active group's tabs in the closed window are forgotten.");
  assert.equal(closed.tabs.some((tab) => tab.url === "https://stale-active-snapshot.example"), false,
    "A stale closed snapshot in the active group must not revive contents of a user-closed window.");
  assert.deepEqual(closed.tabs.filter((tab) => tab.groupId === inactiveGroupId).map((tab) => tab.id), [inactiveSnapshot.id],
    "An inactive group's snapshot remains available even though it shares the logical window.");
  assert.equal(closed.tabs.find((tab) => tab.id === inactiveSnapshot.id).sessionId, "saved-inactive");
  assert.equal(closed.tabs.some((tab) => tab.groupId === activeGroupId && tab.browserWindowId === 130), true,
    "Closing one window leaves the active group's other window alone.");
  assert.equal(closed.windows.find((window) => window.browserWindowId === 120).isOpen, false);

  const repeated = handleWindowRemoved(closed, 120);
  assert.deepEqual(repeated, closed, "Repeated window-close events are idempotent.");
});

test("closing the final window through tab and window events preserves all group snapshots", () => {
  const ids = idFactory();
  let state = createFirstRunState([
    { id: 1401, windowId: 140, url: "https://current.example" },
  ], { createId: ids });
  const currentTabId = state.tabs[0].id;
  const closedAtFinalWindow = handleTabRemoved(state, 1401, {
    isWindowClosing: true,
    windowId: 140,
  });
  const afterWindowEvent = handleWindowRemoved(closedAtFinalWindow, 140, { preserveTabs: true });

  assert.equal(afterWindowEvent.tabs.length, 1);
  assert.equal(afterWindowEvent.tabs[0].id, currentTabId);
  assert.equal(afterWindowEvent.tabs[0].status, "closed");
  assert.equal(afterWindowEvent.tabs[0].browserTabId, null);
  assert.equal(afterWindowEvent.windows[0].isOpen, false);
});

test("pinned and incognito tabs are ignored when assigned after first run", () => {
  const ids = idFactory();
  const state = createEmptyState({ createId: ids });
  const pinned = assignTab(state, { id: 801, windowId: 80, pinned: true });
  const privateTab = assignTab(pinned, { id: 802, windowId: 81, incognito: true });
  assert.equal(pinned.tabs.length, 0);
  assert.deepEqual(pinned.windows[0].pinnedTabIds, [801]);
  assert.equal(privateTab, pinned);
  const unpinned = assignTab(pinned, { id: 801, windowId: 80, url: "https://unpinned.example" });
  assert.equal(unpinned.tabs.length, 1);
  assert.deepEqual(unpinned.windows[0].pinnedTabIds, []);
});

test("pinning a managed tab removes it from its group and unpinning adopts it into the active group", () => {
  const ids = idFactory();
  const state = createFirstRunState([{ id: 1001, windowId: 100, url: "https://pin.example" }], { createId: ids });
  const pinned = assignTab(state, { id: 1001, windowId: 100, pinned: true });
  assert.equal(pinned.tabs.length, 0);
  assert.deepEqual(pinned.windows[0].pinnedTabIds, [1001]);

  const unpinned = assignTab(pinned, { id: 1001, windowId: 100, url: "https://pin.example" });
  assert.equal(unpinned.tabs.length, 1);
  assert.equal(unpinned.tabs[0].groupId, unpinned.activeGroupId);
});

test("deterministic operation sequences preserve group and tab ownership invariants", () => {
  const ids = idFactory();
  let state = createEmptyState({ createId: ids });
  let seed = 0x5eed;
  const random = (maximum) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % maximum;
  };

  for (let step = 0; step < 120; step += 1) {
    const operation = random(5);
    if (operation === 0) {
      state = createGroup(state, { name: `Group ${step}` }, { createId: ids });
    } else if (operation === 1) {
      state = assignTab(state, {
        id: 2000 + step,
        windowId: 200 + random(4),
        url: `https://generated-${step}.example`,
      }, state.activeGroupId, { createId: ids });
    } else if (operation === 2 && state.tabs.length) {
      const tab = state.tabs[random(state.tabs.length)];
      const group = state.groups[random(state.groups.length)];
      state = moveTab(state, tab.id, group.id).state;
    } else if (operation === 3 && state.groups.length > 1) {
      const deletable = state.groups.filter((group) => group.name !== "Default");
      const group = deletable[random(deletable.length)];
      state = deleteGroup(state, group.id, { createId: ids }).state;
    } else {
      const group = state.groups[random(state.groups.length)];
      state = planGroupSwitch(state, group.id).state;
    }

    const groupIds = new Set(state.groups.map((group) => group.id));
    const tabIds = state.tabs.map((tab) => tab.id);
    assert.equal(state.groups.filter((group) => group.name === "Default").length, 1);
    assert.equal(new Set(state.groups.map((group) => group.name.toLocaleLowerCase())).size, state.groups.length);
    assert.equal(state.groups.every((group, index) => group.order === index), true);
    assert.equal(groupIds.has(state.activeGroupId), true);
    assert.equal(new Set(tabIds).size, tabIds.length);
    assert.equal(state.tabs.every((tab) => groupIds.has(tab.groupId)), true);
    assert.equal(state.tabs.every((tab) => Number.isInteger(tab.browserWindowId)), true);
  }
});
