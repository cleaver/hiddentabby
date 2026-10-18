import test from "node:test";
import assert from "node:assert/strict";
import { createGroup } from "../../src/group-state.js";
import { StateStore } from "../../src/state-store.js";
import { createInitialStateFactory, WorkspaceController } from "../../src/workspace-controller.js";

class MemoryStorage {
  values = new Map();

  async get(key) {
    return this.values.has(key) ? { [key]: structuredClone(this.values.get(key)) } : {};
  }

  async set(key, value) {
    this.values.set(key, structuredClone(value));
  }
}

function browserHarness(windows) {
  const calls = [];
  let nextTabId = 900;
  let nextWindowId = 60;
  const browser = {
    placeholderUrl: "chrome-extension://test/placeholder.html",
    isPlaceholderUrl: (url) => typeof url === "string" && url.startsWith("chrome-extension://test/placeholder.html"),
    getPlaceholderWindowKey(url) {
      try {
        return this.isPlaceholderUrl(url) ? new URL(url).searchParams.get("window") : null;
      } catch {
        return null;
      }
    },
    async getNormalWindows() {
      return structuredClone(windows.filter((window) => !window.incognito && window.type === "normal"));
    },
    async getTab(tabId) {
      return structuredClone(windows.flatMap((window) => window.tabs ?? []).find((tab) => tab.id === tabId));
    },
    async adoptInitialTabs(state) { calls.push(["adopt", state]); },
    async updateNativeGroups(state) { calls.push(["updateGroups", state]); },
    async createMoveMenu(state) { calls.push(["menu", state]); },
    async groupManagedTabs(state, groupId, windowId) { calls.push(["group", groupId, windowId]); },
    async removeTabs(ids) {
      calls.push(["remove", ids]);
      for (const window of windows) window.tabs = (window.tabs ?? []).filter((tab) => !ids.includes(tab.id));
    },
    async createPlaceholder(windowId, logicalWindowId) {
      const url = logicalWindowId ? `${this.placeholderUrl}?window=${logicalWindowId}` : this.placeholderUrl;
      const tab = { id: 90 + windowId, windowId, index: 0, url, title: "New Tab" };
      const window = windows.find((item) => item.id === windowId);
      window.tabs.push(tab);
      calls.push(["placeholder", windowId, tab.id]);
      return structuredClone(tab);
    },
    async createWindowWithPlaceholder(logicalWindowId) {
      const windowId = nextWindowId++;
      const url = `${this.placeholderUrl}?window=${logicalWindowId}`;
      const placeholder = { id: nextTabId++, windowId, index: 0, url, title: "New Tab" };
      windows.push({ id: windowId, type: "normal", incognito: false, tabs: [placeholder] });
      calls.push(["createWindowWithPlaceholder", windowId, placeholder.id]);
      return { windowId, placeholderTabId: placeholder.id };
    },
    async createTab(properties) {
      const id = nextTabId++;
      const tab = { id, windowId: properties.windowId, index: properties.index ?? 0, active: properties.active, url: properties.url ?? "chrome://newtab/", title: "Restored" };
      const window = windows.find((item) => item.id === properties.windowId);
      window.tabs.push(tab);
      calls.push(["createTab", structuredClone(properties), id]);
      return structuredClone(tab);
    },
    async restoreSession(sessionId) {
      calls.push(["restore", sessionId]);
      const id = nextTabId++;
      const tab = { id, windowId: sessionId.includes("20") ? 20 : 10, index: 2, url: `https://${sessionId}.example`, title: "Restored" };
      const window = windows.find((item) => item.id === tab.windowId);
      window?.tabs.push(tab);
      return { tab };
    },
    async getRecentlyClosed() { return []; },
    async moveTabToWindow(tabId, windowId, index) {
      calls.push(["moveToWindow", tabId, windowId, index]);
      const tab = windows.flatMap((window) => window.tabs ?? []).find((item) => item.id === tabId);
      if (!tab) throw new Error("tab missing");
      for (const window of windows) window.tabs = (window.tabs ?? []).filter((item) => item.id !== tabId);
      tab.windowId = windowId;
      tab.index = index;
      windows.find((window) => window.id === windowId)?.tabs.push(tab);
      return structuredClone(tab);
    },
    async orderTabs(tabIds, windowId) {
      calls.push(["orderTabs", [...tabIds], windowId]);
    },
    async findMatchingTab(snapshot, windowId, excluded = []) {
      return structuredClone(windows.find((window) => window.id === windowId)?.tabs
        .find((tab) => !excluded.includes(tab.id) && !tab.pinned && tab.url === snapshot.url && tab.title === snapshot.title) ?? null);
    },
    async activateTab(tabId) { calls.push(["activate", tabId]); },
  };
  return { browser, calls };
}

function normalWindow(id = 10) {
  return {
    id,
    type: "normal",
    incognito: false,
    tabs: [
      { id: id * 10 + 1, windowId: id, index: 0, groupId: 4, url: "https://one.example", title: "One" },
      { id: id * 10 + 2, windowId: id, index: 1, groupId: 4, pinned: true, url: "https://pinned.example", title: "Pinned" },
    ],
  };
}

function setup(windows = [normalWindow()]) {
  const storage = new MemoryStorage();
  const { browser, calls } = browserHarness(windows);
  const store = new StateStore(storage, { createInitialState: createInitialStateFactory(browser) });
  return { storage, browser, calls, store, controller: new WorkspaceController({ store, browser }) };
}

test("first startup adopts only normal unpinned tabs into Default", async () => {
  const privateWindow = { id: 50, type: "normal", incognito: true, tabs: [{ id: 501, windowId: 50, url: "https://private.example" }] };
  const popupWindow = { id: 51, type: "popup", incognito: false, tabs: [{ id: 511, windowId: 51, url: "https://popup.example" }] };
  const { controller, calls } = setup([normalWindow(), privateWindow, popupWindow]);
  const state = await controller.getState();

  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0].name, "Default");
  assert.deepEqual(state.tabs.map((tab) => tab.browserTabId), [101]);
  assert.deepEqual(state.windows[0].pinnedTabIds, [102]);
  assert.equal(calls.filter(([name]) => name === "adopt").length, 1);
  assert.equal(calls.some(([name]) => name === "updateGroups"), false);
});

test("restart reconciles live tabs and does not repeat first-run adoption", async () => {
  const windows = [normalWindow()];
  const first = setup(windows);
  const initial = await first.controller.getState();
  const storage = first.storage;
  const { browser, calls } = browserHarness(windows);
  const store = new StateStore(storage, { createInitialState: createInitialStateFactory(browser) });
  const restarted = new WorkspaceController({ store, browser });

  const state = await restarted.getState();
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].groupId, initial.activeGroupId);
  assert.equal(calls.some(([name]) => name === "adopt"), false);
  assert.equal(calls.filter(([name]) => name === "updateGroups").length, 1);
});

