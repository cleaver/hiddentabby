import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyState, createGroup } from "../../src/group-state.js";
import {
  migrateStoredState,
  createChromeStorageAdapter,
  StateStore,
  STATE_STORAGE_KEY,
  validateStoredState,
} from "../../src/state-store.js";

class MemoryStorage {
  values = new Map();
  failNextSet = false;
  failOnWrite = null;
  writeCount = 0;

  async get(key) {
    return this.values.has(key) ? { [key]: structuredClone(this.values.get(key)) } : {};
  }

  async set(key, value) {
    this.writeCount += 1;
    if (this.failOnWrite === this.writeCount) {
      this.failOnWrite = null;
      throw new Error("injected storage write failure");
    }
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error("injected storage write failure");
    }
    this.values.set(key, structuredClone(value));
  }
}

function idFactory() {
  let next = 0;
  return () => `store-${++next}`;
}

function defaultState() {
  return createEmptyState({ createId: idFactory() });
}

test("Chrome storage adapter forwards keyed reads and object-shaped writes", async () => {
  const calls = [];
  const area = {
    get: async (key) => { calls.push(["get", key]); return { [key]: "stored" }; },
    set: async (value) => { calls.push(["set", value]); },
  };
  const adapter = createChromeStorageAdapter(area);

  assert.deepEqual(await adapter.get("key"), { key: "stored" });
  await adapter.set("key", { value: 1 });
  assert.deepEqual(calls, [["get", "key"], ["set", { key: { value: 1 } }]]);
  assert.throws(() => createChromeStorageAdapter(null), /compatible area/);
});

test("missing state is initialized durably with Main", async () => {
  const storage = new MemoryStorage();
  const store = new StateStore(storage, { createInitialState: defaultState });
  const state = await store.load();

  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0].name, "Main");
  assert.equal(state.defaultGroupId, state.groups[0].id);
  assert.equal(storage.values.get(STATE_STORAGE_KEY).activeGroupId, state.activeGroupId);
});

test("legacy version zero state migrates and persists the current window fields", async () => {
  const storage = new MemoryStorage();
  const legacy = defaultState();
  legacy.version = 0;
  legacy.groups[0].name = "Default";
  delete legacy.defaultGroupId;
  legacy.operations = undefined;
  legacy.windows = [{ id: "legacy-window", browserWindowId: 9, placeholderTabId: undefined }];
  storage.values.set(STATE_STORAGE_KEY, legacy);
  const store = new StateStore(storage);

  const migrated = await store.load();
  assert.equal(migrated.version, 2);
  assert.equal(migrated.groups[0].name, "Main");
  assert.equal(migrated.defaultGroupId, migrated.groups[0].id);
  assert.deepEqual(migrated.operations, []);
  assert.equal(migrated.windows[0].isOpen, true);
  assert.deepEqual(migrated.windows[0].pinnedTabIds, []);
  assert.equal(storage.values.get(STATE_STORAGE_KEY).version, 2);
});

test("version one Default state migrates to a renameable Main identity", async () => {
  const storage = new MemoryStorage();
  const legacy = defaultState();
  legacy.version = 1;
  legacy.groups[0].name = "Default";
  delete legacy.defaultGroupId;
  legacy.groups.push({ id: "old-work", name: "Work", color: "blue", order: 1 });
  storage.values.set(STATE_STORAGE_KEY, legacy);

  const migrated = await new StateStore(storage).load();

  assert.equal(migrated.version, 2);
  assert.equal(migrated.defaultGroupId, legacy.groups[0].id);
  assert.equal(migrated.groups[0].name, "Main");
  assert.equal(migrated.groups[1].name, "Work");
  assert.equal(storage.values.get(STATE_STORAGE_KEY).version, 2);
});

test("version one migration preserves an existing group named Main", async () => {
  const storage = new MemoryStorage();
  const legacy = defaultState();
  legacy.version = 1;
  legacy.groups[0].name = "Default";
  delete legacy.defaultGroupId;
  legacy.groups.push({ id: "old-main", name: "Main", color: "blue", order: 1 });
  storage.values.set(STATE_STORAGE_KEY, legacy);

  const migrated = await new StateStore(storage).load();

  assert.equal(migrated.defaultGroupId, legacy.groups[0].id);
  assert.equal(migrated.groups[0].name, "Default");
  assert.equal(migrated.groups[1].name, "Main");
});

test("unsupported or malformed stored data is rejected without overwriting it", async () => {
  const storage = new MemoryStorage();
  const future = { version: 99, keep: "untouched" };
  storage.values.set(STATE_STORAGE_KEY, future);
  const store = new StateStore(storage);

  await assert.rejects(store.load(), /Cannot migrate/);
  assert.deepEqual(storage.values.get(STATE_STORAGE_KEY), future);
  assert.throws(() => validateStoredState({ ...defaultState(), activeGroupId: "missing" }), /active group/);
  assert.throws(() => validateStoredState({ ...defaultState(), defaultGroupId: "missing" }), /main group/);
  assert.throws(() => migrateStoredState({ version: 0, groups: [], tabs: [], windows: [] }), /main group/i);
});

test("a failed normal write leaves both stored and in-memory state unchanged", async () => {
  const storage = new MemoryStorage();
  const store = new StateStore(storage, { createInitialState: defaultState });
  const initial = await store.load();
  storage.failNextSet = true;

  await assert.rejects(store.update((state) => createGroup(state, { name: "Unpersisted" })), /injected/);
  assert.deepEqual(store.snapshot(), initial);
  assert.deepEqual(storage.values.get(STATE_STORAGE_KEY), initial);
});

