export const STATE_VERSION = 1;
export const DEFAULT_GROUP_NAME = "Default";
export const DEFAULT_GROUP_COLOR = "grey";

const BROWSER_NEW_TAB_URLS = new Set([
  "chrome://newtab",
  "chrome://new-tab-page",
  "brave://newtab",
]);

export function isMeaningfulTab(tab, isPlaceholderUrl = () => false) {
  if (!tab || tab.pinned) return false;
  const url = typeof tab.pendingUrl === "string" && tab.pendingUrl
    ? tab.pendingUrl
    : tab.url;
  if (typeof url !== "string" || !url) return false;
  if (isPlaceholderUrl(url)) return false;
  return !isBrowserNewTabPage(tab);
}

export function isRememberedTab(state, tab, isPlaceholderUrl = () => false) {
  if (isMeaningfulTab(tab, isPlaceholderUrl)) return true;
  return isBrowserNewTabPage(tab) && state.tabs.some((candidate) => candidate.id !== tab.id
    && candidate.groupId === tab.groupId
    && candidate.windowId === tab.windowId
    && isMeaningfulTab(candidate, isPlaceholderUrl));
}

function isBrowserNewTabPage(tab) {
  if (!tab) return false;
  const url = typeof tab.pendingUrl === "string" && tab.pendingUrl
    ? tab.pendingUrl
    : tab.url;
  if (typeof url !== "string" || !url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const normalized = `${parsed.protocol}//${parsed.hostname}`.toLocaleLowerCase();
  return BROWSER_NEW_TAB_URLS.has(normalized)
    || normalized === "chrome-search://local-ntp" && parsed.pathname === "/local-ntp.html";
}

const TAB_GROUP_COLORS = new Set([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]);

export function createEmptyState({ createId = () => crypto.randomUUID() } = {}) {
  const defaultGroup = {
    id: createId(),
    name: DEFAULT_GROUP_NAME,
    color: DEFAULT_GROUP_COLOR,
    order: 0,
  };

  return {
    version: STATE_VERSION,
    activeGroupId: defaultGroup.id,
    groups: [defaultGroup],
    tabs: [],
    windows: [],
    operations: [],
  };
}

export function createFirstRunState(browserTabs, options = {}) {
  const state = createEmptyState(options);
  const createId = options.createId ?? (() => crypto.randomUUID());
  const windowIds = new Set();
  const managedTabs = [];

  for (const tab of browserTabs) {
    if (tab.incognito || !Number.isInteger(tab.windowId)) continue;

    windowIds.add(tab.windowId);
    if (tab.pinned) continue;
    managedTabs.push(tab);
  }

  state.windows = [...windowIds].map((browserWindowId) => ({
    id: createId(),
    browserWindowId,
    isOpen: true,
    placeholderTabId: null,
    pinnedTabIds: browserTabs
      .filter((tab) => !tab.incognito && tab.pinned && tab.windowId === browserWindowId)
      .map((tab) => tab.id),
  }));
  state.tabs = managedTabs.map((tab) => {
    const window = state.windows.find((candidate) => candidate.browserWindowId === tab.windowId);
    return normalizeTab({ ...tab, windowKey: window.id }, state.activeGroupId, createId);
  });

  return state;
}

export function createGroup(state, { name, color = DEFAULT_GROUP_COLOR }, options = {}) {
  const normalizedName = validateName(name);
  if (state.groups.some((group) => group.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) {
    throw new Error("A group with that name already exists.");
  }

  if (!TAB_GROUP_COLORS.has(color)) throw new Error("Choose a supported group color.");

  const createId = options.createId ?? (() => crypto.randomUUID());
  const group = {
    id: createId(),
    name: normalizedName,
    color,
    order: state.groups.length,
  };

  return {
    ...state,
    groups: [...state.groups, group],
  };
}

export function renameGroup(state, groupId, name) {
  const group = requireGroup(state, groupId);
  const normalizedName = validateName(name);

  if (group.name.toLocaleLowerCase() === DEFAULT_GROUP_NAME.toLocaleLowerCase()
    && !state.groups.some((candidate) => candidate.id !== groupId
      && candidate.name.toLocaleLowerCase() === DEFAULT_GROUP_NAME.toLocaleLowerCase())) {
    throw new Error("At least one group must remain named Default.");
  }

  if (state.groups.some((candidate) => candidate.id !== groupId
    && candidate.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) {
    throw new Error("A group with that name already exists.");
  }

  return {
    ...state,
    groups: state.groups.map((candidate) => candidate.id === group.id
      ? { ...candidate, name: normalizedName }
      : candidate),
  };
}

export function recolorGroup(state, groupId, color) {
  requireGroup(state, groupId);
  if (!TAB_GROUP_COLORS.has(color)) throw new Error("Choose a supported group color.");

  return {
    ...state,
    groups: state.groups.map((group) => group.id === groupId ? { ...group, color } : group),
  };
}

export function reorderGroups(state, orderedIds) {
  if (orderedIds.length !== state.groups.length
    || new Set(orderedIds).size !== state.groups.length
    || orderedIds.some((id) => !state.groups.some((group) => group.id === id))) {
    throw new Error("The order must include each group exactly once.");
  }

  const byId = new Map(state.groups.map((group) => [group.id, group]));
  return {
    ...state,
    groups: orderedIds.map((id, order) => ({ ...byId.get(id), order })),
  };
}

export function assignTab(state, browserTab, groupId = state.activeGroupId, options = {}) {
  if (browserTab.incognito) return state;
  const createId = options.createId ?? (() => crypto.randomUUID());
  const windows = upsertWindow(state.windows, browserTab.windowId, createId, browserTab.windowKey);

  if (browserTab.pinned) {
    return {
      ...state,
      tabs: state.tabs.filter((tab) => tab.browserTabId !== browserTab.id),
      windows: windows.map((window) => window.browserWindowId === browserTab.windowId
        ? { ...window, pinnedTabIds: [...new Set([...(window.pinnedTabIds ?? []), browserTab.id])] }
        : window),
    };
  }

  const group = requireGroup(state, groupId);
  const existing = state.tabs.find((tab) => tab.browserTabId === browserTab.id);
  const window = windows.find((candidate) => candidate.browserWindowId === browserTab.windowId);
  const tab = normalizeTab({ ...browserTab, windowKey: window.id }, group.id, createId, existing?.id);
  const tabs = existing
    ? state.tabs.map((candidate) => candidate.id === existing.id ? tab : candidate)
    : [...state.tabs, tab];
  const updatedWindows = windows.map((window) => window.browserWindowId === browserTab.windowId
    ? { ...window, pinnedTabIds: (window.pinnedTabIds ?? []).filter((id) => id !== browserTab.id) }
    : window);

  return { ...state, tabs, windows: updatedWindows };
}

export function moveTab(state, tabId, destinationGroupId) {
  requireGroup(state, destinationGroupId);
  const tab = requireTab(state, tabId);
  const staysOpen = tab.status === "open" && destinationGroupId === state.activeGroupId;
  const moved = {
    ...tab,
    groupId: destinationGroupId,
    browserTabId: staysOpen ? tab.browserTabId : null,
    status: staysOpen ? "open" : "closed",
  };

  return {
    state: {
      ...state,
      tabs: state.tabs.map((candidate) => candidate.id === tabId
        ? moved
        : candidate),
    },
    closeBrowserTab: destinationGroupId !== state.activeGroupId && tab.status === "open"
      ? tab.browserTabId
      : null,
    shouldActivateGroup: false,
  };
}

export function planGroupSwitch(state, destinationGroupId, { isPlaceholderUrl = () => false } = {}) {
  requireGroup(state, destinationGroupId);
  if (destinationGroupId === state.activeGroupId) {
    const discardTabIds = state.tabs
      .filter((tab) => !isRememberedTab(state, tab, isPlaceholderUrl))
      .map((tab) => tab.id);
    const discardIds = new Set(discardTabIds);
    const restoreTabs = state.tabs.filter((tab) => tab.groupId === destinationGroupId
      && tab.status === "closed" && isRememberedTab(state, tab, isPlaceholderUrl));
    const destinationWindowIds = new Set(restoreTabs.map((tab) => tab.windowId));
    return {
      state: { ...state, tabs: state.tabs.filter((tab) => !discardIds.has(tab.id)) },
      closeTabs: state.tabs.filter((tab) => tab.status === "open" && discardIds.has(tab.id)),
      restoreTabs,
      placeholderWindowIds: [],
      removePlaceholderWindowIds: [],
      recreateWindowIds: state.windows
        .filter((window) => window.isOpen === false && destinationWindowIds.has(window.id))
        .map((window) => window.browserWindowId),
      closeWindowIds: [],
      discardTabIds,
      createTemporaryWindow: false,
    };
  }

  const discardTabIds = state.tabs
    .filter((tab) => !isRememberedTab(state, tab, isPlaceholderUrl))
    .map((tab) => tab.id);
  const discardIds = new Set(discardTabIds);
  const destinationTabs = state.tabs.filter((tab) => tab.groupId === destinationGroupId
    && isRememberedTab(state, tab, isPlaceholderUrl));
  const destinationWindowIds = new Set(destinationTabs.map((tab) => tab.windowId));
  const closeTabs = state.tabs.filter((tab) => tab.status === "open"
    && (tab.groupId !== destinationGroupId || discardIds.has(tab.id)));
  const restoreTabs = destinationTabs.filter((tab) => tab.status === "closed");
  const openWindows = state.windows.filter((window) => window.isOpen !== false);
  const pinnedWindows = openWindows.filter((window) => (window.pinnedTabIds ?? []).length > 0);
  const keepWindowIds = new Set([
    ...destinationWindowIds,
    ...pinnedWindows.map((window) => window.id),
  ]);
  const placeholderWindowIds = [];
  let createTemporaryWindow = false;

  if (!destinationWindowIds.size && !pinnedWindows.length) {
    const temporaryWindow = openWindows.find((window) => window.placeholderTabId !== null)
      ?? openWindows[0];
    if (temporaryWindow) {
      keepWindowIds.add(temporaryWindow.id);
      if (temporaryWindow.placeholderTabId === null) {
        placeholderWindowIds.push(temporaryWindow.browserWindowId);
      }
    } else {
      createTemporaryWindow = true;
    }
  }

  const removePlaceholderWindowIds = state.windows
    .filter((window) => window.isOpen !== false)
    .filter((window) => window.placeholderTabId !== null)
    .filter((window) => destinationWindowIds.has(window.id)
      || pinnedWindows.some((pinnedWindow) => pinnedWindow.id === window.id))
    .map((window) => window.browserWindowId);
  const recreateWindowIds = state.windows
    .filter((window) => window.isOpen === false)
    .filter((window) => destinationWindowIds.has(window.id))
    .map((window) => window.browserWindowId);
  const closeWindowIds = openWindows
    .filter((window) => !keepWindowIds.has(window.id))
    .map((window) => window.browserWindowId);

  return {
    state: {
      ...state,
      activeGroupId: destinationGroupId,
      tabs: state.tabs.filter((tab) => !discardIds.has(tab.id)),
    },
    closeTabs,
    restoreTabs,
    placeholderWindowIds,
    removePlaceholderWindowIds,
    recreateWindowIds,
    closeWindowIds,
    discardTabIds,
    createTemporaryWindow,
  };
}

export function promotePlaceholder(state, browserTab, options = {}) {
  const window = state.windows.find((candidate) => candidate.browserWindowId === browserTab.windowId);
  if (!window || window.placeholderTabId !== browserTab.id) return state;

  if (browserTab.pinned) {
    return {
      ...state,
      windows: state.windows.map((candidate) => candidate.id === window.id
        ? {
          ...candidate,
          placeholderTabId: null,
          pinnedTabIds: [...new Set([...(candidate.pinnedTabIds ?? []), browserTab.id])],
        }
        : candidate),
    };
  }

  const createId = options.createId ?? (() => crypto.randomUUID());
  const promoted = normalizeTab({ ...browserTab, windowKey: window.id }, state.activeGroupId, createId);
  return {
    ...state,
    tabs: [...state.tabs, promoted],
    windows: state.windows.map((candidate) => candidate.id === window.id
      ? { ...candidate, placeholderTabId: null, pinnedTabIds: (candidate.pinnedTabIds ?? []).filter((id) => id !== browserTab.id) }
      : candidate),
  };
}

export function setWindowPlaceholder(state, browserWindowId, browserTabId, options = {}) {
  const createId = options.createId ?? (() => crypto.randomUUID());
  return {
    ...state,
    windows: upsertWindow(state.windows, browserWindowId, createId).map((window) => window.browserWindowId === browserWindowId
      ? { ...window, isOpen: true, placeholderTabId: browserTabId }
      : window),
  };
}

export function deleteGroup(state, groupId, options = {}) {
  const group = requireGroup(state, groupId);
  const closeTabs = state.tabs.filter((tab) => tab.groupId === groupId && tab.status === "open");
  const tabs = state.tabs.filter((tab) => tab.groupId !== groupId);
  let groups = state.groups.filter((candidate) => candidate.id !== groupId);
  const createId = options.createId ?? (() => crypto.randomUUID());
  const deletedDefault = group.name.toLocaleLowerCase() === DEFAULT_GROUP_NAME.toLocaleLowerCase();
  let replacementDefault = null;

  if (deletedDefault || groups.length === 0) {
    replacementDefault = {
      id: createId(),
      name: DEFAULT_GROUP_NAME,
      color: DEFAULT_GROUP_COLOR,
      order: groups.length,
    };
    groups = [...groups, replacementDefault];
  }

  const activeGroupId = groupId !== state.activeGroupId
    ? state.activeGroupId
    : replacementDefault?.id ?? groups.find((candidate) => candidate.name.toLocaleLowerCase() === DEFAULT_GROUP_NAME.toLocaleLowerCase())?.id ?? groups[0].id;

  return {
    state: {
      ...state,
      groups: groups.map((candidate, order) => ({ ...candidate, order })),
      tabs,
      activeGroupId,
    },
    closeTabs,
    deletedTabIds: state.tabs.filter((tab) => tab.groupId === groupId).map((tab) => tab.id),
    placeholderWindowIds: state.windows
      .filter((window) => window.isOpen !== false)
      .filter((window) => window.placeholderTabId === null
        && !tabs.some((tab) => tab.groupId === activeGroupId
          && tab.browserWindowId === window.browserWindowId))
      .map((window) => window.browserWindowId),
    removePlaceholderWindowIds: state.windows
      .filter((window) => window.isOpen !== false)
      .filter((window) => window.placeholderTabId !== null
        && tabs.some((tab) => tab.groupId === activeGroupId
          && tab.browserWindowId === window.browserWindowId))
      .map((window) => window.browserWindowId),
  };
}

export function markTabClosed(state, browserTabId, sessionId = null) {
  return {
    ...state,
    tabs: state.tabs.map((tab) => tab.browserTabId === browserTabId
      ? { ...tab, browserTabId: null, sessionId, status: "closed" }
      : tab),
  };
}

export function handleTabRemoved(state, browserTabId, removeInfo = {}) {
  if (removeInfo.isWindowClosing && Number.isInteger(removeInfo.windowId)) {
    return handleWindowRemoved(state, removeInfo.windowId, { preserveTabs: true });
  }

  return {
    ...state,
    tabs: state.tabs.filter((tab) => tab.browserTabId !== browserTabId),
    windows: state.windows.map((window) => ({
      ...window,
      placeholderTabId: window.placeholderTabId === browserTabId ? null : window.placeholderTabId,
      pinnedTabIds: (window.pinnedTabIds ?? []).filter((id) => id !== browserTabId),
    })),
  };
}

export function handleWindowRemoved(state, browserWindowId, { preserveTabs = false } = {}) {
  const tabs = preserveTabs
    ? state.tabs.map((tab) => tab.browserWindowId === browserWindowId && tab.status === "open"
      ? { ...tab, browserTabId: null, sessionId: null, status: "closed" }
      : tab)
    : state.tabs.filter((tab) => tab.browserWindowId !== browserWindowId
      || tab.groupId !== state.activeGroupId);

  return pruneUnreferencedWindows({
    ...state,
    tabs,
    windows: state.windows.map((window) => window.browserWindowId === browserWindowId
      ? { ...window, isOpen: false, placeholderTabId: null, pinnedTabIds: [] }
      : window),
  });
}

export function pruneUnreferencedWindows(state, ignoredOperationId = null) {
  const logicalWindowIds = new Set(state.tabs.map((tab) => tab.windowId));
  const browserWindowIds = new Set();
  const addRecord = (record) => {
    if (typeof record?.windowId === "string") logicalWindowIds.add(record.windowId);
    if (Number.isInteger(record?.browserWindowId)) browserWindowIds.add(record.browserWindowId);
  };

  for (const operation of state.operations) {
    if (operation.id === ignoredOperationId) continue;
    const payload = operation.payload;
    for (const record of [...(payload.closeRecords ?? []), ...(payload.deletedRecords ?? [])]) addRecord(record);
    addRecord(payload.closeRecord);
    for (const id of [
      ...(payload.recreateWindowRecordIds ?? []),
      ...(payload.createdWindowRecordIds ?? []),
      ...(payload.restoredWindowRecordIds ?? []),
      ...(payload.userClosedWindowRecordIds ?? []),
      payload.temporaryWindowId,
    ]) {
      if (typeof id === "string") logicalWindowIds.add(id);
    }
    for (const id of [
      ...(payload.closeWindowIds ?? []),
      ...(payload.windowCloseStartedIds ?? []),
      ...(payload.placeholderWindowIds ?? []),
      ...(payload.removePlaceholderWindowIds ?? []),
    ]) {
      if (Number.isInteger(id)) browserWindowIds.add(id);
    }
  }

  return {
    ...state,
    windows: state.windows.filter((window) => window.isOpen
      || logicalWindowIds.has(window.id)
      || browserWindowIds.has(window.browserWindowId)),
  };
}

function normalizeTab(tab, groupId, createId, existingId = null) {
  if (!Number.isInteger(tab.windowId)) throw new Error("A tab must belong to a normal browser window.");

  return {
    id: existingId ?? createId(),
    browserTabId: Number.isInteger(tab.id) ? tab.id : null,
    browserWindowId: tab.windowId,
    windowId: tab.windowKey ?? tab.windowId,
    groupId,
    url: typeof tab.pendingUrl === "string" && tab.pendingUrl
      ? tab.pendingUrl
      : typeof tab.url === "string" ? tab.url : "",
    title: typeof tab.title === "string" ? tab.title : "",
    faviconUrl: typeof tab.favIconUrl === "string" ? tab.favIconUrl : "",
    index: Number.isInteger(tab.index) ? tab.index : 0,
    lastActive: Boolean(tab.active),
    sessionId: typeof tab.sessionId === "string" ? tab.sessionId : null,
    status: tab.status === "closed" ? "closed" : "open",
  };
}

function upsertWindow(windows, browserWindowId, createId, windowKey = null) {
  if (!Number.isInteger(browserWindowId)) throw new Error("A window ID is required.");
  const byBrowserId = windows.find((window) => window.browserWindowId === browserWindowId);
  if (byBrowserId) {
    return windows.map((window) => window.id === byBrowserId.id ? { ...window, isOpen: true } : window);
  }
  const byLogicalId = windowKey ? windows.find((window) => window.id === windowKey) : null;
  if (byLogicalId) {
    return windows.map((window) => window.id === byLogicalId.id
      ? { ...window, browserWindowId, isOpen: true }
      : window);
  }
  return [...windows, { id: createId(), browserWindowId, isOpen: true, placeholderTabId: null, pinnedTabIds: [] }];
}

function validateName(name) {
  if (typeof name !== "string") throw new Error("Enter a group name.");
  const normalized = name.trim();
  if (!normalized) throw new Error("Enter a group name.");
  if (normalized.length > 40) throw new Error("Group names must be 40 characters or fewer.");
  return normalized;
}

function requireGroup(state, groupId) {
  const group = state.groups.find((candidate) => candidate.id === groupId);
  if (!group) throw new Error("That group no longer exists.");
  return group;
}

function requireTab(state, tabId) {
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) throw new Error("That tab is no longer managed.");
  return tab;
}
