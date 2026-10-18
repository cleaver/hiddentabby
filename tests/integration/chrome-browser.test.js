import test from "node:test";
import assert from "node:assert/strict";
import { createFirstRunState } from "../../src/group-state.js";
import { createChromeBrowserApi } from "../../src/chrome-browser.js";

function fakeChrome() {
  const calls = [];
  const windows = [
    {
      id: 10,
      type: "normal",
      incognito: false,
      tabs: [
        { id: 1, windowId: 10, groupId: 3, url: "https://one.example", title: "One" },
        { id: 2, windowId: 10, groupId: -1, pinned: true, url: "https://pin.example", title: "Pin" },
      ],
    },
    {
      id: 11,
      type: "normal",
      incognito: true,
      tabs: [{ id: 3, windowId: 11, groupId: -1, incognito: true, url: "https://private.example" }],
    },
    {
      id: 12,
      type: "popup",
      incognito: false,
      tabs: [{ id: 4, windowId: 12, groupId: -1, url: "https://popup.example" }],
    },
  ];
  const chrome = {
    runtime: { getURL: (path) => `chrome-extension://test/${path}` },
    windows: {
      getAll: async () => structuredClone(windows),
      getLastFocused: async () => structuredClone(windows.find((window) => window.focused) ?? windows[0]),
      create: async (properties) => ({ id: 20, ...properties }),
      remove: async (id) => calls.push(["windowRemove", id]),
      update: async (id, properties) => calls.push(["windowUpdate", id, properties]),
    },
    tabs: {
      query: async (query = {}) => {
        const tabs = windows.flatMap((window) => window.tabs ?? []);
        return structuredClone(Number.isInteger(query.windowId)
          ? tabs.filter((tab) => tab.windowId === query.windowId)
          : tabs);
      },
      get: async (id) => windows.flatMap((window) => window.tabs).find((tab) => tab.id === id),
      remove: async (ids) => calls.push(["remove", ids]),
      create: async (properties) => {
        calls.push(["create", properties]);
        return {
          id: 30,
          groupId: properties.url?.includes("placeholder.html") ? 70 : -1,
          ...properties,
        };
      },
      move: async (id, properties) => { calls.push(["move", id, properties]); return { id, ...properties }; },
      update: async (id, properties) => { calls.push(["tabUpdate", id, properties]); return { id, ...properties }; },
      ungroup: async (ids) => {
        calls.push(["ungroup", ids]);
        for (const tab of windows.flatMap((window) => window.tabs)) {
          if (ids.includes(tab.id)) tab.groupId = -1;
        }
      },
      group: async ({ tabIds, groupId, createProperties }) => {
        const resolvedId = groupId ?? 70;
        calls.push(["group", tabIds, resolvedId]);
        if (createProperties) calls.push(["groupWindow", createProperties.windowId]);
        for (const tab of windows.flatMap((window) => window.tabs)) {
          if (tabIds.includes(tab.id)) tab.groupId = resolvedId;
        }
        return resolvedId;
      },
    },
    tabGroups: {
      update: async (id, properties) => calls.push(["groupUpdate", id, properties]),
    },
    sessions: {
      restore: async (id) => ({ id }),
      getRecentlyClosed: async () => [{ id: "session-1" }],
    },
    contextMenus: {
      removeAll: async () => calls.push(["menuRemoveAll"]),
      create: (properties) => calls.push(["menuCreate", properties]),
    },
  };
  return { chrome, calls, windows };
}

test("normal window query excludes incognito and popup windows", async () => {
  const { chrome } = fakeChrome();
  const browser = createChromeBrowserApi(chrome);
  const windows = await browser.getNormalWindows();

  assert.deepEqual(windows.map((window) => window.id), [10]);
  assert.deepEqual(windows[0].tabs.map((tab) => tab.id), [1, 2]);
  assert.equal(browser.isPlaceholderUrl("chrome-extension://test/placeholder.html"), true);
  assert.equal(browser.isPlaceholderUrl("chrome://newtab/"), false);
});

