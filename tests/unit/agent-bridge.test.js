import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_BRIDGE_HOST, connectAgentBridge, createAgentBridgeHandler } from "../../src/agent-bridge.js";

function fakeChrome(windows) {
  return { windows: { getAll: async () => windows } };
}

function fakeController(deleted = [], failOn = null) {
  return {
    getState: async () => ({
      activeGroupId: "g1",
      groups: [{ id: "g1", name: "Main", color: "blue", extra: true }],
      tabs: [{ id: "r1", groupId: "g1", status: "open", browserTabId: 11, url: "https://a/", title: "A", secret: 1 }],
    }),
    deleteTab: async (id) => {
      if (id === failOn) throw new Error("nope");
      deleted.push(id);
    },
  };
}

test("list returns live non-incognito tabs, groups and HiddenTabby records", async () => {
  const handle = createAgentBridgeHandler(fakeChrome([
    { incognito: false, tabs: [{ id: 11, windowId: 1, index: 0, url: "https://a/", title: "A", pinned: true }] },
    { incognito: true, tabs: [{ id: 12, windowId: 2, url: "https://private/" }] },
  ]), fakeController());
  const reply = await handle({ id: 7, op: "list" });
  assert.equal(reply.id, 7);
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.value.tabs.map((tab) => tab.id), [11]);
  assert.equal(reply.value.tabs[0].pinned, true);
  assert.deepEqual(reply.value.groups, [{ id: "g1", name: "Main", color: "blue" }]);
  assert.equal(reply.value.activeGroupId, "g1");
  assert.deepEqual(Object.keys(reply.value.records[0]).sort(),
    ["browserTabId", "groupId", "id", "status", "title", "url"]);
});

test("close deletes each requested tab through the controller and reports per-tab results", async () => {
  const deleted = [];
  const handle = createAgentBridgeHandler(fakeChrome([]), fakeController(deleted, 13));
  const reply = await handle({ id: 1, op: "close", tabIds: [11, "r2", 13, null] });
  assert.deepEqual(deleted, [11, "r2"]);
  assert.deepEqual(reply.value.results, [
    { id: 11, ok: true }, { id: "r2", ok: true }, { id: 13, ok: false, error: "nope" },
  ]);
});

test("close without ids and unknown ops are rejected", async () => {
  const handle = createAgentBridgeHandler(fakeChrome([]), fakeController());
  assert.equal((await handle({ id: 1, op: "close", tabIds: [] })).ok, false);
  assert.deepEqual(await handle({ id: 2, op: "eval" }), { id: 2, ok: false, error: "Unknown op: eval" });
});

function fakeBridgeChrome(granted) {
  const ports = [];
  const listeners = { added: [], removed: [] };
  const chromeApi = {
    state: { granted },
    windows: { getAll: async () => [] },
    permissions: {
      contains: async (request) => {
        assert.deepEqual(request, { permissions: ["nativeMessaging"] });
        return chromeApi.state.granted;
      },
      onAdded: { addListener: (fn) => listeners.added.push(fn) },
      onRemoved: { addListener: (fn) => listeners.removed.push(fn) },
    },
    runtime: {
      connectNative(name) {
        assert.equal(name, AGENT_BRIDGE_HOST);
        const port = {
          sent: [], handlers: {}, disconnected: false,
          postMessage(message) { this.sent.push(message); },
          disconnect() { this.disconnected = true; },
          onMessage: { addListener(fn) { port.handlers.message = fn; } },
          onDisconnect: { addListener(fn) { port.handlers.disconnect = fn; } },
        };
        ports.push(port);
        return port;
      },
    },
  };
  return { chromeApi, ports, listeners };
}

test("connectAgentBridge stays disconnected until the optional permission is granted", async () => {
  const { chromeApi, ports, listeners } = fakeBridgeChrome(false);
  await connectAgentBridge(chromeApi, fakeController(), { setTimer: () => assert.fail("no reconnect expected") });
  assert.equal(ports.length, 0);

  chromeApi.state.granted = true;
  listeners.added.forEach((fn) => fn());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ports.length, 1);
});

test("connectAgentBridge answers port messages, reconnects after disconnect, and stops on revoke", async () => {
  const { chromeApi, ports, listeners } = fakeBridgeChrome(true);
  const timers = [];
  await connectAgentBridge(chromeApi, fakeController(), {
    setTimer: (fn, ms) => { timers.push([fn, ms]); return timers.length; },
    clearTimer: () => {},
  });
  await ports[0].handlers.message({ id: 3, op: "list" });
  assert.equal(ports[0].sent[0].id, 3);

  ports[0].handlers.disconnect();
  assert.equal(timers[0][1], 5_000);
  timers[0][0]();
  assert.equal(ports.length, 2);

  chromeApi.state.granted = false;
  listeners.removed.forEach((fn) => fn());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ports[1].disconnected, true);
  ports[1].handlers.disconnect();
  assert.equal(timers.length, 1, "a revoked bridge must not reconnect");
});

test("connectAgentBridge is a no-op without the permissions API", () => {
  assert.equal(connectAgentBridge({}, fakeController()), undefined);
});