test("a tab close that wakes the worker is forgotten across a four-group round trip", async () => {
  const windows = [normalWindow()];
  const first = setup(windows);
  const initial = await first.controller.getState();
  const removed = initial.tabs.find((tab) => tab.browserTabId === 101);
  const groupIds = [initial.activeGroupId];
  for (const name of ["Second", "Third", "Fourth"]) {
    const state = await first.controller.createGroup({ name });
    groupIds.push(state.groups.find((group) => group.name === name).id);
  }

  // The worker was stopped before Chrome dispatched the user's close event.
  windows[0].tabs = windows[0].tabs.filter((tab) => tab.id !== 101);
  const store = new StateStore(first.storage, { createInitialState: createInitialStateFactory(first.browser) });
  const restarted = new WorkspaceController({ store, browser: first.browser });
  await restarted.onTabRemoved(101, { windowId: 10, isWindowClosing: false });

  assert.equal((await restarted.getState()).tabs.some((tab) => tab.id === removed.id), false,
    "Startup must not turn a manually closed tab into a saved snapshot.");
  for (const groupId of [...groupIds.slice(1), groupIds[0]]) await restarted.switchGroup(groupId);
  assert.equal((await restarted.getState()).tabs.some((tab) => tab.id === removed.id), false);
  assert.equal(windows[0].tabs.some((tab) => tab.url === removed.url), false,
    "Switching back must never recreate the closed tab.");
});

test("multiple closes arriving during startup persistence forget only the closed duplicate records", async () => {
  const windows = [normalWindow()];
  windows[0].tabs.push(
    { ...windows[0].tabs[0], id: 103, index: 2 },
    { ...windows[0].tabs[0], id: 104, index: 3 },
  );
  const first = setup(windows);
  const initial = await first.controller.getState();
  const survivor = initial.tabs.find((tab) => tab.browserTabId === 104);
  windows[0].tabs = windows[0].tabs.filter((tab) => ![101, 103].includes(tab.id));

  let releaseWrite;
  let notifyWrite;
  const writeStarted = new Promise((resolve) => { notifyWrite = resolve; });
  const writeReleased = new Promise((resolve) => { releaseWrite = resolve; });
  const set = first.storage.set.bind(first.storage);
  let blockFirstWrite = true;
  first.storage.set = async (key, value) => {
    if (blockFirstWrite) {
      blockFirstWrite = false;
      notifyWrite();
      await writeReleased;
    }
    return set(key, value);
  };
  const store = new StateStore(first.storage, { createInitialState: createInitialStateFactory(first.browser) });
  const restarted = new WorkspaceController({ store, browser: first.browser });
  const starting = restarted.getState();
  await writeStarted;
  const removals = [101, 103].map((id) => restarted.onTabRemoved(id, {
    windowId: 10, isWindowClosing: false,
  }));
  releaseWrite();
  await Promise.all([starting, ...removals]);

  const remaining = (await restarted.getState()).tabs;
  assert.deepEqual(remaining.map((tab) => tab.id), [survivor.id],
    "Late startup close events must remove their original records while retaining a legitimate duplicate.");
  const reloaded = new StateStore(first.storage);
  assert.deepEqual((await reloaded.load()).tabs.map((tab) => tab.id), [survivor.id],
    "The removals must also be durable.");
});

test("a close delivered during native-group setup still uses its original startup identity", async () => {
  const windows = [normalWindow()];
  const first = setup(windows);
  const initial = await first.controller.getState();
  windows[0].tabs = windows[0].tabs.filter((tab) => tab.id !== 101);
  let nativeSetupStarted;
  let releaseNativeSetup;
  const nativeStarted = new Promise((resolve) => { nativeSetupStarted = resolve; });
  const nativeReleased = new Promise((resolve) => { releaseNativeSetup = resolve; });
  first.browser.updateNativeGroups = async () => {
    nativeSetupStarted();
    await nativeReleased;
  };
  const store = new StateStore(first.storage, { createInitialState: createInitialStateFactory(first.browser) });
  const restarted = new WorkspaceController({ store, browser: first.browser });
  const starting = restarted.getState();
  await nativeStarted;
  const removal = restarted.onTabRemoved(101, { windowId: 10, isWindowClosing: false });
  releaseNativeSetup();
  await Promise.all([starting, removal]);

  assert.equal((await restarted.getState()).tabs.some((tab) => tab.id === initial.tabs[0].id), false);
});

test("startup retries retain a manual removal when its first storage write fails", async () => {
  const windows = [normalWindow()];
  const first = setup(windows);
  const initial = await first.controller.getState();
  windows[0].tabs = windows[0].tabs.filter((tab) => tab.id !== 101);
  const set = first.storage.set.bind(first.storage);
  let failOnce = true;
  first.storage.set = async (key, value) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("injected startup storage failure");
    }
    return set(key, value);
  };
  const store = new StateStore(first.storage, { createInitialState: createInitialStateFactory(first.browser) });
  const restarted = new WorkspaceController({ store, browser: first.browser });
  await assert.rejects(restarted.onTabRemoved(101, { windowId: 10, isWindowClosing: false }),
    /injected startup storage failure/);

  const retried = await restarted.getState();
  assert.equal(retried.tabs.some((tab) => tab.id === initial.tabs[0].id), false,
    "A failed startup write must not discard the pending removal intent.");
  assert.equal((await new StateStore(first.storage).load()).tabs.length, 0);
});

test("a window close that wakes the worker still preserves dormant tab snapshots", async () => {
  const windows = [normalWindow()];
  const first = setup(windows);
  const initial = await first.controller.getState();
  windows.splice(0);
  const store = new StateStore(first.storage, { createInitialState: createInitialStateFactory(first.browser) });
  const restarted = new WorkspaceController({ store, browser: first.browser });
  await restarted.onTabRemoved(101, { windowId: 10, isWindowClosing: true });

  const state = await restarted.getState();
  assert.equal(state.tabs[0].id, initial.tabs[0].id);
  assert.equal(state.tabs[0].status, "closed");
  assert.equal(state.windows[0].isOpen, false);
});

test("placeholder keys reconnect empty windows to their stable records after browser IDs change", async () => {
  const first = setup([normalWindow(10), normalWindow(20)]);
  const saved = await first.controller.getState();
  const [logicalA, logicalB] = saved.windows.map((window) => window.id);
  await first.store.update((state) => ({
    ...state,
    windows: state.windows.map((window) => ({ ...window, isOpen: false, placeholderTabId: null, pinnedTabIds: [] })),
    tabs: state.tabs.map((tab) => ({ ...tab, browserTabId: null, status: "closed" })),
  }));

  const restartedWindows = [
    { id: 30, type: "normal", incognito: false, tabs: [{ id: 301, windowId: 30, index: 0, url: `chrome-extension://test/placeholder.html?window=${logicalA}`, title: "New Tab" }] },
    { id: 40, type: "normal", incognito: false, tabs: [{ id: 401, windowId: 40, index: 0, url: `chrome-extension://test/placeholder.html?window=${logicalB}`, title: "New Tab" }] },
  ];
  const { browser } = browserHarness(restartedWindows);
  const store = new StateStore(first.storage, { createInitialState: createInitialStateFactory(browser) });
  const restarted = new WorkspaceController({ store, browser });
  const state = await restarted.getState();

  assert.deepEqual(state.windows.map((window) => [window.id, window.browserWindowId, window.placeholderTabId]), [
    [logicalA, 30, 301],
    [logicalB, 40, 401],
  ]);
  assert.equal(state.tabs.every((tab) => tab.status === "closed"), true);
});