test("last-focused window query excludes incognito and nonnormal windows", async () => {
  const { chrome, windows } = fakeChrome();
  windows[0].focused = false;
  windows[1].focused = true;
  const browser = createChromeBrowserApi(chrome);

  const incognito = await browser.getLastFocusedWindow();
  assert.equal(incognito, null);

  windows[1].focused = false;
  windows[2].focused = true;
  const popup = await browser.getLastFocusedWindow();
  assert.equal(popup, null);

  windows[2].focused = false;
  windows[0].focused = true;
  assert.equal((await browser.getLastFocusedWindow()).id, 10);
});

test("window closure delegates to the normal Chromium windows API", async () => {
  const { chrome, calls } = fakeChrome();
  const browser = createChromeBrowserApi(chrome);

  await browser.removeWindow(12);

  assert.deepEqual(calls, [["windowRemove", 12]]);
});

test("window focus delegates to the normal Chromium windows API", async () => {
  const { chrome, calls } = fakeChrome();
  const browser = createChromeBrowserApi(chrome);

  await browser.focusWindow(10);

  assert.deepEqual(calls, [["windowUpdate", 10, { focused: true }]]);
});

test("first-run native groups replace existing groups for unpinned managed tabs", async () => {
  const { chrome, calls, windows } = fakeChrome();
  windows[0].tabs.push({ id: 5, windowId: 10, groupId: -1, index: 2, url: "https://two.example", title: "Two" });
  const browser = createChromeBrowserApi(chrome);
  const state = createFirstRunState(windows[0].tabs, { createId: (() => { let id = 0; return () => `m-${++id}`; })() });
  await browser.adoptInitialTabs(state);

  assert.deepEqual(calls[0], ["ungroup", [1]]);
  assert.deepEqual(calls.find((call) => call[0] === "group"), ["group", [1, 5], 70]);
  assert.ok(calls.some((call) => call[0] === "groupWindow" && call[1] === 10),
    "A new native group must be created in the source tab's window.");
  assert.deepEqual(calls.find((call) => call[0] === "groupUpdate"), [
    "groupUpdate",
    70,
    { title: "Default", color: "grey" },
  ]);
  assert.equal(windows[0].tabs.find((tab) => tab.id === 2).pinned, true);
});

test("a single managed tab is kept outside native tab groups", async () => {
  const { chrome, calls, windows } = fakeChrome();
  const browser = createChromeBrowserApi(chrome);
  const state = createFirstRunState(windows[0].tabs, { createId: (() => { let id = 0; return () => `s-${++id}`; })() });

  await browser.groupManagedTabs(state, state.activeGroupId, 10);

  assert.equal(windows[0].tabs.find((tab) => tab.id === 1).groupId, -1);
  assert.deepEqual(calls.find((call) => call[0] === "ungroup"), ["ungroup", [1]]);
  assert.equal(calls.some((call) => call[0] === "group"), false);
});

test("tab grouping, placeholder creation, sessions, and tab-strip menus use the intended APIs", async () => {
  const { chrome, calls, windows } = fakeChrome();
  windows[0].tabs.push({ id: 5, windowId: 10, groupId: -1, index: 2, url: "https://two.example", title: "Two" });
  const browser = createChromeBrowserApi(chrome);
  let state = createFirstRunState(windows[0].tabs, { createId: (() => { let id = 0; return () => `x-${++id}`; })() });
  await browser.groupManagedTabs(state, state.activeGroupId, 10);
  const tab = await browser.createPlaceholder(10);
  assert.equal(tab.url, "chrome-extension://test/placeholder.html");
  assert.ok(calls.some((call) => call[0] === "ungroup" && call[1].includes(30)),
    "A placeholder created beside a native group should be explicitly ungrouped.");
  const newWindow = await browser.createWindowWithPlaceholder("window-20");
  assert.deepEqual(newWindow, { windowId: 20, placeholderTabId: 30 });
  assert.ok(calls.filter((call) => call[0] === "ungroup").some((call) => call[1].includes(30)),
    "A recreated window's placeholder should be explicitly ungrouped.");
  assert.deepEqual(await browser.restoreSession("session-a"), { id: "session-a" });
  assert.deepEqual(await browser.getRecentlyClosed(), [{ id: "session-1" }]);
  await browser.createMoveMenu(state);

  assert.equal(calls.some((call) => call[0] === "groupUpdate" && call[2].title === "Default"), true);
  assert.equal(calls.some((call) => call[0] === "menuCreate"
    && call[1].contexts?.includes("tab")
    && call[1].title === "Move tab to group"), true);
  assert.equal(calls.some((call) => call[0] === "menuCreate" && call[1].parentId === "hiddentabby-move-root"), true);
});

