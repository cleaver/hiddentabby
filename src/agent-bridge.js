// Optional local agent bridge. When the user grants the optional
// "nativeMessaging" permission from the manager page, HiddenTabby connects to
// a locally installed native-messaging host so a local tool can list tabs and
// close tabs by ID. It exposes only "list" and "close"; closing goes through
// the WorkspaceController so HiddenTabby's state stays consistent and pinned
// tabs are never closed. Without the permission nothing connects.

export const AGENT_BRIDGE_HOST = "hiddentabby_agent_bridge";
export const AGENT_BRIDGE_PERMISSION = { permissions: ["nativeMessaging"] };

function pickTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    url: tab.url ?? tab.pendingUrl ?? "",
    title: tab.title ?? "",
    pinned: Boolean(tab.pinned),
    active: Boolean(tab.active),
    audible: Boolean(tab.audible),
    discarded: Boolean(tab.discarded),
    groupId: tab.groupId,
    lastAccessed: tab.lastAccessed ?? null,
  };
}

function pickRecord(record) {
  return {
    id: record.id,
    groupId: record.groupId,
    status: record.status,
    browserTabId: record.browserTabId ?? null,
    url: record.url ?? "",
    title: record.title ?? "",
  };
}

export function createAgentBridgeHandler(chromeApi, controller) {
  const operations = {
    async list() {
      const windows = await chromeApi.windows.getAll({ populate: true, windowTypes: ["normal"] });
      const tabs = windows
        .filter((window) => !window.incognito)
        .flatMap((window) => (window.tabs ?? []).filter((tab) => !tab.incognito).map(pickTab));
      const state = await controller.getState();
      return {
        tabs,
        groups: (state.groups ?? []).map(({ id, name, color }) => ({ id, name, color })),
        activeGroupId: state.activeGroupId ?? null,
        records: (state.tabs ?? []).map(pickRecord),
      };
    },

    async close(message) {
      const ids = Array.isArray(message.tabIds) ? message.tabIds : [];
      const valid = ids.filter((id) => Number.isInteger(id) || (typeof id === "string" && id));
      if (!valid.length) throw new Error("close requires a non-empty tabIds array.");
      const results = [];
      for (const id of valid) {
        try {
          await controller.deleteTab(id);
          results.push({ id, ok: true });
        } catch (error) {
          results.push({ id, ok: false, error: error.message });
        }
      }
      return { results };
    },
  };

  return async (message) => {
    const operation = operations[message?.op];
    if (!operation) return { id: message?.id, ok: false, error: `Unknown op: ${message?.op}` };
    try {
      return { id: message.id, ok: true, value: await operation(message) };
    } catch (error) {
      return { id: message.id, ok: false, error: error.message };
    }
  };
}

export function connectAgentBridge(chromeApi, controller, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const permissions = chromeApi?.permissions;
  if (!permissions?.contains) return;
  const handle = createAgentBridgeHandler(chromeApi, controller);
  let port = null;
  let timer = null;
  let delay = 5_000;
  let enabled = false;

  const scheduleReconnect = () => {
    if (!enabled) return;
    timer = setTimer(connect, delay);
    delay = Math.min(delay * 2, 300_000);
  };

  function connect() {
    timer = null;
    if (!enabled || port || !chromeApi.runtime?.connectNative) return;
    try {
      port = chromeApi.runtime.connectNative(AGENT_BRIDGE_HOST);
    } catch (error) {
      console.warn("HiddenTabby agent bridge unavailable:", error);
      scheduleReconnect();
      return;
    }
    const current = port;
    current.onMessage.addListener(async (message) => {
      delay = 5_000;
      const response = await handle(message);
      try {
        current.postMessage(response);
      } catch (error) {
        console.warn("HiddenTabby agent bridge reply failed:", error);
      }
    });
    current.onDisconnect.addListener(() => {
      void chromeApi.runtime.lastError;
      if (port === current) port = null;
      scheduleReconnect();
    });
  }

  const disconnect = () => {
    enabled = false;
    if (timer !== null) clearTimer(timer);
    timer = null;
    const current = port;
    port = null;
    current?.disconnect?.();
  };

  const refresh = async () => {
    const granted = await permissions.contains(AGENT_BRIDGE_PERMISSION);
    if (granted && !enabled) {
      enabled = true;
      delay = 5_000;
      connect();
    } else if (!granted && enabled) {
      disconnect();
    }
  };

  permissions.onAdded?.addListener(() => void refresh());
  permissions.onRemoved?.addListener(() => void refresh());
  return refresh();
}