test("new tabs join the active group while incognito and placeholders are ignored", async () => {
  const windows = [normalWindow()];
  const { controller, calls } = setup(windows);
  const initial = await controller.getState();
  const newTab = {
    id: 103, windowId: 10, index: 2, url: "https://new.example", title: "New",
  };
  windows[0].tabs.push(newTab);
  const added = await controller.onTabCreated(newTab);
  assert.equal(added.tabs.find((tab) => tab.browserTabId === 103).groupId, initial.activeGroupId);

  const afterPrivate = await controller.onTabCreated({
    id: 104, windowId: 20, incognito: true, url: "https://private.example",
  });
  assert.equal(afterPrivate.tabs.some((tab) => tab.browserTabId === 104), false);

  const afterPlaceholder = await controller.onTabCreated({
    id: 105,
    windowId: 10,
    url: "about:blank",
    pendingUrl: "chrome-extension://test/placeholder.html?window=logical-window",
  });
  assert.equal(afterPlaceholder.tabs.some((tab) => tab.browserTabId === 105), false);
  assert.equal(calls.some(([name, id]) => name === "group" && id === initial.activeGroupId), true);
});

test("restored tab creation reconnects a closed snapshot instead of duplicating it", async () => {
  const windows = [normalWindow()];
  const { controller, store } = setup(windows);
  const initial = await controller.getState();
  const snapshot = initial.tabs[0];
  await store.update((state) => ({
    ...state,
    tabs: state.tabs.map((tab) => ({ ...tab, browserTabId: null, status: "closed" })),
  }));

  const restoredTab = {
    id: 103,
    windowId: 10,
    index: 2,
    url: snapshot.url,
    title: snapshot.title,
  };
  windows[0].tabs.push(restoredTab);
  const state = await controller.onTabCreated(restoredTab);

  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].id, snapshot.id);
  assert.equal(state.tabs[0].browserTabId, restoredTab.id);
  assert.equal(state.tabs[0].status, "open");
});

test("tab creation events that race with removal do not leave stale open records", async () => {
  const windows = [normalWindow()];
  const { controller, browser } = setup(windows);
  await controller.getState();
  const createdTab = {
    id: 103,
    windowId: 10,
    index: 2,
    url: "https://raced-away.example",
    title: "Raced away",
  };
  windows[0].tabs.push(createdTab);
  browser.groupManagedTabs = async () => {
    windows[0].tabs = windows[0].tabs.filter((tab) => tab.id !== createdTab.id);
  };

  const state = await controller.onTabCreated(createdTab);
  assert.equal(state.tabs.some((tab) => tab.browserTabId === createdTab.id), false);
});

test("pinning removes a tab from groups and unpinning assigns it to the active group", async () => {
  const window = normalWindow();
  window.tabs.push({ id: 103, windowId: 10, index: 2, url: "https://second.example", title: "Second" });
  const { controller, calls } = setup([window]);
  await controller.getState();
  const groupId = (await controller.getState()).activeGroupId;
  const pinned = await controller.onTabUpdated(101, { pinned: true }, {
    id: 101, windowId: 10, pinned: true, index: 0, url: "https://one.example", title: "One",
  });
  assert.equal(pinned.tabs.some((tab) => tab.browserTabId === 101), false);
  assert.deepEqual(pinned.windows[0].pinnedTabIds.sort(), [101, 102]);
  assert.deepEqual(calls.at(-1), ["group", groupId, 10],
    "Pinning one of two members must refresh the remaining singleton native grouping.");

  const unpinned = await controller.onTabUpdated(101, { pinned: false }, {
    id: 101, windowId: 10, pinned: false, index: 0, url: "https://one.example", title: "One",
  });
  assert.equal(unpinned.tabs.find((tab) => tab.browserTabId === 101).groupId, unpinned.activeGroupId);
  assert.equal(unpinned.windows[0].pinnedTabIds.includes(101), false);
  assert.deepEqual(calls.at(-1), ["group", groupId, 10],
    "Unpinning a second member must restore native grouping for the two managed tabs.");
});

test("placeholder navigation promotes it into the active group", async () => {
  const { controller, store, browser, calls } = setup();
  await controller.getState();
  await store.update((state) => ({
    ...state,
    windows: state.windows.map((window) => ({ ...window, placeholderTabId: 900 })),
  }));
  const state = await controller.onTabUpdated(900, { url: "https://promoted.example" }, {
    id: 900, windowId: 10, index: 0, url: "https://promoted.example", title: "Promoted",
  });

  assert.equal(state.tabs.find((tab) => tab.browserTabId === 900).groupId, state.activeGroupId);
  assert.equal(state.windows[0].placeholderTabId, null);
  assert.deepEqual(calls.at(-1), ["group", state.activeGroupId, 10]);
  assert.equal(browser.isPlaceholderUrl("https://promoted.example"), false);
});

test("placeholder promotion uses the navigation URL while the tab still reports its old URL", async () => {
  const { controller, store } = setup();
  await controller.getState();
  await store.update((state) => ({
    ...state,
    windows: state.windows.map((window) => ({ ...window, placeholderTabId: 900 })),
  }));

  const state = await controller.onTabUpdated(900, { url: "https://pending-promotion.example" }, {
    id: 900,
    windowId: 10,
    index: 0,
    url: "chrome-extension://test/placeholder.html",
    pendingUrl: "https://pending-promotion.example",
    title: "New Tab",
  });

  const promoted = state.tabs.find((tab) => tab.browserTabId === 900);
  assert.equal(promoted.url, "https://pending-promotion.example");
  assert.equal(promoted.groupId, state.activeGroupId);
  assert.equal(state.windows[0].placeholderTabId, null);
});

test("manual tab close forgets one record while window close keeps dormant group snapshots", async () => {
  const { controller, calls } = setup();
  const initial = await controller.getState();
  const groupId = initial.activeGroupId;
  const afterManualClose = await controller.onTabRemoved(101, { windowId: 10, isWindowClosing: false });
  assert.equal(afterManualClose.tabs.some((tab) => tab.browserTabId === 101), false);
  assert.equal(afterManualClose.groups.some((group) => group.id === groupId), true,
    "Closing the group's only tab must not delete the HiddenTabby group.");
  assert.equal(afterManualClose.windows[0].isOpen, true);
  assert.notEqual(afterManualClose.windows[0].placeholderTabId, null,
    "An open window emptied by a manual tab close receives the normal placeholder.");
  assert.ok(calls.some(([name, nativeGroupId, windowId]) => name === "group"
    && nativeGroupId === groupId && windowId === 10),
  "Manual close reconciles native membership for the now-empty group/window pair.");

  const { controller: windowController } = setup();
  await windowController.getState();
  const afterWindowClose = await windowController.onTabRemoved(101, { windowId: 10, isWindowClosing: true });
  assert.equal(afterWindowClose.tabs.length, 1);
  assert.equal(afterWindowClose.tabs[0].status, "closed");
  assert.equal(afterWindowClose.tabs[0].browserTabId, null);
  assert.equal(afterWindowClose.windows[0].isOpen, false);
});