test("recreated windows reuse a placeholder whose URL is still pending", async () => {
  const { chrome, calls } = fakeChrome();
  chrome.windows.create = async (properties) => ({
    id: 20,
    tabs: [{
      id: 31,
      windowId: 20,
      groupId: -1,
      url: "",
      pendingUrl: properties.url,
    }],
  });
  const browser = createChromeBrowserApi(chrome);

  const recreated = await browser.createWindowWithPlaceholder("logical-window-20");

  assert.deepEqual(recreated, { windowId: 20, placeholderTabId: 31 });
  assert.equal(calls.some((call) => call[0] === "create"), false,
    "The adapter must not create a second tab while the initial placeholder navigation is pending.");
});

test("switch helpers protect pinned/private tabs and match duplicate snapshots by index", async () => {
  const { chrome, calls, windows } = fakeChrome();
  const browser = createChromeBrowserApi(chrome);
  windows[0].tabs.push(
    { id: 5, windowId: 10, groupId: -1, url: "https://duplicate.example", title: "Duplicate", index: 2 },
    { id: 6, windowId: 10, groupId: -1, url: "https://duplicate.example", title: "Duplicate", index: 5 },
  );

  const match = await browser.findMatchingTab({ url: "https://duplicate.example", title: "Duplicate", index: 4 }, 10);
  assert.equal(match.id, 6);
  const excludedMatch = await browser.findMatchingTab({ url: "https://duplicate.example", title: "Duplicate", index: 4 }, 10, [6]);
  assert.equal(excludedMatch.id, 5);

  await browser.removeTabs([1, 2, 3, 999]);
  assert.deepEqual(calls.find(([name]) => name === "remove"), ["remove", [1]]);
  await browser.activateTab(1);
  await browser.moveTabToWindow(1, 12, 0);
  await browser.moveTabToWindow(1, 12, -1);
  await browser.orderTabs([6, 5, 2], 10);
  await browser.createTab({ windowId: 10, index: -1, active: false });
  assert.deepEqual(calls.filter(([name]) => name === "tabUpdate" || name === "move"), [
    ["tabUpdate", 1, { active: true }],
    ["move", 1, { windowId: 12, index: 0 }],
    ["move", 1, { windowId: 12 }],
    ["move", 6, { windowId: 10, index: 1 }],
    ["move", 5, { windowId: 10, index: 2 }],
  ]);
  assert.deepEqual(calls.find(([name]) => name === "create"), ["create", { windowId: 10, active: false }]);
});

test("placeholder pages carry a stable logical window key", async () => {
  const { chrome } = fakeChrome();
  const browser = createChromeBrowserApi(chrome);
  const placeholder = await browser.createPlaceholder(10, "logical-window-10");

  assert.equal(placeholder.url, "chrome-extension://test/placeholder.html?window=logical-window-10");
  assert.equal(browser.isPlaceholderUrl(placeholder.url), true);
  assert.equal(browser.getPlaceholderWindowKey(placeholder.url), "logical-window-10");
  assert.equal(browser.getPlaceholderWindowKey("https://example.test"), null);
  assert.equal(browser.isPlaceholderUrl("chrome://newtab/"), false);
});
