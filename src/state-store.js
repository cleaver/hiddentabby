import { createEmptyState, DEFAULT_GROUP_NAME, STATE_VERSION } from "./group-state.js";

export const STATE_STORAGE_KEY = "hiddentabby.state";

export function createChromeStorageAdapter(storageArea) {
  if (!storageArea?.get || !storageArea?.set) {
    throw new Error("A chrome.storage.local-compatible area is required.");
  }

  return {
    get: (key) => storageArea.get(key),
    set: (key, value) => storageArea.set({ [key]: value }),
  };
}

export function validateStoredState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored HiddenTabby state is not an object.");
  }
  if (value.version !== STATE_VERSION) {
    throw new Error(`Unsupported HiddenTabby state version: ${value.version}.`);
  }
  if (!Array.isArray(value.groups) || !Array.isArray(value.tabs)
    || !Array.isArray(value.windows) || !Array.isArray(value.operations)) {
    throw new Error("Stored HiddenTabby state is incomplete.");
  }

  const groupIds = new Set();
  const groupNames = new Set();
  value.groups.forEach((group, index) => {
    if (!group || typeof group.id !== "string" || !group.id
      || typeof group.name !== "string" || !group.name.trim()
      || typeof group.color !== "string" || group.order !== index) {
      throw new Error("Stored group metadata is invalid.");
    }
    const normalizedName = group.name.trim().toLocaleLowerCase();
    if (groupIds.has(group.id) || groupNames.has(normalizedName)) {
      throw new Error("Stored groups contain duplicate IDs or names.");
    }
    groupIds.add(group.id);
    groupNames.add(normalizedName);
  });

  if (typeof value.defaultGroupId !== "string" || !groupIds.has(value.defaultGroupId)) {
    throw new Error("Stored state must identify an existing main group.");
  }
  if (!groupIds.has(value.activeGroupId)) throw new Error("Stored active group does not exist.");

  const windowIds = new Set();
  value.windows.forEach((window) => {
    if (!window || typeof window.id !== "string" || !window.id
      || !Number.isInteger(window.browserWindowId)
      || (window.isOpen !== true && window.isOpen !== false)
      || !(window.placeholderTabId === null || Number.isInteger(window.placeholderTabId))
      || !Array.isArray(window.pinnedTabIds)) {
      throw new Error("Stored window metadata is invalid.");
    }
    if (windowIds.has(window.id)) throw new Error("Stored windows contain duplicate IDs.");
    windowIds.add(window.id);
  });

  const tabIds = new Set();
  const liveBrowserTabIds = new Set();
  value.tabs.forEach((tab) => {
    if (!tab || typeof tab.id !== "string" || !tab.id
      || !groupIds.has(tab.groupId)
      || !windowIds.has(tab.windowId)
      || !Number.isInteger(tab.browserWindowId)
      || typeof tab.url !== "string"
      || typeof tab.title !== "string"
      || (tab.status !== "open" && tab.status !== "closed")
      || (tab.status === "open" && !Number.isInteger(tab.browserTabId))
      || (tab.status === "closed" && tab.browserTabId !== null)) {
      throw new Error("Stored tab metadata is invalid.");
    }
    if (tabIds.has(tab.id)) throw new Error("Stored tabs contain duplicate IDs.");
    tabIds.add(tab.id);
    if (tab.status === "open") {
      if (liveBrowserTabIds.has(tab.browserTabId)) throw new Error("A browser tab has multiple group records.");
      liveBrowserTabIds.add(tab.browserTabId);
    }
  });

  const operationIds = new Set();
  for (const operation of value.operations) {
    if (!operation || typeof operation.id !== "string" || !operation.id
      || typeof operation.type !== "string" || !operation.type
      || !operation.payload || typeof operation.payload !== "object") {
      throw new Error("Stored operation journal is invalid.");
    }
    if (operationIds.has(operation.id)) throw new Error("Stored operations contain duplicate IDs.");
    operationIds.add(operation.id);
  }

  return clone(value);
}

export function migrateStoredState(value) {
  if (value?.version === STATE_VERSION) return validateStoredState(value);
  if (value?.version !== undefined && value.version !== 0 && value.version !== 1) {
    throw new Error(`Cannot migrate HiddenTabby state version ${value.version}.`);
  }
  if (!value || typeof value !== "object" || !Array.isArray(value.groups)
    || !Array.isArray(value.tabs) || !Array.isArray(value.windows)) {
    throw new Error("Stored HiddenTabby state cannot be migrated safely.");
  }

  const existingMainName = value.groups.some((group) => group?.id !== value.defaultGroupId
    && typeof group?.name === "string"
    && group.name.trim().toLocaleLowerCase() === DEFAULT_GROUP_NAME.toLocaleLowerCase());
  const legacyDefaultGroups = value.groups.filter((group) => typeof group?.name === "string"
    && group.name.trim().toLocaleLowerCase() === "default");
  const defaultGroupId = typeof value.defaultGroupId === "string"
    && value.groups.some((group) => group?.id === value.defaultGroupId)
    ? value.defaultGroupId
    : legacyDefaultGroups.length === 1
      ? legacyDefaultGroups[0].id
      : null;
  if (!defaultGroupId) throw new Error("Stored state must identify exactly one main group.");

  const groups = value.groups.map((group) => group?.id === defaultGroupId
    && typeof group?.name === "string"
    && group.name.trim().toLocaleLowerCase() === "default"
    && !existingMainName
    ? { ...group, name: DEFAULT_GROUP_NAME }
    : group);

  const migrated = {
    ...value,
    version: STATE_VERSION,
    defaultGroupId,
    groups,
    operations: Array.isArray(value.operations) ? value.operations : [],
    windows: value.windows.map((window) => ({
      ...window,
      isOpen: typeof window.isOpen === "boolean" ? window.isOpen : true,
      placeholderTabId: Number.isInteger(window.placeholderTabId) ? window.placeholderTabId : null,
      pinnedTabIds: Array.isArray(window.pinnedTabIds) ? window.pinnedTabIds : [],
    })),
  };

  return validateStoredState(migrated);
}