test("a tab closed just before switching is not resurrected when its removal event races the switch", async () => {
  const windows = [normalWindow()];
  const { controller, store, browser } = setup(windows);
  const initial = await controller.getState();
  const manuallyClosedRecord = initial.tabs.find((tab) => tab.browserTabId === 101);
  let destinationGroupId;
  await store.update((state) => {
    const next = createGroup(state, { name: "Empty destination" });
    destinationGroupId = next.groups.find((group) => group.name === "Empty destination").id;
    return next;
  });

  // The browser has already closed the tab, but Chrome's onRemoved event has
  // not reached the controller when the popup's switch command is handled.
  windows[0].tabs = windows[0].tabs.filter((tab) => tab.id !== 101);
  const removeTabs = browser.removeTabs.bind(browser);
  let signalRemoveStarted;
  const removeStarted = new Promise((resolve) => { signalRemoveStarted = resolve; });
  let releaseRemove;
  const removeGate = new Promise((resolve) => { releaseRemove = resolve; });
  browser.removeTabs = async (tabIds) => {
    signalRemoveStarted();
    await removeGate;
    await removeTabs(tabIds);
  };

  const switchAway = controller.switchGroup(destinationGroupId);
  await removeStarted;
  const delayedRemoval = controller.onTabRemoved(101, { windowId: 10, isWindowClosing: false });
  releaseRemove();
  await switchAway;
  const removalState = await delayedRemoval;
  assert.equal(removalState.tabs.some((tab) => tab.id === manuallyClosedRecord.id), false,
    "A pending switch must discard a snapshot already absent from the live browser.");

  const restoredDefault = await controller.switchGroup(initial.activeGroupId);
  assert.equal(restoredDefault.state.tabs.some((tab) => tab.id === manuallyClosedRecord.id), false,
    "A manually closed tab must not return when switching back to Default.");
});

test("a manual close during switch preparation removes that tab from the pending restore", async () => {
  const window = normalWindow();
  window.tabs.push({ id: 103, windowId: 10, index: 2, url: "https://www.madcss.com/", title: "MadCSS" });
  const windows = [window];
  const { controller, store, browser } = setup(windows);
  const initial = await controller.getState();
  const manuallyClosedRecord = initial.tabs.find((tab) => tab.browserTabId === 103);
  let destinationGroupId;
  await store.update((state) => {
    const next = createGroup(state, { name: "Empty destination" });
    destinationGroupId = next.groups.find((group) => group.name === "Empty destination").id;
    return next;
  });

  let signalRecentlyClosed;
  const recentlyClosedStarted = new Promise((resolve) => { signalRecentlyClosed = resolve; });
  let releaseRecentlyClosed;
  const recentlyClosedGate = new Promise((resolve) => { releaseRecentlyClosed = resolve; });
  browser.getRecentlyClosed = async () => {
    signalRecentlyClosed();
    await recentlyClosedGate;
    return [];
  };

  const switchAway = controller.switchGroup(destinationGroupId);
  await recentlyClosedStarted;
  windows[0].tabs = windows[0].tabs.filter((tab) => tab.id !== 103);
  await controller.onTabRemoved(103, { windowId: 10, isWindowClosing: false });
  releaseRecentlyClosed();
  const switched = await switchAway;

  assert.equal(switched.state.tabs.some((tab) => tab.id === manuallyClosedRecord.id), false,
    "The manually closed MadCSS tab must not remain in the pending group-switch restore set.");
  const restoredDefault = await controller.switchGroup(initial.activeGroupId);
  assert.equal(restoredDefault.state.tabs.some((tab) => tab.id === manuallyClosedRecord.id), false,
    "Switching back to Default must not restore the MadCSS tab that closed during switch preparation.");
});

test("a manual close during an inactive-group move removes the pending moved snapshot", async () => {
  const window = normalWindow();
  window.tabs.push({ id: 103, windowId: 10, index: 2, url: "https://www.madcss.com/", title: "MadCSS" });
  const windows = [window];
  const { controller, store, browser } = setup(windows);
  const initial = await controller.getState();
  const manuallyClosedRecord = initial.tabs.find((tab) => tab.browserTabId === 103);
  let destinationGroupId;
  await store.update((state) => {
    const next = createGroup(state, { name: "Later" });
    destinationGroupId = next.groups.find((group) => group.name === "Later").id;
    return next;
  });

  let signalRecentlyClosed;
  const recentlyClosedStarted = new Promise((resolve) => { signalRecentlyClosed = resolve; });
  let releaseRecentlyClosed;
  const recentlyClosedGate = new Promise((resolve) => { releaseRecentlyClosed = resolve; });
  browser.getRecentlyClosed = async () => {
    signalRecentlyClosed();
    await recentlyClosedGate;
    return [];
  };

  const move = controller.moveTab(103, destinationGroupId);
  await recentlyClosedStarted;
  windows[0].tabs = windows[0].tabs.filter((tab) => tab.id !== 103);
  await controller.onTabRemoved(103, { windowId: 10, isWindowClosing: false });
  releaseRecentlyClosed();
  const moved = await move;

  assert.equal(moved.tabs.some((tab) => tab.id === manuallyClosedRecord.id), false,
    "An inactive-group move must not retain a tab manually closed before its close request.");
});

test("closing a tab refreshes native grouping for the remaining tabs in its window", async () => {
  const window = normalWindow();
  window.tabs.push({ id: 103, windowId: 10, index: 2, url: "https://second.example", title: "Second" });
  const { controller, calls } = setup([window]);
  const initial = await controller.getState();
  const groupId = initial.tabs.find((tab) => tab.browserTabId === 101).groupId;

  const updated = await controller.onTabRemoved(101, { windowId: 10, isWindowClosing: false });

  assert.equal(updated.groups.some((group) => group.id === groupId), true,
    "Closing a tab must not delete its HiddenTabby group.");
  assert.equal(updated.tabs.some((tab) => tab.browserTabId === 103 && tab.groupId === groupId), true);
  assert.ok(calls.some(([name, nativeGroupId, windowId]) => name === "group"
    && nativeGroupId === groupId && windowId === 10),
  "After a close, synchronize the remaining membership so a singleton can be ungrouped natively.");
});

test("manual tab reordering updates every saved index in the affected window", async () => {
  const window = normalWindow();
  window.tabs.push({ id: 103, windowId: 10, index: 2, url: "https://second.example", title: "Second" });
  const { controller } = setup([window]);
  const initial = await controller.getState();
  const firstRecord = initial.tabs.find((tab) => tab.browserTabId === 101);
  const secondRecord = initial.tabs.find((tab) => tab.browserTabId === 103);

  window.tabs.find((tab) => tab.id === 101).index = 2;
  window.tabs.find((tab) => tab.id === 103).index = 1;
  const reordered = await controller.onTabMoved(103, { windowId: 10, fromIndex: 2, toIndex: 1 });

  assert.equal(reordered.tabs.find((tab) => tab.id === firstRecord.id).index, 2);
  assert.equal(reordered.tabs.find((tab) => tab.id === secondRecord.id).index, 1);
});

test("moving a tab between windows preserves its group and closes the emptied source window record", async () => {
  const windows = [normalWindow(10), normalWindow(20)];
  windows[0].tabs.push({ id: 103, windowId: 10, index: 2, url: "https://second.example", title: "Second" });
  const { controller, calls } = setup(windows);
  const initial = await controller.getState();
  const groupId = initial.activeGroupId;
  const attached = await controller.onTabAttached(101, { newWindowId: 20, newPosition: 3 });
  assert.equal(attached.tabs.find((tab) => tab.browserTabId === 101).browserWindowId, 20);
  assert.deepEqual(calls.filter(([name]) => name === "group").slice(-2), [
    ["group", groupId, 10],
    ["group", groupId, 20],
  ], "Cross-window transfer must refresh both the source singleton and destination native group.");
  windows[0].tabs = [];

  const afterRemoval = await controller.onWindowRemoved(10);
  assert.equal(afterRemoval.windows.find((window) => window.browserWindowId === 10).isOpen, false);
  assert.equal(afterRemoval.tabs.find((tab) => tab.browserTabId === 101).status, "open");
  assert.equal(afterRemoval.tabs.find((tab) => tab.browserTabId === 101).browserWindowId, 20);
});