test("a rejected reducer does not write and the queue remains usable", async () => {
  const storage = new MemoryStorage();
  const store = new StateStore(storage, { createInitialState: defaultState });
  await store.load();
  const writesBefore = storage.writeCount;

  await assert.rejects(store.update(() => ({ invalid: true })), /Unsupported HiddenTabby state version/);
  assert.equal(storage.writeCount, writesBefore);
  await store.update((state) => createGroup(state, { name: "After error" }));
  assert.equal(store.snapshot().groups.at(-1).name, "After error");
});

test("a failed durable write prevents the external side effect", async () => {
  const storage = new MemoryStorage();
  const store = new StateStore(storage, { createInitialState: defaultState });
  await store.load();
  storage.failNextSet = true;
  let performed = false;

  await assert.rejects(store.runJournaled({
    id: "switch-1",
    type: "switch",
    payload: { destination: "group-2" },
    perform: async () => { performed = true; },
  }), /injected/);
  assert.equal(performed, false);
  assert.deepEqual(store.snapshot().operations, []);
});

test("an interrupted operation remains journaled and recovery replays it once", async () => {
  const storage = new MemoryStorage();
  const store = new StateStore(storage, { createInitialState: defaultState });
  await store.load();
  let firstAttempt = true;

  await assert.rejects(store.runJournaled({
    id: "create-work",
    type: "createGroup",
    payload: { id: "group-work", name: "Work" },
    perform: async () => {
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error("simulated interruption");
      }
      return "done";
    },
    finalize: (state, operation) => ({
      ...state,
      groups: [...state.groups, {
        id: operation.payload.id,
        name: operation.payload.name,
        color: "grey",
        order: state.groups.length,
      }],
    }),
  }), /simulated interruption/);

  assert.equal(store.snapshot().operations[0].id, "create-work");
  const recovered = await store.resumePending({
    createGroup: {
      perform: async () => "done",
      finalize: (state, operation) => ({
        ...state,
        groups: state.groups.some((group) => group.id === operation.payload.id)
          ? state.groups
          : [...state.groups, {
            id: operation.payload.id,
            name: operation.payload.name,
            color: "grey",
            order: state.groups.length,
          }],
      }),
    },
  });

  assert.equal(recovered.groups.filter((group) => group.id === "group-work").length, 1);
  assert.deepEqual(recovered.operations, []);
});

test("journal checkpoints persist browser results while keeping the operation pending", async () => {
  const storage = new MemoryStorage();
  const store = new StateStore(storage, { createInitialState: defaultState });
  await store.load();

  await assert.rejects(store.runJournaled({
    id: "switch-checkpoint",
    type: "switch",
    payload: {},
    perform: async (_operation, _state, checkpoint) => {
      await checkpoint((state) => createGroup(state, { name: "Checkpoint" }));
      throw new Error("simulated worker termination after browser effect");
    },
  }), /simulated worker termination/);

  assert.deepEqual(store.snapshot().operations.map(({ id }) => id), ["switch-checkpoint"]);
  assert.equal(store.snapshot().groups.some((group) => group.name === "Checkpoint"), true);
  assert.deepEqual(storage.values.get(STATE_STORAGE_KEY), store.snapshot());
});

test("a commit write failure keeps the journal, and idempotent recovery completes it", async () => {
  const storage = new MemoryStorage();
  const store = new StateStore(storage, { createInitialState: defaultState });
  await store.load();
  const appliedIds = new Set();
  const finalize = (state, operation) => ({
    ...state,
    groups: state.groups.some((group) => group.id === operation.payload.id)
      ? state.groups
      : [...state.groups, {
        id: operation.payload.id,
        name: operation.payload.name,
        color: "grey",
        order: state.groups.length,
      }],
  });
  storage.failOnWrite = storage.writeCount + 2;

  await assert.rejects(store.runJournaled({
    id: "commit-retry",
    type: "addGroup",
    payload: { id: "group-retry", name: "Retry" },
    perform: async (operation) => {
      appliedIds.add(operation.id);
      return operation.id;
    },
    finalize,
  }), /injected/);

  assert.deepEqual([...appliedIds], ["commit-retry"]);
  assert.equal(store.snapshot().operations.length, 1);
  const recovered = await store.resumePending({
    addGroup: {
      perform: async (operation) => {
        appliedIds.add(operation.id);
        return operation.id;
      },
      finalize,
    },
  });

  assert.equal(appliedIds.size, 1);
  assert.equal(recovered.groups.filter((group) => group.id === "group-retry").length, 1);
  assert.equal(recovered.operations.length, 0);
});

test("pending operations cannot run twice concurrently or recover without a handler", async () => {
  const storage = new MemoryStorage();
  const store = new StateStore(storage, { createInitialState: defaultState });
  await store.load();
  await assert.rejects(store.runJournaled({
    id: "pending-1",
    type: "unknown",
    payload: { tabId: 4 },
    perform: async () => { throw new Error("interrupt"); },
  }), /interrupt/);

  await assert.rejects(store.runJournaled({
    id: "pending-1",
    type: "unknown",
    perform: async () => undefined,
  }), /already pending/);
  await assert.rejects(store.resumePending({}), /No recovery handler/);
  assert.equal(store.snapshot().operations[0].id, "pending-1");
});

test("serialized concurrent mutations do not lose updates", async () => {
  const storage = new MemoryStorage();
  const store = new StateStore(storage, { createInitialState: defaultState });
  await store.load();

  await Promise.all([
    store.update((state) => createGroup(state, { name: "First" })),
    store.update((state) => createGroup(state, { name: "Second" })),
  ]);

  assert.deepEqual(store.snapshot().groups.map((group) => group.name), ["Main", "First", "Second"]);
});
