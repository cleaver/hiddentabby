import test from "node:test";
import assert from "node:assert/strict";
import { registerServiceWorker } from "../../src/service-worker.js";

function event() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    fire(...args) { return listeners.map((listener) => listener(...args)); },
  };
}

function setup() {
  const chrome = {
    runtime: { onInstalled: event(), onStartup: event(), onMessage: event() },
    windows: { onRemoved: event() },
    tabs: {
      onCreated: event(), onActivated: event(), onUpdated: event(), onRemoved: event(), onAttached: event(), onMoved: event(),
    },
    contextMenus: { onClicked: event() },
  };
  const calls = [];
  const controller = Object.fromEntries([
    "initialize", "onTabCreated", "onTabActivated", "onTabUpdated", "onTabRemoved", "onWindowRemoved", "onTabAttached", "onTabMoved",
    "moveTab", "deleteTab", "getState", "createGroup", "renameGroup", "recolorGroup", "reorderGroups", "deleteGroup", "switchGroup",
  ].map((name) => [name, (...args) => { calls.push([name, ...args]); return Promise.resolve({ name, args }); }]));
  registerServiceWorker(chrome, controller);
  return { chrome, calls };
}

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

test("service worker does not treat a side-panel host tab as the manager tab", async () => {
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