test("global switching closes every active group tab and restores target tabs per window", async () => {
  const windows = [10, 20].map((windowId) => ({
    id: windowId,
    type: "normal",
    incognito: false,
    tabs: [
      { id: windowId * 10 + 1, windowId, index: 0, active: true, url: `https://default-${windowId}.example`, title: `Default ${windowId}` },
      { id: windowId * 10 + 2, windowId, index: 1, url: `https://work-${windowId}.example`, title: `Work ${windowId}` },
      { id: windowId * 10 + 3, windowId, index: 2, pinned: true, url: "https://pin.example", title: "Pinned" },
    ],
  }));
  const { controller, store, calls, browser } = setup(windows);
  await controller.getState();
  let workGroupId;
  await store.update((state) => {
    const withWork = createGroup(state, { name: "Work" });
    workGroupId = withWork.groups.find((group) => group.name === "Work").id;
    return {
      ...withWork,
      tabs: withWork.tabs.map((tab) => tab.index === 1
        ? { ...tab, groupId: workGroupId, browserTabId: null, status: "closed", sessionId: `session-${tab.browserWindowId}` }
        : tab),
    };
  });
  // Model the inactive group's tabs as already suspended in the browser.
  await browser.removeTabs([102, 202]);
  calls.length = 0;

  const result = await controller.switchGroup(workGroupId);
  assert.equal(result.state.activeGroupId, workGroupId);
  assert.equal(result.failures.length, 0);
  assert.deepEqual(result.state.tabs.filter((tab) => tab.groupId === workGroupId).map((tab) => tab.status), ["open", "open"]);
  assert.deepEqual(result.state.tabs.filter((tab) => tab.groupId !== workGroupId).map((tab) => tab.status), ["closed", "closed"]);
  assert.equal(result.state.windows.every((window) => window.placeholderTabId === null), true);
  assert.deepEqual(calls.filter(([name]) => name === "remove").flatMap(([, ids]) => ids).sort((a, b) => a - b), [100, 101, 110, 201]);
  assert.deepEqual(calls.filter(([name]) => name === "restore").map(([, id]) => id).sort(), ["session-10", "session-20"]);
});

test("expired sessions restore from saved URLs and restricted URLs fall back to New Tab", async () => {
  const { controller, store, browser, calls } = setup();
  const initial = await controller.getState();
  const activeRecord = initial.tabs.find((tab) => tab.browserTabId === 101);
  let destinationId;
  let snapshots;
  await store.update((state) => {
    const withWork = createGroup(state, { name: "Work" });
    destinationId = withWork.groups.find((group) => group.name === "Work").id;
    snapshots = [
      {
        ...activeRecord,
        id: "expired-session-snapshot",
        groupId: destinationId,
        browserTabId: null,
        url: "https://saved-fallback.example",
        title: "Saved fallback",
        index: 0,
        status: "closed",
        sessionId: "expired-session",
      },
      {
        ...activeRecord,
        id: "restricted-url-snapshot",
        groupId: destinationId,
        browserTabId: null,
        url: "chrome://settings/",
        title: "Restricted page",
        index: 1,
        status: "closed",
        sessionId: "expired-restricted-session",
      },
    ];
    return { ...withWork, tabs: [...withWork.tabs, ...snapshots] };
  });

  browser.restoreSession = async (sessionId) => {
    calls.push(["restore", sessionId]);
    return null;
  };
  const createTab = browser.createTab.bind(browser);
  browser.createTab = async (properties) => {
    if (properties.url === "chrome://settings/") {
      throw new Error("The browser does not permit creating an internal settings page.");
    }
    return createTab(properties);
  };

  const result = await controller.switchGroup(destinationId);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(calls.filter(([name]) => name === "restore").map(([, id]) => id).sort(),
    ["expired-restricted-session", "expired-session"]);

  const restoredFallback = result.state.tabs.find((tab) => tab.id === "expired-session-snapshot");
  assert.equal(restoredFallback.url, "https://saved-fallback.example");
  assert.equal(restoredFallback.status, "open");
  assert.equal(restoredFallback.sessionId, null);

  const restrictedFallback = result.state.tabs.find((tab) => tab.id === "restricted-url-snapshot");
  assert.equal(restrictedFallback.url, "chrome://newtab/");
  assert.equal(restrictedFallback.title, "Restored");
  assert.equal(restrictedFallback.status, "open");
  assert.equal(restrictedFallback.sessionId, null);
  assert.deepEqual(calls.filter(([name]) => name === "createTab").map(([, properties]) => properties), [
    { windowId: 10, index: 0, active: false, url: "https://saved-fallback.example" },
    { windowId: 10, index: 1, active: false },
  ]);
});

test("partial restore failures keep failed snapshots and restore successful tabs", async () => {
  const { controller, store, browser, calls } = setup();
  const initial = await controller.getState();
  const activeRecord = initial.tabs.find((tab) => tab.browserTabId === 101);
  let destinationId;
  let failedSnapshot;
  let successfulSnapshot;
  await store.update((state) => {
    const withWork = createGroup(state, { name: "Work" });
    destinationId = withWork.groups.find((group) => group.name === "Work").id;
    failedSnapshot = {
      ...activeRecord,
      id: "failed-restore-snapshot",
      groupId: destinationId,
      browserTabId: null,
      url: "https://unavailable.example",
      title: "Unavailable",
      index: 0,
      status: "closed",
      sessionId: "unavailable-session",
    };
    successfulSnapshot = {
      ...activeRecord,
      id: "successful-restore-snapshot",
      groupId: destinationId,
      browserTabId: null,
      url: "https://available.example",
      title: "Available",
      index: 1,
      status: "closed",
      sessionId: "available-session",
    };
    return { ...withWork, tabs: [...withWork.tabs, failedSnapshot, successfulSnapshot] };
  });
  browser.restoreSession = async (sessionId) => {
    calls.push(["restore", sessionId]);
    if (sessionId === "unavailable-session") return null;
    return {
      tab: {
        id: 999,
        windowId: 10,
        index: 1,
        url: "https://available.example",
        title: "Available",
      },
    };
  };
  browser.createTab = async (properties) => {
    if (properties.url === "https://unavailable.example") {
      throw new Error("The browser could not create the saved page.");
    }
    throw new Error("Unexpected URL fallback: " + properties.url);
  };

  const result = await controller.switchGroup(destinationId);
  assert.equal(result.state.activeGroupId, destinationId);
  assert.deepEqual(result.failures, ["Could not restore “Unavailable”: The browser could not create the saved page."]);
  assert.equal(result.restoredCount, 1);
  assert.equal(result.state.tabs.find((tab) => tab.id === failedSnapshot.id)?.status, "closed");
  assert.equal(result.state.tabs.find((tab) => tab.id === failedSnapshot.id)?.sessionId, "unavailable-session");
  assert.equal(result.state.tabs.find((tab) => tab.id === successfulSnapshot.id)?.status, "open");
  assert.equal(result.state.tabs.find((tab) => tab.id === successfulSnapshot.id)?.browserTabId, 999);
});