export class StateStore {
  #storage;
  #createInitialState;
  #state = null;
  #tail = Promise.resolve();
  #didCreateInitialState = false;

  constructor(storage, { createInitialState = () => createEmptyState() } = {}) {
    if (!storage?.get || !storage?.set) throw new Error("StateStore requires get/set storage methods.");
    this.#storage = storage;
    this.#createInitialState = createInitialState;
  }

  get didCreateInitialState() {
    return this.#didCreateInitialState;
  }

  load() {
    return this.#enqueue(async () => clone(await this.#ensureLoaded()));
  }

  snapshot() {
    if (!this.#state) throw new Error("Load state before requesting a snapshot.");
    return clone(this.#state);
  }

  update(reducer) {
    return this.#enqueue(async () => {
      const current = await this.#ensureLoaded();
      const candidate = validateStoredState(reducer(clone(current)));
      await this.#persist(candidate);
      this.#state = candidate;
      return clone(candidate);
    });
  }

  runJournaled({ id, type, payload = {}, makePayload, prepare = (state) => state, perform, finalize = (state) => state }) {
    if (typeof perform !== "function" || typeof finalize !== "function") {
      throw new Error("Journaled operations require perform and finalize callbacks.");
    }

    return this.#enqueue(async () => {
      const current = await this.#ensureLoaded();
      if (current.operations.some((operation) => operation.id === id)) {
        throw new Error(`Operation ${id} is already pending.`);
      }

      const resolvedPayload = typeof makePayload === "function" ? makePayload(clone(current)) : payload;
      const operation = { id, type, payload: clone(resolvedPayload) };
      const prepared = prepare(clone(current), clone(operation));
      const journaled = validateStoredState({
        ...prepared,
        operations: [...prepared.operations, operation],
      });
      await this.#persist(journaled);
      this.#state = journaled;

      const checkpoint = async (reducer) => {
        const candidate = validateStoredState(reducer(clone(this.#state)));
        await this.#persist(candidate);
        this.#state = candidate;
        return clone(candidate);
      };
      const result = await perform(clone(operation), clone(this.#state), checkpoint);
      const committed = finalize(clone(this.#state), clone(operation), result);
      const finished = validateStoredState({
        ...committed,
        operations: committed.operations.filter((item) => item.id !== id),
      });
      await this.#persist(finished);
      this.#state = finished;
      return { result, state: clone(finished) };
    });
  }

  resumePending(handlers) {
    return this.#enqueue(async () => {
      await this.#ensureLoaded();
      for (const operation of [...this.#state.operations]) {
        const handler = handlers[operation.type];
        if (!handler || typeof handler.perform !== "function" || typeof handler.finalize !== "function") {
          throw new Error(`No recovery handler is registered for ${operation.type}.`);
        }
        const checkpoint = async (reducer) => {
          const candidate = validateStoredState(reducer(clone(this.#state)));
          await this.#persist(candidate);
          this.#state = candidate;
          return clone(candidate);
        };
        const result = await handler.perform(clone(operation), clone(this.#state), checkpoint);
        const candidate = handler.finalize(clone(this.#state), clone(operation), result);
        const finished = validateStoredState({
          ...candidate,
          operations: candidate.operations.filter((item) => item.id !== operation.id),
        });
        await this.#persist(finished);
        this.#state = finished;
      }
      return clone(this.#state);
    });
  }

  #enqueue(callback) {
    const result = this.#tail.then(callback);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #ensureLoaded() {
    if (this.#state) return this.#state;
    const record = await this.#storage.get(STATE_STORAGE_KEY);
    const stored = record?.[STATE_STORAGE_KEY];
    if (stored === undefined) {
      const initial = validateStoredState(await this.#createInitialState());
      await this.#persist(initial);
      this.#state = initial;
      this.#didCreateInitialState = true;
      return initial;
    }

    const migrated = migrateStoredState(stored);
    if (migrated.version !== stored.version) await this.#persist(migrated);
    this.#state = migrated;
    return migrated;
  }

  #persist(state) {
    return this.#storage.set(STATE_STORAGE_KEY, clone(state));
  }
}

function clone(value) {
  return structuredClone(value);
}
