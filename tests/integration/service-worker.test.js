import test from "node:test";
import assert from "node:assert/strict";
import { registerServiceWorker } from "../../src/service-worker.js";
import { PIN_ONBOARDING_STORAGE_KEY } from "../../src/pin-onboarding-state.js";

function event() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    fire(...args) { return listeners.map((listener) => listener(...args)); },
  };
}

function setup() {
  const storageValues = {};
  const managerPageCalls = [];
  const chrome = {
    runtime: {
      onInstalled: event(), onStartup: event(), onMessage: event(),
      getURL(path) { return `chrome-extension://test/${path}`; },
    },
    action: { onUserSettingsChanged: event() },
    storage: {
      local: {
        async get(key) { return { [key]: storageValues[key] }; },
        async set(values) { Object.assign(storageValues, values); },
      },
    },
    windows: { onRemoved: event() },
    tabs: {
      onCreated: event(), onActivated: event(), onUpdated: event(), onRemoved: event(), onAttached: event(), onMoved: event(),
      async create(properties) { managerPageCalls.push(properties.url); return { id: 1, ...properties }; },
    },
    contextMenus: { onClicked: event() },
  };
  const calls = [];
  const controller = Object.fromEntries([
    "initialize", "onTabCreated", "onTabActivated", "onTabUpdated", "onTabRemoved", "onWindowRemoved", "onTabAttached", "onTabMoved",
    "moveTab", "deleteTab", "getState", "createGroup", "renameGroup", "recolorGroup", "reorderGroups", "deleteGroup", "switchGroup",
  ].map((name) => [name, (...args) => { calls.push([name, ...args]); return Promise.resolve({ name, args }); }]));
  registerServiceWorker(chrome, controller);
  return { chrome, calls, storageValues, controller, managerPageCalls };
}

test("service worker opens the Workspace Manager after a fresh install only", async () => {
  const { chrome, calls, controller, managerPageCalls } = setup();
  let finishInitialization;
  controller.initialize = () => {
    calls.push(["initialize"]);
    return new Promise((resolve) => { finishInitialization = resolve; });
  };

  chrome.runtime.onInstalled.fire({ reason: "install" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(managerPageCalls, [], "The manager should wait for first-run initialization.");

  finishInitialization();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(managerPageCalls, ["chrome-extension://test/manager.html"]);

  chrome.runtime.onInstalled.fire({ reason: "update" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(managerPageCalls, ["chrome-extension://test/manager.html"], "Updates should not reopen the manager.");
  assert.deepEqual(calls, [["initialize"], ["initialize"]]);
});

test("service worker clears the dismissed pin tip when toolbar visibility changes", async () => {
  const { chrome, storageValues } = setup();
  storageValues[PIN_ONBOARDING_STORAGE_KEY] = { dismissed: true, isOnToolbar: false };

  const [pinnedUpdate] = chrome.action.onUserSettingsChanged.fire({ isOnToolbar: true });
  await pinnedUpdate;
  assert.deepEqual(storageValues[PIN_ONBOARDING_STORAGE_KEY], { dismissed: false, isOnToolbar: true });

  storageValues[PIN_ONBOARDING_STORAGE_KEY] = { dismissed: true, isOnToolbar: true };
  const [unpinnedUpdate] = chrome.action.onUserSettingsChanged.fire({ isOnToolbar: false });
  await unpinnedUpdate;
  assert.deepEqual(storageValues[PIN_ONBOARDING_STORAGE_KEY], { dismissed: false, isOnToolbar: false });
});

test("service worker ignores toolbar settings without a visibility value", async () => {
  const { chrome, storageValues } = setup();
  storageValues[PIN_ONBOARDING_STORAGE_KEY] = { dismissed: true, isOnToolbar: false };

  const [ignoredUpdate] = chrome.action.onUserSettingsChanged.fire({});
  assert.equal(ignoredUpdate, undefined);
  assert.deepEqual(storageValues[PIN_ONBOARDING_STORAGE_KEY], { dismissed: true, isOnToolbar: false });
});

test("service worker forwards lifecycle events and the clicked tab ID", async () => {
  const { chrome, calls } = setup();
  const tab = { id: 42, url: "https://example.test" };
  chrome.tabs.onCreated.fire(tab);
  chrome.tabs.onActivated.fire({ tabId: 42, windowId: 8 });
  chrome.tabs.onUpdated.fire(42, { title: "updated" }, tab);
  chrome.tabs.onRemoved.fire(42, { windowId: 8, isWindowClosing: false });
  chrome.windows.onRemoved.fire(8);
  chrome.tabs.onAttached.fire(42, { newWindowId: 9, newPosition: 2 });
  chrome.tabs.onMoved.fire(42, { windowId: 9, fromIndex: 0, toIndex: 2 });
  chrome.contextMenus.onClicked.fire({ menuItemId: "hiddentabby-move:group-2" }, tab);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls.map(([name]) => name), ["onTabCreated", "onTabActivated", "onTabUpdated", "onTabRemoved", "onWindowRemoved", "onTabAttached", "onTabMoved", "moveTab"]);
  assert.deepEqual(calls.at(-1), ["moveTab", 42, "group-2"]);
});

test("service worker answers extension messages and ignores unknown commands", async () => {
  const { chrome, calls } = setup();
  const responses = [];
  const [accepted] = chrome.runtime.onMessage.fire({ type: "group:create", details: { name: "Work" } }, {}, (value) => responses.push(value));
  const [ignored] = chrome.runtime.onMessage.fire({ type: "unknown" }, {}, () => assert.fail("unexpected response"));
  assert.equal(accepted, true);
  assert.equal(ignored, false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [["createGroup", { name: "Work" }]]);
  assert.deepEqual(responses, [{ ok: true, value: { name: "createGroup", args: [{ name: "Work" }] } }]);
});

test("service worker dispatches a tab deletion command by tab ID", async () => {
  const { chrome, calls } = setup();
  const responses = [];
  const [accepted] = chrome.runtime.onMessage.fire(
    { type: "tab:delete", tabId: "saved-record-1" },
    {},
    (value) => responses.push(value),
  );

  assert.equal(accepted, true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [["deleteTab", "saved-record-1"]]);
  assert.deepEqual(responses, [{ ok: true, value: { name: "deleteTab", args: ["saved-record-1"] } }]);
});

test("service worker identifies a full-page manager tab for its final-tab guard", async () => {
  const { chrome, calls } = setup();
  const managerUrl = "chrome-extension://extension-id/manager.html";
  const [accepted] = chrome.runtime.onMessage.fire(
    { type: "tab:delete", tabId: 42 },
    { url: managerUrl, tab: { id: 42, url: managerUrl } },
    () => {},
  );

  assert.equal(accepted, true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [["deleteTab", 42, { managerTabId: 42 }]]);
});

test("service worker does not treat a non-manager sender as the manager tab", async () => {
  const { chrome, calls } = setup();
  const [accepted] = chrome.runtime.onMessage.fire(
    { type: "tab:delete", tabId: 42 },
    { url: "chrome-extension://extension-id/manager.html", tab: { id: 42, url: "https://host.example/" } },
    () => {},
  );

  assert.equal(accepted, true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [["deleteTab", 42]]);
});