test("duplicate URL sessions are matched by window and original tab index", async () => {
  const window = {
    id: 10,
    type: "normal",
    incognito: false,
    tabs: [
      { id: 101, windowId: 10, index: 0, url: "https://duplicate.example", title: "Duplicate" },
      { id: 103, windowId: 10, index: 1, url: "https://duplicate.example", title: "Duplicate" },
      { id: 102, windowId: 10, index: 2, pinned: true, url: "https://pinned.example", title: "Pinned" },
    ],
  };
  const { controller, store, browser } = setup([window]);
  await controller.getState();
  let emptyGroupId;
  await store.update((state) => {
    const next = createGroup(state, { name: "Empty" });
    emptyGroupId = next.groups.find((group) => group.name === "Empty").id;
    return next;
  });
  let sessions = [];
  const removeTabs = browser.removeTabs.bind(browser);
  browser.getRecentlyClosed = async () => structuredClone(sessions);
  browser.removeTabs = async (ids) => {
    await removeTabs(ids);
    sessions = [
      { lastModified: 20, tab: { sessionId: "session-index-1", url: "https://duplicate.example", title: "Duplicate", windowId: 10, index: 1 } },
      { lastModified: 21, tab: { sessionId: "session-index-0", url: "https://duplicate.example", title: "Duplicate", windowId: 10, index: 0 } },
    ];
  };

  const switched = await controller.switchGroup(emptyGroupId);
  const savedDuplicates = switched.state.tabs.filter((tab) => tab.url === "https://duplicate.example");
  assert.equal(savedDuplicates.length, 2);
  assert.equal(savedDuplicates.find((tab) => tab.index === 0).sessionId, "session-index-0");
  assert.equal(savedDuplicates.find((tab) => tab.index === 1).sessionId, "session-index-1");
});

test("restored tabs are ordered by their saved indexes after session restoration", async () => {
  const window = {
    id: 10,
    type: "normal",
    incognito: false,
    tabs: [
      { id: 101, windowId: 10, index: 0, url: "https://duplicate.example", title: "Duplicate" },
      { id: 103, windowId: 10, index: 1, url: "https://duplicate.example", title: "Duplicate" },
      { id: 102, windowId: 10, index: 2, pinned: true, url: "https://pinned.example", title: "Pinned" },
    ],
  };
  const { controller, store, calls, browser } = setup([window]);
  const initial = await controller.getState();
  const expectedRecordIds = initial.tabs.sort((a, b) => a.index - b.index).map((tab) => tab.id);
  let destinationGroupId;
  await store.update((state) => {
    const next = createGroup(state, { name: "Restored" });
    destinationGroupId = next.groups.find((group) => group.name === "Restored").id;
    return {
      ...next,
      tabs: next.tabs.map((tab) => ({
        ...tab,
        groupId: destinationGroupId,
        browserTabId: null,
        status: "closed",
        sessionId: `session-${tab.index}`,
      })),
    };
  });
  await browser.removeTabs([101, 103]);
  browser.restoreSession = async (sessionId) => {
    const tab = {
      id: sessionId.endsWith("0") ? 904 : 905,
      windowId: 10,
      index: 1,
      url: "https://duplicate.example",
      title: "Duplicate",
    };
    window.tabs.push(tab);
    return { tab };
  };
  calls.length = 0;

  const result = await controller.switchGroup(destinationGroupId);

  assert.equal(result.failures.length, 0);
  assert.deepEqual(calls.find(([name]) => name === "orderTabs"), [
    "orderTabs",
    result.state.tabs.filter((tab) => tab.groupId === destinationGroupId)
      .sort((a, b) => a.index - b.index).map((tab) => tab.browserTabId),
    10,
  ]);
  assert.deepEqual(result.state.tabs.filter((tab) => tab.groupId === destinationGroupId)
    .sort((a, b) => a.index - b.index).map((tab) => tab.id), expectedRecordIds);
});

test("switching to an empty group leaves one ungrouped placeholder per window", async () => {
  const { controller, store } = setup([normalWindow(10), normalWindow(20)]);
  await controller.getState();
  let emptyGroupId;
  await store.update((state) => {
    const next = createGroup(state, { name: "Empty" });
    emptyGroupId = next.groups.find((group) => group.name === "Empty").id;
    return next;
  });

  const result = await controller.switchGroup(emptyGroupId);
  assert.equal(result.state.windows.length, 2);
  assert.equal(result.state.windows.every((window) => Number.isInteger(window.placeholderTabId)), true);
  assert.equal(result.state.tabs.every((tab) => tab.groupId !== emptyGroupId), true);
});

test("rapid A-to-B-to-A requests serialize using the state at execution time", async () => {
  const window = normalWindow();
  window.tabs.push({ id: 103, windowId: 10, index: 2, url: "https://second.example", title: "Second" });
  const { controller, store } = setup([window]);
  const initial = await controller.getState();
  let groupB;
  await store.update((state) => {
    const next = createGroup(state, { name: "B" });
    groupB = next.groups.find((group) => group.name === "B").id;
    return next;
  });

  const [toB, backToA] = await Promise.all([
    controller.switchGroup(groupB),
    controller.switchGroup(initial.activeGroupId),
  ]);

  assert.equal(toB.state.activeGroupId, groupB);
  assert.equal(backToA.state.activeGroupId, initial.activeGroupId);
  assert.equal(backToA.state.tabs.filter((tab) => tab.groupId === initial.activeGroupId && tab.status === "open").length, 2);
  assert.equal(backToA.state.tabs.filter((tab) => tab.groupId === groupB && tab.status === "open").length, 0);
  assert.equal(backToA.state.operations.length, 0);
});

test("rapid tab moves honor the latest destination without leaving a stale closed snapshot", async () => {
  const window = normalWindow();
  window.tabs.push({ id: 103, windowId: 10, index: 2, url: "https://rapid-move.example", title: "Rapid move" });
  const { controller, store, calls } = setup([window]);
  const initial = await controller.getState();
  let groupB;
  await store.update((state) => {
    const next = createGroup(state, { name: "B" });
    groupB = next.groups.find((group) => group.name === "B").id;
    return next;
  });
  const recordId = initial.tabs.find((tab) => tab.browserTabId === 103).id;

  await Promise.all([
    controller.moveTab(103, groupB),
    controller.moveTab(recordId, initial.activeGroupId),
  ]);

  const state = await controller.getState();
  const moved = state.tabs.find((tab) => tab.id === recordId);
  assert.equal(moved.groupId, initial.activeGroupId);
  assert.equal(moved.status, "open");
  assert.equal(state.tabs.filter((tab) => tab.browserTabId === moved.browserTabId).length, 1);
  assert.deepEqual(calls.filter(([name]) => name === "remove").flatMap(([, ids]) => ids), [103]);
  assert.equal(state.operations.length, 0);
});

test("a failed tab close stays journaled and is replayed after controller restart", async () => {
  const windows = [normalWindow()];
  const first = setup(windows);
  const initial = await first.controller.getState();
  let destinationId;
  await first.store.update((state) => {
    const next = createGroup(state, { name: "Later" });
    destinationId = next.groups.find((group) => group.name === "Later").id;
    return next;
  });
  const remove = first.browser.removeTabs.bind(first.browser);
  let failOnce = true;
  first.browser.removeTabs = async (ids) => {
    if (failOnce) {
      failOnce = false;
      await remove(ids);
      throw new Error("injected close failure");
    }
    await remove(ids);
  };

  await assert.rejects(first.controller.switchGroup(destinationId), /Could not close the outgoing tabs/);
  assert.equal(first.store.snapshot().operations.length, 1);
  const restartedStore = new StateStore(first.storage, { createInitialState: createInitialStateFactory(first.browser) });
  const restarted = new WorkspaceController({ store: restartedStore, browser: first.browser });
  await restarted.onTabRemoved(101, { windowId: 10, isWindowClosing: false });
  const recovered = await restarted.getState();

  assert.equal(recovered.operations.length, 0);
  assert.equal(recovered.activeGroupId, destinationId);
  assert.equal(recovered.tabs.every((tab) => tab.groupId !== destinationId || tab.status === "open"), true);
  const preservedSnapshot = recovered.tabs.find((tab) => tab.url === "https://one.example");
  assert.equal(preservedSnapshot.status, "closed",
    "Recovery must preserve a tab snapshot when the close request may have succeeded before reporting failure.");
  const restored = await restarted.switchGroup(initial.activeGroupId);
  assert.equal(restored.state.tabs.find((tab) => tab.id === preservedSnapshot.id).status, "open");
});

test("moving the clicked unpinned tab to an inactive group closes only that tab", async () => {
  const window = normalWindow();
  window.tabs.push({ id: 103, windowId: 10, index: 2, url: "https://clicked.example", title: "Clicked" });
  const { controller, store, calls, browser } = setup([window]);
  const initial = await controller.getState();
  let destinationId;
  await store.update((state) => {
    const next = createGroup(state, { name: "Later" });
    destinationId = next.groups.find((group) => group.name === "Later").id;
    return next;
  });
  let recentlyClosed = [];
  const removeTabs = browser.removeTabs.bind(browser);
  browser.getRecentlyClosed = async () => structuredClone(recentlyClosed);
  browser.removeTabs = async (ids) => {
    await removeTabs(ids);
    recentlyClosed = [{ lastModified: Date.now(), tab: {
      sessionId: "session-clicked",
      url: "https://clicked.example",
      title: "Clicked",
    } }];
  };

  const moved = await controller.moveTab(103, destinationId);
  assert.equal(moved.activeGroupId, initial.activeGroupId);
  assert.equal(moved.tabs.find((tab) => tab.browserTabId === null && tab.url === "https://clicked.example").groupId, destinationId);
  assert.equal(moved.tabs.find((tab) => tab.url === "https://clicked.example").status, "closed");
  assert.equal(moved.tabs.find((tab) => tab.url === "https://clicked.example").sessionId, "session-clicked");
  assert.deepEqual(calls.filter(([name]) => name === "remove").flatMap(([, ids]) => ids), [103]);
  assert.ok(calls.some(([name, groupId, windowId]) => name === "group"
    && groupId === initial.activeGroupId && windowId === 10),
  "Moving one of two tabs away must refresh the source singleton's native grouping.");
  assert.equal(moved.windows[0].placeholderTabId, null);

  const stableRecordId = moved.tabs.find((tab) => tab.url === "https://clicked.example").id;
  const restoredResult = await controller.moveTab(stableRecordId, initial.activeGroupId);
  const restored = restoredResult.state ?? restoredResult;
  assert.equal(restored.tabs.find((tab) => tab.id === stableRecordId).groupId, initial.activeGroupId);
  assert.equal(restored.tabs.find((tab) => tab.id === stableRecordId).status, "open");
  assert.equal(calls.some(([name, sessionId]) => name === "restore" && sessionId === "session-clicked"), true);
});

test("pinned tabs and stale move destinations have no close side effect", async () => {
  const { controller, calls } = setup();
  const state = await controller.getState();
  const pinnedResult = await controller.moveTab(102, "missing-group");
  assert.deepEqual(pinnedResult, state);
  await assert.rejects(controller.moveTab(101, "missing-group"), /group no longer exists/);
  assert.equal(calls.some(([name]) => name === "remove"), false);
});

test("failed persistence prevents an inactive-group move from closing the tab", async () => {
  const window = normalWindow();
  window.tabs.push({ id: 103, windowId: 10, index: 2, url: "https://move.example", title: "Move" });
  const { controller, store, storage, calls } = setup([window]);
  await controller.getState();
  let destinationId;
  await store.update((state) => {
    const next = createGroup(state, { name: "Later" });
    destinationId = next.groups.find((group) => group.name === "Later").id;
    return next;
  });
  storage.set = async () => { throw new Error("injected write failure"); };

  await assert.rejects(controller.moveTab(103, destinationId), /injected write failure/);
  assert.equal(calls.some(([name]) => name === "remove"), false);
  assert.equal(store.snapshot().tabs.find((tab) => tab.browserTabId === 103).status, "open");
});

test("activating a tab records it as the last active tab for its group and window", async () => {
  const window = normalWindow();
  window.tabs.push({ id: 103, windowId: 10, index: 2, url: "https://active.example", title: "Active" });
  const { controller } = setup([window]);
  const initial = await controller.getState();
  const state = await controller.onTabActivated({ tabId: 103, windowId: 10 });
  const groupTabs = state.tabs.filter((tab) => tab.groupId === initial.activeGroupId && tab.windowId === state.windows[0].id);

  assert.deepEqual(groupTabs.filter((tab) => tab.lastActive).map((tab) => tab.browserTabId), [103]);
});

test("moving the last active tab leaves an ungrouped placeholder in the window", async () => {
  const { controller, store, calls } = setup();
  const state = await controller.getState();
  let destinationId;
  await store.update((current) => {
    const next = createGroup(current, { name: "Later" });
    destinationId = next.groups.find((group) => group.name === "Later").id;
    return next;
  });

  const moved = await controller.moveTab(101, destinationId);
  assert.equal(Number.isInteger(moved.windows[0].placeholderTabId), true);
  assert.equal(moved.tabs.find((tab) => tab.url === "https://one.example").status, "closed");
  assert.deepEqual(calls.find(([name]) => name === "placeholder"), ["placeholder", 10, moved.windows[0].placeholderTabId]);
  assert.equal(moved.activeGroupId, state.activeGroupId);
});

test("deleting an active tab closes and forgets it and leaves an empty-window placeholder", async () => {
  const { controller, calls, browser } = setup();
  const initial = await controller.getState();
  const record = initial.tabs.find((tab) => tab.browserTabId === 101);

  const deleted = await controller.deleteTab(101);

  assert.equal(deleted.tabs.some((tab) => tab.id === record.id), false);
  assert.equal(deleted.groups.some((group) => group.id === initial.activeGroupId), true,
    "Removing a tab must not remove its workspace.");
  assert.equal(deleted.activeGroupId, initial.activeGroupId);
  assert.deepEqual(calls.filter(([name]) => name === "remove").flatMap(([, ids]) => ids), [101]);
  assert.equal((await browser.getTab(101)), undefined,
    "Deleting a tab from the active group must close its live browser tab.");
  assert.equal(Number.isInteger(deleted.windows[0].placeholderTabId), true,
    "An open window emptied by tab deletion should receive the standard placeholder.");
  assert.equal(deleted.operations.length, 0);
});

test("deleting a saved tab removes only its snapshot and keeps its inactive group", async () => {
  const { controller, store, calls, browser } = setup();
  const initial = await controller.getState();
  const record = initial.tabs.find((tab) => tab.browserTabId === 101);
  let destinationId;
  await store.update((state) => {
    const next = createGroup(state, { name: "Later" });
    destinationId = next.groups.find((group) => group.name === "Later").id;
    return next;
  });
  const moved = await controller.moveTab(101, destinationId);
  assert.equal(moved.tabs.find((tab) => tab.id === record.id)?.status, "closed");

  const deleted = await controller.deleteTab(record.id);

  assert.equal(deleted.tabs.some((tab) => tab.id === record.id), false);
  assert.equal(deleted.groups.some((group) => group.id === destinationId), true);
  assert.deepEqual(calls.filter(([name]) => name === "remove").flatMap(([, ids]) => ids), [101],
    "Deleting a saved snapshot should not issue another browser tab close.");
  assert.equal(deleted.operations.length, 0);
  assert.ok(await browser.getTab(101) === undefined,
    "The tab was already closed when moved to the inactive group.");
});

test("failed tab deletion is recovered without re-adopting the live tab", async () => {
  const first = setup([normalWindow()]);
  const initial = await first.controller.getState();
  const record = initial.tabs.find((tab) => tab.browserTabId === 101);
  const removeTabs = first.browser.removeTabs.bind(first.browser);
  let failOnce = true;
  first.browser.removeTabs = async (ids) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("injected deletion failure");
    }
    await removeTabs(ids);
  };

  await assert.rejects(first.controller.deleteTab(101), /Could not delete the tab/);
  assert.equal(first.store.snapshot().tabs.some((tab) => tab.id === record.id), false);
  assert.equal(first.store.snapshot().operations[0].type, "delete-tab");

  const restartedStore = new StateStore(first.storage, {
    createInitialState: createInitialStateFactory(first.browser),
  });
  const restarted = new WorkspaceController({ store: restartedStore, browser: first.browser });
  const recovered = await restarted.getState();

  assert.equal(recovered.tabs.some((tab) => tab.id === record.id), false);
  assert.equal(recovered.tabs.some((tab) => tab.url === record.url), false);
  assert.equal(recovered.operations.length, 0);
  assert.equal(await first.browser.getTab(101), undefined);
  assert.equal(Number.isInteger(recovered.windows[0].placeholderTabId), true);
});

test("deleting the active group closes its tabs and activates an empty Default", async () => {
  const { controller, store, calls } = setup();
  const initial = await controller.getState();
  const defaultId = initial.groups[0].id;
  let workId;
  await store.update((state) => {
    const next = createGroup(state, { name: "Work" });
    workId = next.groups.find((group) => group.name === "Work").id;
    return {
      ...next,
      activeGroupId: workId,
      tabs: next.tabs.map((tab) => ({ ...tab, groupId: workId })),
    };
  });

  const result = await controller.deleteGroup(workId);
  assert.equal(result.state.activeGroupId, defaultId);
  assert.equal(result.deletedCount, 1);
  assert.deepEqual(result.state.groups.map((group) => group.name), ["Default"]);
  assert.deepEqual(result.state.tabs, []);
  assert.deepEqual(calls.filter(([name]) => name === "remove").flatMap(([, ids]) => ids), [101]);
  assert.equal(Number.isInteger(result.state.windows[0].placeholderTabId), true);
});

test("deleting the final Default creates a fresh empty Default", async () => {
  const { controller } = setup();
  const initial = await controller.getState();
  const result = await controller.deleteGroup(initial.groups[0].id);

  assert.equal(result.deletedCount, 1);
  assert.equal(result.state.groups.length, 1);
  assert.equal(result.state.groups[0].name, "Default");
  assert.notEqual(result.state.groups[0].id, initial.groups[0].id);
  assert.equal(result.state.activeGroupId, result.state.groups[0].id);
  assert.equal(result.state.tabs.length, 0);
});

test("pending deletion recovery never adopts a deleted tab back into a group", async () => {
  const first = setup([normalWindow()]);
  const initial = await first.controller.getState();
  first.browser.removeTabs = async () => { throw new Error("injected deletion failure"); };

  await assert.rejects(first.controller.deleteGroup(initial.groups[0].id), /Could not close the outgoing tabs/);
  assert.equal(first.store.snapshot().groups[0].name, "Default");
  assert.equal(first.store.snapshot().tabs.length, 0);
  assert.equal(first.store.snapshot().operations[0].type, "delete-group");

  const logicalWindowId = first.store.snapshot().windows[0].id;
  const windows = [{
    id: 30,
    type: "normal",
    incognito: false,
    tabs: [
      { id: 151, windowId: 30, index: 0, url: "https://one.example", title: "One" },
      { id: 152, windowId: 30, index: 1, pinned: true, url: "https://pinned.example", title: "Pinned" },
      { id: 301, windowId: 30, index: 2, url: `chrome-extension://test/placeholder.html?window=${logicalWindowId}`, title: "New Tab" },
    ],
  }];
  const { controller: restarted } = (() => {
    const { browser } = browserHarness(windows);
    const store = new StateStore(first.storage, { createInitialState: createInitialStateFactory(browser) });
    return { controller: new WorkspaceController({ store, browser }) };
  })();
  const recovered = await restarted.getState();

  assert.equal(recovered.operations.length, 0);
  assert.equal(recovered.tabs.some((tab) => tab.url === "https://one.example"), false);
  assert.equal(windows[0].tabs.some((tab) => tab.id === 151), false);
  assert.equal(recovered.windows[0].browserWindowId, 30);
  assert.equal(recovered.groups.length, 1);
  assert.equal(recovered.groups[0].name, "Default");
});

test("global switching preserves ownership at 10, 100, and 500 tabs", async (context) => {
  const measurements = [];
  for (const count of [10, 100, 500]) {
    const tabs = Array.from({ length: count }, (_, index) => ({
      id: 1000 + index,
      windowId: 10,
      index,
      url: `https://stress-${index}.example`,
      title: `Stress ${index}`,
    }));
    tabs.push({ id: 9999, windowId: 10, index: count, pinned: true, url: "https://pinned.example", title: "Pinned" });
    const { controller, store } = setup([{ id: 10, type: "normal", incognito: false, tabs }]);
    const initial = await controller.getState();
    let emptyGroupId;
    await store.update((state) => {
      const next = createGroup(state, { name: "Stress target" });
      emptyGroupId = next.groups.find((group) => group.name === "Stress target").id;
      return next;
    });

    const startedAt = performance.now();
    const switched = await controller.switchGroup(emptyGroupId);
    const elapsedMs = Number((performance.now() - startedAt).toFixed(2));
    measurements.push(`${count}:${elapsedMs}ms`);
    assert.equal(switched.state.tabs.length, count);
    assert.equal(switched.state.tabs.every((tab) => tab.status === "closed" && tab.browserTabId === null), true);
    assert.equal(switched.state.groups.find((group) => group.id === emptyGroupId).name, "Stress target");
    assert.deepEqual(switched.state.windows[0].pinnedTabIds, [9999]);
    assert.equal(Number.isInteger(switched.state.windows[0].placeholderTabId), true);
    assert.notEqual(initial.activeGroupId, emptyGroupId);
  }
  context.diagnostic(`Fake-adapter switch time by tab count: ${measurements.join(", ")}`);
});
