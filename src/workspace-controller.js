import {
  assignTab,
  createFirstRunState,
  createGroup,
  deleteGroup as deleteGroupState,
  handleTabRemoved,
  moveTab,
  planGroupSwitch,
  promotePlaceholder,
  recolorGroup,
  renameGroup,
  reorderGroups,
  setWindowPlaceholder,
} from "./group-state.js";

export function createInitialStateFactory(browser) {
  return async () => {
    const windows = await browser.getNormalWindows();
    return createFirstRunState(windows.flatMap((window) => (window.tabs ?? []).map((tab) => ({
      ...tab,
      windowId: window.id,
    }))));
  };
}

export class WorkspaceController {
  #store;
  #browser;
  #ready = null;
  #preCloseTabRemovals = new Map();
  #closeOperationsPreparing = new Set();
  #closeRequestsIssued = new Set();

  constructor({ store, browser }) {
    if (!store || !browser) throw new Error("WorkspaceController requires state and browser adapters.");
    this.#store = store;
    this.#browser = browser;
  }

  initialize() {
    if (!this.#ready) {
      this.#ready = this.#initialize();
      this.#ready.catch(() => { this.#ready = null; });
    }
    return this.#ready;
  }

  async getState() {
    await this.initialize();
    if (this.#store.snapshot().operations.length) {
      await this.#store.resumePending(this.#recoveryHandlers());
    }
    this.#cleanupOperationTracking();
    return this.#store.snapshot();
  }

  async createGroup(details) {
    await this.initialize();
    const state = await this.#store.update((current) => createGroup(current, details));
    await this.#browser.createMoveMenu(state);
    return state;
  }

  async renameGroup(groupId, name) {
    await this.initialize();
    const state = await this.#store.update((current) => renameGroup(current, groupId, name));
    await this.#browser.updateNativeGroups(state);
    await this.#browser.createMoveMenu(state);
    return state;
  }

  async recolorGroup(groupId, color) {
    await this.initialize();
    const state = await this.#store.update((current) => recolorGroup(current, groupId, color));
    await this.#browser.updateNativeGroups(state);
    return state;
  }

  async reorderGroups(orderedIds) {
    await this.initialize();
    return this.#store.update((current) => reorderGroups(current, orderedIds));
  }

  async deleteGroup(groupId) {
    await this.initialize();
    if (this.#store.snapshot().operations.length) {
      await this.#store.resumePending(this.#recoveryHandlers());
    }
    const operation = await this.#store.runJournaled({
      id: `delete-${crypto.randomUUID()}`,
      type: "delete-group",
      makePayload: (state) => {
        const replacementId = crypto.randomUUID();
        const transition = deleteGroupState(state, groupId, { createId: () => replacementId });
        const deletedRecords = state.tabs.filter((tab) => tab.groupId === groupId).map(snapshotTab);
        const closeRecords = transition.closeTabs.map(snapshotTab);
        return {
          groupId,
          replacementId,
          deletedRecords,
          destinationGroupId: transition.state.activeGroupId,
          closeRecords,
          closingTabIds: closeRecords.map((tab) => tab.browserTabId),
        };
      },
      prepare: (state, record) => deleteGroupState(state, groupId, {
        createId: () => record.payload.replacementId,
      }).state,
      perform: async (pending, state, checkpoint) => ({
        ...(await this.#performGroupSwitch(pending, state, checkpoint)),
        deletedCount: pending.payload.deletedRecords.length,
      }),
      finalize: (state) => state,
    });
    this.#cleanupOperationTracking();
    await this.#browser.createMoveMenu(operation.state);
    return { ...operation.result, state: operation.state };
  }

  async onTabCreated(tab) {
    await this.initialize();
    if (tab.incognito || isPlaceholderTab(this.#browser, tab)) return this.#store.snapshot();

    const liveTab = await this.#browser.getTab(tab.id).catch(() => null);
    if (!liveTab || liveTab.incognito || liveTab.pinned || isPlaceholderTab(this.#browser, liveTab)) {
      return this.#store.snapshot();
    }
    tab = liveTab;

    const previous = this.#store.snapshot();
    if (previous.windows.some((window) => window.placeholderTabId === tab.id)) return previous;
    const logicalWindow = previous.windows.find((window) => window.browserWindowId === tab.windowId);
    const candidate = findSnapshot(previous, tab, logicalWindow?.id, new Set());
    const adoptSnapshotId = candidate?.status === "closed"
      && candidate.groupId === previous.activeGroupId
      ? candidate.id
      : null;
    const managed = await this.#store.update((current) => {
      const existing = current.tabs.find((item) => item.browserTabId === tab.id);
      if (existing) return assignTab(current, { ...tab, windowKey: logicalWindow?.id }, existing.groupId);
      const snapshot = adoptSnapshotId
        ? current.tabs.find((item) => item.id === adoptSnapshotId
          && item.status === "closed" && item.groupId === current.activeGroupId)
        : null;
      return snapshot
        ? adoptLiveTabSnapshot(current, snapshot, tab)
        : assignTab(current, { ...tab, windowKey: logicalWindow?.id });
    });
    const record = managed.tabs.find((item) => item.browserTabId === tab.id);
    if (record && !tab.pinned) await this.#browser.groupManagedTabs(managed, record.groupId, tab.windowId);
    const stillLive = await this.#browser.getTab(tab.id).catch(() => null);
    if (stillLive) return managed;

    const latest = this.#store.snapshot();
    if (latest.operations.some((operation) => operationClosesTab(operation, latest, tab.id))) return latest;
    const removed = await this.#store.update((current) => handleTabRemoved(current, tab.id, {
      windowId: tab.windowId,
      isWindowClosing: false,
    }));
    if (!removed.operations.length) await this.#ensurePlaceholder(tab.windowId);
    return removed;
  }

  async onTabUpdated(tabId, changeInfo, tab) {
    await this.initialize();
    if (!tab || tab.incognito) return this.#store.snapshot();
    const state = this.#store.snapshot();
    const placeholderWindow = state.windows.find((window) => window.placeholderTabId === tabId);
    const navigatedUrl = typeof changeInfo.url === "string" ? changeInfo.url : null;
    const navigatedOffPlaceholder = navigatedUrl
      ? !this.#browser.isPlaceholderUrl(navigatedUrl)
      : !isPlaceholderTab(this.#browser, tab);
    if (placeholderWindow && navigatedOffPlaceholder) {
      const promotedTab = navigatedUrl ? { ...tab, url: navigatedUrl } : tab;
      const promoted = await this.#store.update((current) => promotePlaceholder(current, promotedTab));
      const record = promoted.tabs.find((item) => item.browserTabId === tabId);
      if (record) await this.#browser.groupManagedTabs(promoted, record.groupId, tab.windowId);
      return promoted;
    }

    const existing = state.tabs.find((item) => item.browserTabId === tabId);
    if (tab.pinned) {
      const updated = await this.#store.update((current) => assignTab(current, tab));
      if (existing) await this.#browser.groupManagedTabs(updated, existing.groupId, tab.windowId);
      return updated;
    }
    if (!existing) return this.onTabCreated(tab);

    if (existing.browserWindowId !== tab.windowId) {
      const destinationWindow = state.windows.find((window) => window.browserWindowId === tab.windowId);
      const moved = await this.#store.update((current) => assignTab(
        current,
        { ...tab, windowKey: destinationWindow?.id },
        existing.groupId,
      ));
      await this.#browser.groupManagedTabs(moved, existing.groupId, existing.browserWindowId);
      await this.#browser.groupManagedTabs(moved, existing.groupId, tab.windowId);
      return moved;
    }

    return this.#store.update((current) => ({
      ...current,
      tabs: current.tabs.map((item) => item.id === existing.id
        ? {
          ...item,
          url: typeof tab.url === "string" ? tab.url : item.url,
          title: typeof tab.title === "string" ? tab.title : item.title,
          faviconUrl: typeof tab.favIconUrl === "string" ? tab.favIconUrl : item.faviconUrl,
          index: Number.isInteger(tab.index) ? tab.index : item.index,
        }
        : item),
    }));
  }

  async onTabMoved(tabId, moveInfo) {
    await this.initialize();
    if (!Number.isInteger(moveInfo?.windowId)) return this.#store.snapshot();
    const browserWindow = (await this.#browser.getNormalWindows())
      .find((window) => window.id === moveInfo.windowId);
    if (!browserWindow) return this.#store.snapshot();
    const indexes = new Map((browserWindow.tabs ?? []).map((tab) => [tab.id, tab.index]));
    return this.#store.update((current) => ({
      ...current,
      tabs: current.tabs.map((tab) => tab.browserWindowId === moveInfo.windowId
        && Number.isInteger(indexes.get(tab.browserTabId))
        ? { ...tab, index: indexes.get(tab.browserTabId) }
        : tab),
    }));
  }

  async onTabRemoved(tabId, removeInfo) {
    await this.initialize();
    const state = this.#store.snapshot();
    const expectedOperation = state.operations.find((operation) => operationClosesTab(operation, state, tabId));
    if (expectedOperation) {
      if (!removeInfo.isWindowClosing
        && this.#closeOperationsPreparing.has(expectedOperation.id)
        && !this.#closeRequestsIssued.has(expectedOperation.id)) {
        const removedIds = this.#preCloseTabRemovals.get(expectedOperation.id) ?? new Set();
        removedIds.add(tabId);
        this.#preCloseTabRemovals.set(expectedOperation.id, removedIds);
      }
      return state;
    }

    const removedTab = state.tabs.find((tab) => tab.browserTabId === tabId);
    const updated = await this.#store.update((current) => handleTabRemoved(current, tabId, removeInfo));
    if (!removeInfo.isWindowClosing) {
      if (removedTab) {
        await this.#browser.groupManagedTabs(updated, removedTab.groupId, removeInfo.windowId);
      }
      await this.#ensurePlaceholder(removeInfo.windowId);
      return this.#store.snapshot();
    }
    return updated;
  }

  async onWindowRemoved(browserWindowId) {
    await this.initialize();
    return this.#store.update((current) => ({
      ...current,
      tabs: current.tabs.map((tab) => tab.browserWindowId === browserWindowId
        ? { ...tab, browserTabId: null, sessionId: null, status: "closed" }
        : tab),
      windows: current.windows.map((window) => window.browserWindowId === browserWindowId
        ? { ...window, isOpen: false, placeholderTabId: null, pinnedTabIds: [] }
        : window),
    }));
  }

  async onTabAttached(tabId, attachInfo) {
    await this.initialize();
    const tab = await this.#browser.getTab(tabId);
    if (!tab || tab.incognito || tab.pinned || isPlaceholderTab(this.#browser, tab)) {
      return this.#store.snapshot();
    }

    const state = this.#store.snapshot();
    const existing = state.tabs.find((item) => item.browserTabId === tabId);
    const destinationWindow = state.windows.find((window) => window.browserWindowId === attachInfo.newWindowId);
    const next = await this.#store.update((current) => assignTab(
      current,
      { ...tab, windowId: attachInfo.newWindowId, index: attachInfo.newPosition, windowKey: destinationWindow?.id },
      existing?.groupId ?? current.activeGroupId,
    ));
    if (existing && existing.browserWindowId !== attachInfo.newWindowId) {
      await this.#browser.groupManagedTabs(next, existing.groupId, existing.browserWindowId);
    }
    await this.#browser.groupManagedTabs(next, existing?.groupId ?? next.activeGroupId, attachInfo.newWindowId);
    return next;
  }

  async onTabActivated(activeInfo) {
    await this.initialize();
    const tab = await this.#browser.getTab(activeInfo.tabId);
    if (!tab || tab.incognito || tab.pinned || isPlaceholderTab(this.#browser, tab)) {
      return this.#store.snapshot();
    }
    let state = this.#store.snapshot();
    if (!state.tabs.some((item) => item.browserTabId === tab.id)) state = await this.onTabCreated(tab);
    const record = state.tabs.find((item) => item.browserTabId === tab.id);
    if (!record) return state;
    return this.#store.update((current) => ({
      ...current,
      tabs: current.tabs.map((item) => item.windowId === record.windowId && item.groupId === record.groupId
        ? { ...item, lastActive: item.id === record.id }
        : item),
    }));
  }

  async switchGroup(destinationGroupId) {
    await this.initialize();
    if (this.#store.snapshot().operations.length) {
      await this.#store.resumePending(this.#recoveryHandlers());
    }
    const operation = await this.#store.runJournaled({
      id: `switch-${crypto.randomUUID()}`,
      type: "switch-group",
      makePayload: (state) => {
        const transition = planGroupSwitch(state, destinationGroupId);
        const closeRecords = transition.closeTabs.map(snapshotTab);
        const needsRestore = state.tabs.some((tab) => tab.groupId === destinationGroupId && tab.status === "closed");
        return {
          destinationGroupId,
          closeRecords,
          closingTabIds: closeRecords.map((tab) => tab.browserTabId),
          noop: destinationGroupId === state.activeGroupId && !needsRestore,
        };
      },
      prepare: (state, record) => {
        if (record.payload.noop) return state;
        const transition = planGroupSwitch(state, destinationGroupId);
        const closeRecordIds = new Set(record.payload.closeRecords.map((tab) => tab.id));
        return {
          ...transition.state,
          tabs: transition.state.tabs.map((tab) => closeRecordIds.has(tab.id)
            ? { ...tab, browserTabId: null, sessionId: null, status: "closed" }
            : tab),
        };
      },
      perform: (record, state, checkpoint) => this.#performGroupSwitch(record, state, checkpoint),
      finalize: (state) => state,
    });

    this.#cleanupOperationTracking();
    return { ...operation.result, state: operation.state };
  }

  async moveTab(tabId, destinationGroupId) {
    await this.initialize();
    if (this.#store.snapshot().operations.length) {
      await this.#store.resumePending(this.#recoveryHandlers());
    }
    let state = this.#store.snapshot();
    let record = Number.isInteger(tabId)
      ? state.tabs.find((tab) => tab.browserTabId === tabId)
      : state.tabs.find((tab) => tab.id === tabId);
    if (!record) {
      if (!Number.isInteger(tabId)) return state;
      const liveTab = await this.#browser.getTab(tabId).catch(() => null);
      if (!liveTab || liveTab.incognito || liveTab.pinned
        || isPlaceholderTab(this.#browser, liveTab)) return state;
      state = await this.#store.update((current) => assignTab(current, liveTab));
      record = state.tabs.find((tab) => tab.browserTabId === tabId);
    }
    if (!record) return state;
    const operation = await this.#store.runJournaled({
      id: `move-${crypto.randomUUID()}`,
      type: "move-tab",
      makePayload: (current) => {
        const currentRecord = current.tabs.find((tab) => tab.id === record.id);
        if (!currentRecord) throw new Error("That tab is no longer managed.");
        const transition = moveTab(current, record.id, destinationGroupId);
        const movedRecord = transition.state.tabs.find((tab) => tab.id === record.id);
        const shouldClose = Number.isInteger(transition.closeBrowserTab);
        const shouldRestore = movedRecord.status === "closed"
          && destinationGroupId === current.activeGroupId;
        return {
          destinationGroupId,
          recordId: record.id,
          closeRecord: snapshotTab(currentRecord),
          closingTabIds: shouldClose ? [transition.closeBrowserTab] : [],
          closeRecords: shouldClose ? [snapshotTab(currentRecord)] : [],
          shouldClose,
          shouldRestore,
          shouldGroup: movedRecord.status === "open" && movedRecord.groupId !== currentRecord.groupId,
          noop: currentRecord.groupId === destinationGroupId,
        };
      },
      prepare: (current, pending) => pending.payload.noop
        ? current
        : moveTab(current, record.id, destinationGroupId).state,
      perform: (pending, pendingState, checkpoint) => this.#performMoveOperation(pending, pendingState, checkpoint),
      finalize: (current) => current,
    });
    this.#cleanupOperationTracking();
    return operation.state;
  }

  async #initialize() {
    const initial = await this.#store.load();
    let state = await this.#reconcile(initial);
    await this.#store.update(() => state);
    if (state.operations.length) await this.#store.resumePending(this.#recoveryHandlers());
    state = this.#store.snapshot();
    if (this.#store.didCreateInitialState) await this.#browser.adoptInitialTabs(state);
    else await this.#browser.updateNativeGroups(state);
    await this.#browser.createMoveMenu(state);
    return state;
  }

  #recoveryHandlers() {
    return {
      "switch-group": {
        perform: (operation, state, checkpoint) => this.#performGroupSwitch(operation, state, checkpoint),
        finalize: (state) => state,
      },
      "move-tab": {
        perform: (operation, state, checkpoint) => this.#performMoveOperation(operation, state, checkpoint),
        finalize: (state) => state,
      },
      "delete-group": {
        perform: (operation, state, checkpoint) => this.#performGroupSwitch(operation, state, checkpoint),
        finalize: (state) => state,
      },
    };
  }

  async #performMoveTab(operation, initialState, checkpoint) {
    let closeRecord = operation.payload.closeRecord;
    if (!operation.payload.closeStarted) this.#closeOperationsPreparing.add(operation.id);
    const closeRecordId = closeRecord.id;
    let closeRecords = operation.payload.closeRecords ?? [closeRecord];
    let state = initialState;
    const record = state.tabs.find((tab) => tab.id === closeRecord.id);
    const logicalWindow = state.windows.find((window) => window.id === closeRecord.windowId);
    const activeTabsRemain = initialState.tabs.some((tab) => tab.groupId === initialState.activeGroupId
      && tab.windowId === closeRecord.windowId && tab.status === "open");
    if (logicalWindow?.isOpen && logicalWindow.placeholderTabId === null && !activeTabsRemain) {
      const placeholder = await this.#browser.createPlaceholder(logicalWindow.browserWindowId, logicalWindow.id);
      await checkpoint((state) => setWindowPlaceholder(state, logicalWindow.browserWindowId, placeholder.id));
    }
    const oldSessions = await this.#browser.getRecentlyClosed().catch(() => []);
    let tabIds = new Set(operation.payload.closingTabIds ?? []);
    if (record?.status === "open" && Number.isInteger(record.browserTabId)) tabIds.add(record.browserTabId);
    if (!operation.payload.closeStarted) {
      state = await checkpoint((current) => ({
        ...current,
        operations: current.operations.map((pending) => pending.id === operation.id
          ? { ...pending, payload: { ...pending.payload, closeStarted: true } }
          : pending),
      }));
    }
    let reconciliation;
    while (true) {
      reconciliation = await this.#reconcilePlannedCloses(
        operation,
        state,
        closeRecords,
        tabIds,
        checkpoint,
        !operation.payload.closeStarted,
      );
      state = reconciliation.state;
      closeRecords = reconciliation.closeRecords;
      closeRecord = reconciliation.closeRecords.find((item) => item.id === closeRecordId) ?? null;
      tabIds = reconciliation.closingTabIds;
      const earlyRemovals = this.#preCloseTabRemovals.get(operation.id);
      if (!closeRecords.some((item) => earlyRemovals?.has(item.browserTabId))) {
        this.#closeRequestsIssued.add(operation.id);
        break;
      }
    }
    await this.#browser.removeTabs([...tabIds]);
    if (closeRecord) {
      await this.#browser.groupManagedTabs(
        this.#store.snapshot(),
        closeRecord.groupId,
        closeRecord.browserWindowId,
      );
    }
    const newSessions = (await this.#browser.getRecentlyClosed().catch(() => []))
      .filter((session) => session.tab?.sessionId
        && !oldSessions.some((old) => old.tab?.sessionId === session.tab.sessionId));
    const sessionId = closeRecord
      ? matchClosedSessions([closeRecord], newSessions).get(closeRecord.id)
      : null;
    if (sessionId) {
      await checkpoint((state) => ({
        ...state,
        tabs: state.tabs.map((tab) => tab.id === closeRecord.id ? { ...tab, sessionId } : tab),
      }));
    }
    return { closedTabId: closeRecord?.browserTabId ?? null, sessionId: sessionId ?? null };
  }

  async #reconcilePlannedCloses(
    operation,
    initialState,
    closeRecords,
    closingTabIds,
    checkpoint,
    includeMissingLive,
    liveWindows = null,
  ) {
    const windows = liveWindows ?? await this.#browser.getNormalWindows();
    const liveWindowIds = new Set(windows.map((window) => window.id));
    const liveTabIds = new Set(windows.flatMap((window) => window.tabs ?? []).map((tab) => tab.id));
    const earlyRemovals = this.#preCloseTabRemovals.get(operation.id) ?? new Set();
    const missingRecords = closeRecords.filter((record) => Number.isInteger(record.browserTabId)
      && (earlyRemovals.has(record.browserTabId)
        || (includeMissingLive && liveWindowIds.has(record.browserWindowId)
          && !liveTabIds.has(record.browserTabId))));
    const missingRecordIds = new Set(missingRecords.map((record) => record.id));
    const missingBrowserTabIds = new Set(missingRecords.map((record) => record.browserTabId));
    const nextCloseRecords = closeRecords.filter((record) => !missingRecordIds.has(record.id));
    const nextClosingTabIds = new Set([...closingTabIds].filter((tabId) =>
      !earlyRemovals.has(tabId) && (!includeMissingLive || liveTabIds.has(tabId))));
    const operationPayload = operation.payload;
    const payloadCloseIds = operationPayload.closingTabIds ?? [];
    const payloadChanged = nextCloseRecords.length !== closeRecords.length
      || payloadCloseIds.length !== nextClosingTabIds.size
      || payloadCloseIds.some((tabId) => !nextClosingTabIds.has(tabId))
      || missingRecordIds.has(operationPayload.closeRecord?.id);

    if (!payloadChanged) {
      return { state: initialState, closeRecords: nextCloseRecords, closingTabIds: nextClosingTabIds };
    }

    const nextState = await checkpoint((current) => ({
      ...current,
      tabs: current.tabs.filter((tab) => !missingRecordIds.has(tab.id)),
      operations: current.operations.map((pending) => pending.id === operation.id
        ? {
          ...pending,
          payload: {
            ...pending.payload,
            closeRecords: nextCloseRecords,
            closingTabIds: [...nextClosingTabIds],
            closeRecord: missingRecordIds.has(pending.payload.closeRecord?.id)
              ? null
              : pending.payload.closeRecord,
          },
        }
        : pending),
    }));
    for (const tabId of missingBrowserTabIds) earlyRemovals.delete(tabId);
    if (!earlyRemovals.size) this.#preCloseTabRemovals.delete(operation.id);
    return { state: nextState, closeRecords: nextCloseRecords, closingTabIds: nextClosingTabIds };
  }

  #cleanupOperationTracking() {
    const pendingOperationIds = new Set(this.#store.snapshot().operations.map((operation) => operation.id));
    for (const operationId of this.#preCloseTabRemovals.keys()) {
      if (!pendingOperationIds.has(operationId)) this.#preCloseTabRemovals.delete(operationId);
    }
    for (const operationId of this.#closeOperationsPreparing) {
      if (!pendingOperationIds.has(operationId)) this.#closeOperationsPreparing.delete(operationId);
    }
    for (const operationId of this.#closeRequestsIssued) {
      if (!pendingOperationIds.has(operationId)) this.#closeRequestsIssued.delete(operationId);
    }
  }

  async #performMoveOperation(operation, state, checkpoint) {
    const payload = operation.payload;
    if (payload.noop) return { moved: false };
    if (payload.shouldClose) return this.#performMoveTab(operation, state, checkpoint);
    if (payload.shouldRestore) return this.#performGroupSwitch(operation, state, checkpoint);
    if (payload.shouldGroup) {
      const record = state.tabs.find((tab) => tab.id === payload.recordId);
      if (record?.status === "open") {
        const sourceGroupId = payload.closeRecord?.groupId;
        const sourceWindowId = payload.closeRecord?.browserWindowId;
        if (Number.isInteger(sourceWindowId) && sourceGroupId !== payload.destinationGroupId) {
          await this.#browser.groupManagedTabs(state, sourceGroupId, sourceWindowId);
        }
        await this.#browser.groupManagedTabs(state, payload.destinationGroupId, record.browserWindowId);
      }
    }
    return { moved: true };
  }

  async #performGroupSwitch(operation, initialState, checkpoint) {
    if (operation.payload.noop) return { failures: [], restoredCount: 0 };
    if (!operation.payload.closeStarted) this.#closeOperationsPreparing.add(operation.id);
    const destinationGroupId = operation.payload.destinationGroupId;
    let closeRecords = operation.payload.closeRecords ?? [];
    let state = initialState;
    const failures = [];
    const liveWindows = await this.#browser.getNormalWindows();
    const liveWindowIds = new Set(liveWindows.map((window) => window.id));
    const liveTabIds = new Set(liveWindows.flatMap((window) => window.tabs ?? []).map((tab) => tab.id));
    let closingTabIds = new Set((operation.payload.closingTabIds ?? [])
      .filter((tabId) => operation.payload.closeStarted || liveTabIds.has(tabId)));
    let reconciliation = await this.#reconcilePlannedCloses(
      operation,
      state,
      closeRecords,
      closingTabIds,
      checkpoint,
      !operation.payload.closeStarted,
      liveWindows,
    );
    state = reconciliation.state;
    closeRecords = reconciliation.closeRecords;
    closingTabIds = reconciliation.closingTabIds;
    for (const closeRecord of closeRecords) {
      const currentRecord = state.tabs.find((tab) => tab.id === closeRecord.id);
      if (currentRecord?.status === "open" && currentRecord.groupId !== destinationGroupId
        && Number.isInteger(currentRecord.browserTabId)) {
        closingTabIds.add(currentRecord.browserTabId);
      }
    }

    for (const window of state.windows.filter((item) => item.isOpen)) {
      const liveWindow = liveWindows.find((item) => item.id === window.browserWindowId);
      const hasDestinationRecords = state.tabs.some((tab) => tab.groupId === destinationGroupId && tab.windowId === window.id);
      const remainingTabs = (liveWindow?.tabs ?? []).filter((tab) => !tab.incognito
        && !tab.pinned && !closingTabIds.has(tab.id)
        && !isPlaceholderTab(this.#browser, tab));
      const willCloseWindow = liveWindow && remainingTabs.length === 0
        && closeRecords.some((tab) => tab.browserWindowId === window.browserWindowId);
      if ((!hasDestinationRecords || willCloseWindow) && window.placeholderTabId === null) {
        try {
          const placeholder = await this.#browser.createPlaceholder(window.browserWindowId, window.id);
          state = await checkpoint((current) => setWindowPlaceholder(
            current,
            window.browserWindowId,
            placeholder.id,
          ));
        } catch (error) {
          throw new Error(`Could not preserve window ${window.browserWindowId}: ${error.message}`, { cause: error });
        }
      }
    }

    const dormantWindows = state.windows.filter((window) => !window.isOpen
      && state.tabs.some((tab) => tab.groupId === destinationGroupId && tab.windowId === window.id));
    for (const dormant of dormantWindows) {
      try {
        const created = await this.#browser.createWindowWithPlaceholder(dormant.id);
        state = await checkpoint((current) => ({
          ...current,
          windows: current.windows.map((window) => window.id === dormant.id
            ? {
              ...window,
              browserWindowId: created.windowId,
              isOpen: true,
              placeholderTabId: created.placeholderTabId,
              pinnedTabIds: [],
            }
            : window),
          tabs: current.tabs.map((tab) => tab.windowId === dormant.id
            ? { ...tab, browserWindowId: created.windowId }
            : tab),
        }));
      } catch (error) {
        failures.push(`Could not recreate window for ${dormant.id}: ${error.message}`);
      }
    }

    const recentlyClosedBefore = await this.#browser.getRecentlyClosed().catch(() => []);
    if (!operation.payload.closeStarted) {
      state = await checkpoint((current) => ({
        ...current,
        operations: current.operations.map((pending) => pending.id === operation.id
          ? { ...pending, payload: { ...pending.payload, closeStarted: true } }
          : pending),
      }));
    }
    while (true) {
      const currentLiveWindows = await this.#browser.getNormalWindows();
      reconciliation = await this.#reconcilePlannedCloses(
        operation,
        state,
        closeRecords,
        closingTabIds,
        checkpoint,
        !operation.payload.closeStarted,
        currentLiveWindows,
      );
      state = reconciliation.state;
      closeRecords = reconciliation.closeRecords;
      closingTabIds = reconciliation.closingTabIds;
      const earlyRemovals = this.#preCloseTabRemovals.get(operation.id);
      if (!closeRecords.some((record) => earlyRemovals?.has(record.browserTabId))) {
        this.#closeRequestsIssued.add(operation.id);
        break;
      }
    }
    try {
      await this.#browser.removeTabs([...closingTabIds]);
    } catch (error) {
      throw new Error(`Could not close the outgoing tabs: ${error.message}`, { cause: error });
    }
    const recentlyClosedAfter = await this.#browser.getRecentlyClosed().catch(() => []);
    const newSessions = recentlyClosedAfter.filter((session) => {
      const sessionId = session.tab?.sessionId;
      return typeof sessionId === "string"
        && !recentlyClosedBefore.some((old) => old.tab?.sessionId === sessionId);
    });
    const sessionAssignments = matchClosedSessions(closeRecords, newSessions);
    if (sessionAssignments.size) {
      state = await checkpoint((current) => ({
        ...current,
        tabs: current.tabs.map((tab) => sessionAssignments.has(tab.id)
          ? { ...tab, sessionId: sessionAssignments.get(tab.id) }
          : tab),
      }));
    }

    const restoredTabIds = new Set();
    const destinationRecords = state.tabs
      .filter((tab) => tab.groupId === destinationGroupId && tab.status === "closed")
      .sort((a, b) => a.windowId.localeCompare(b.windowId) || a.index - b.index);
    for (const record of destinationRecords) {
      let window = state.windows.find((candidate) => candidate.id === record.windowId);
      if (!window?.isOpen) {
        failures.push(`No open window is available for “${record.title || record.url}”.`);
        continue;
      }

      try {
        let restoredTab = await this.#browser.findMatchingTab(record, window.browserWindowId, [...restoredTabIds]);
        if (!restoredTab && record.sessionId) {
          const restoredSession = await this.#browser.restoreSession(record.sessionId).catch(() => null);
          restoredTab = restoredSession?.tab ?? null;
          if (restoredTab && restoredTab.windowId !== window.browserWindowId) {
            try {
              restoredTab = await this.#browser.moveTabToWindow(restoredTab.id, window.browserWindowId, record.index);
            } catch {
              await this.#browser.removeTabs([restoredTab.id]).catch(() => undefined);
              restoredTab = null;
            }
          }
        }
        if (!restoredTab) {
          const properties = { windowId: window.browserWindowId, index: record.index, active: false };
          if (record.url) properties.url = record.url;
          try {
            restoredTab = await this.#browser.createTab(properties);
          } catch (error) {
            if (!/^(chrome|brave|devtools):/i.test(record.url)) throw error;
            restoredTab = await this.#browser.createTab({ windowId: window.browserWindowId, index: record.index, active: false });
          }
        }
        if (!Number.isInteger(restoredTab?.id)) throw new Error("The browser did not return the restored tab ID.");
        restoredTabIds.add(restoredTab.id);
        state = await checkpoint((current) => ({
          ...current,
          tabs: current.tabs.map((tab) => tab.id === record.id
            ? {
              ...tab,
              browserTabId: restoredTab.id,
              browserWindowId: window.browserWindowId,
              url: restoredTab.url || tab.url,
              title: restoredTab.title || tab.title,
              sessionId: null,
              status: "open",
            }
            : tab),
        }));
      } catch (error) {
        failures.push(`Could not restore “${record.title || record.url}”: ${error.message}`);
      }
    }

    state = this.#store.snapshot();
    for (const window of state.windows.filter((item) => item.isOpen)) {
      const groupTabs = state.tabs.filter((tab) => tab.groupId === destinationGroupId
        && tab.windowId === window.id && tab.status === "open");
      if (!groupTabs.length && window.placeholderTabId === null) {
        try {
          const placeholder = await this.#browser.createPlaceholder(window.browserWindowId, window.id);
          state = await checkpoint((current) => setWindowPlaceholder(
            current,
            window.browserWindowId,
            placeholder.id,
          ));
        } catch (error) {
          failures.push(`Could not create a New Tab placeholder in window ${window.browserWindowId}: ${error.message}`);
        }
      } else if (groupTabs.length && window.placeholderTabId !== null) {
        try {
          await this.#browser.removeTabs([window.placeholderTabId]);
          state = await checkpoint((current) => ({
            ...current,
            windows: current.windows.map((candidate) => candidate.id === window.id
              ? { ...candidate, placeholderTabId: null }
              : candidate),
          }));
        } catch (error) {
          failures.push(`Could not remove the temporary placeholder in window ${window.browserWindowId}: ${error.message}`);
        }
      }
      const orderedTabIds = groupTabs
        .filter((tab) => Number.isInteger(tab.browserTabId))
        .sort((a, b) => a.index - b.index)
        .map((tab) => tab.browserTabId);
      await this.#browser.orderTabs(orderedTabIds, window.browserWindowId).catch((error) => {
        failures.push(`Could not restore tab order in window ${window.browserWindowId}: ${error.message}`);
      });
      await this.#browser.groupManagedTabs(state, destinationGroupId, window.browserWindowId).catch((error) => {
        failures.push(`Could not apply the native tab group in window ${window.browserWindowId}: ${error.message}`);
      });

      const lastActive = groupTabs.find((tab) => tab.lastActive)
        ?? groupTabs.sort((a, b) => a.index - b.index)[0];
      if (lastActive?.browserTabId !== null && Number.isInteger(lastActive?.browserTabId)) {
        await this.#browser.activateTab(lastActive.browserTabId).catch((error) => {
          failures.push(`Could not activate the last tab in window ${window.browserWindowId}: ${error.message}`);
        });
      }
    }

    return { failures, restoredCount: restoredTabIds.size };
  }

  async #reconcile(previousState) {
    const liveWindows = await this.#browser.getNormalWindows();
    const state = structuredClone(previousState);
    const matchedLogicalWindows = new Set();
    const matchedSnapshotIds = new Set();
    const liveTabIds = new Set();
    const activeWindows = new Set();
    const pendingDeletion = pendingDeleteTabIds(state, liveWindows);

    for (const browserWindow of liveWindows) {
      const tabs = [...(browserWindow.tabs ?? [])].sort((a, b) => a.index - b.index);
      let logicalWindow = chooseLogicalWindow(state, browserWindow, tabs, matchedLogicalWindows, this.#browser);
      if (!logicalWindow) {
        const newWindow = {
          id: crypto.randomUUID(),
          browserWindowId: browserWindow.id,
          isOpen: true,
          placeholderTabId: null,
          pinnedTabIds: [],
        };
        state.windows.push(newWindow);
        logicalWindow = newWindow;
      } else {
        logicalWindow.browserWindowId = browserWindow.id;
        logicalWindow.isOpen = true;
        logicalWindow.pinnedTabIds = [];
      }

      matchedLogicalWindows.add(logicalWindow.id);
      activeWindows.add(logicalWindow.id);

      for (const tab of tabs) {
        if (pendingDeletion.excludedIds.has(tab.id)) continue;
        liveTabIds.add(tab.id);
        if (isPlaceholderTab(this.#browser, tab)) {
          logicalWindow.placeholderTabId = tab.id;
          continue;
        }

        logicalWindow.placeholderTabId = logicalWindow.placeholderTabId === tab.id
          ? null
          : logicalWindow.placeholderTabId;
        if (tab.pinned) {
          // A URL match could discard a different tab with the same address.
          // Pinning only removes a managed record with the same live browser ID.
          const old = state.tabs.find((item) => item.browserTabId === tab.id);
          if (old) {
            matchedSnapshotIds.add(old.id);
            state.tabs = state.tabs.filter((item) => item.id !== old.id);
          }
          logicalWindow.pinnedTabIds.push(tab.id);
          continue;
        }

        const snapshot = findSnapshot(state, tab, logicalWindow.id, matchedSnapshotIds);
        if (snapshot) {
          matchedSnapshotIds.add(snapshot.id);
          Object.assign(snapshot, {
            browserTabId: tab.id,
            browserWindowId: browserWindow.id,
            windowId: logicalWindow.id,
            url: typeof tab.url === "string" ? tab.url : snapshot.url,
            title: typeof tab.title === "string" ? tab.title : snapshot.title,
            faviconUrl: typeof tab.favIconUrl === "string" ? tab.favIconUrl : snapshot.faviconUrl,
            index: Number.isInteger(tab.index) ? tab.index : snapshot.index,
            lastActive: Boolean(tab.active),
            status: "open",
          });
        } else {
          const next = assignTab(state, { ...tab, windowKey: logicalWindow.id });
          state.tabs = next.tabs;
          state.windows = next.windows;
        }
      }
    }

    for (const window of state.windows) {
      if (!activeWindows.has(window.id)) {
        window.isOpen = false;
        window.placeholderTabId = null;
        window.pinnedTabIds = [];
      }
    }
    for (const tab of state.tabs) {
      if (tab.status === "open" && !liveTabIds.has(tab.browserTabId)) {
        tab.status = "closed";
        tab.browserTabId = null;
      }
    }

    state.operations = state.operations.map((operation) => {
      const recoveredIds = pendingDeletion.operationIds.get(operation.id);
      return recoveredIds?.length
        ? {
          ...operation,
          payload: {
            ...operation.payload,
            closingTabIds: [...new Set([...(operation.payload.closingTabIds ?? []), ...recoveredIds])],
          },
        }
        : operation;
    });

    return state;
  }

  async #ensurePlaceholder(browserWindowId) {
    if (!Number.isInteger(browserWindowId)) return;
    const state = this.#store.snapshot();
    const window = state.windows.find((item) => item.browserWindowId === browserWindowId && item.isOpen);
    if (!window || window.placeholderTabId !== null) return;
    if (state.tabs.some((tab) => tab.groupId === state.activeGroupId
      && tab.browserWindowId === browserWindowId
      && tab.status === "open")) return;

    const placeholder = await this.#browser.createPlaceholder(browserWindowId, window.id);
    await this.#store.update((current) => setWindowPlaceholder(current, browserWindowId, placeholder.id));
  }
}

function chooseLogicalWindow(state, browserWindow, tabs, used, browser) {
  const placeholderKey = tabs.map((tab) => placeholderWindowKey(browser, tab))
    .find((key) => typeof key === "string" && key);
  if (placeholderKey) {
    const keyedWindow = state.windows.find((window) => window.id === placeholderKey && !used.has(window.id));
    if (keyedWindow) return keyedWindow;
  }

  const sameBrowserWindow = state.windows.find((window) => !used.has(window.id)
    && window.browserWindowId === browserWindow.id);
  if (sameBrowserWindow) return sameBrowserWindow;

  const isPlaceholder = tabs.some((tab) => isPlaceholderTab(browser, tab));
  const scores = new Map();
  for (const tab of tabs) {
    const snapshot = findSnapshot(state, tab, null, new Set());
    if (snapshot) scores.set(snapshot.windowId, (scores.get(snapshot.windowId) ?? 0) + 3);
  }
  if (isPlaceholder) {
    for (const window of state.windows) {
      if (!used.has(window.id) && window.placeholderTabId !== null) {
        scores.set(window.id, (scores.get(window.id) ?? 0) + 2);
      }
    }
  }

  const candidate = [...scores.entries()]
    .filter(([windowId]) => !used.has(windowId))
    .sort((a, b) => b[1] - a[1])[0];
  return candidate ? state.windows.find((window) => window.id === candidate[0]) : null;
}

function findSnapshot(state, browserTab, logicalWindowId, usedIds) {
  const liveIdMatch = state.tabs.find((tab) => tab.browserTabId === browserTab.id && !usedIds.has(tab.id));
  if (liveIdMatch) return liveIdMatch;

  const url = browserTab.url || browserTab.pendingUrl || "";
  const title = browserTab.title ?? "";
  const candidates = state.tabs.filter((tab) => !usedIds.has(tab.id)
    && tab.url === url
    && (browserTab.pendingUrl || tab.title === title || !title || !tab.title));
  return candidates.sort((a, b) => {
    const scoreA = (a.windowId === logicalWindowId ? 10 : 0)
      + (a.browserWindowId === browserTab.windowId ? 5 : 0)
      - Math.abs(a.index - browserTab.index) * 0.01;
    const scoreB = (b.windowId === logicalWindowId ? 10 : 0)
      + (b.browserWindowId === browserTab.windowId ? 5 : 0)
      - Math.abs(b.index - browserTab.index) * 0.01;
    return scoreB - scoreA;
  })[0] ?? null;
}

function adoptLiveTabSnapshot(state, snapshot, browserTab) {
  const assigned = assignTab(state, { ...browserTab, windowKey: snapshot.windowId }, snapshot.groupId);
  const newRecord = assigned.tabs.find((tab) => tab.browserTabId === browserTab.id);
  if (!newRecord) return assigned;
  const adopted = {
    ...snapshot,
    ...newRecord,
    id: snapshot.id,
    windowId: snapshot.windowId,
    url: browserTab.url || browserTab.pendingUrl || snapshot.url,
    title: browserTab.title && browserTab.title !== "New Tab" ? browserTab.title : snapshot.title,
    sessionId: null,
    status: "open",
  };
  return {
    ...assigned,
    tabs: [
      ...assigned.tabs.filter((tab) => tab.id !== snapshot.id && tab.id !== newRecord.id),
      adopted,
    ],
  };
}

function isPlaceholderTab(browser, tab) {
  return browser.isPlaceholderUrl(tab.url) || browser.isPlaceholderUrl(tab.pendingUrl);
}

function placeholderWindowKey(browser, tab) {
  return browser.getPlaceholderWindowKey?.(tab.url)
    ?? browser.getPlaceholderWindowKey?.(tab.pendingUrl)
    ?? null;
}

function matchClosedSessions(records, sessions) {
  const available = sessions.filter((session) => session.tab?.sessionId
    && typeof session.tab.url === "string");
  const usedSessionIds = new Set();
  const assignments = new Map();
  for (const record of [...records].sort((a, b) => a.index - b.index)) {
    const session = available
      .filter((candidate) => !usedSessionIds.has(candidate.tab.sessionId)
        && candidate.tab.url === record.url
        && (!record.title || !candidate.tab.title || candidate.tab.title === record.title))
      .sort((a, b) => {
        const scoreA = (a.tab.windowId === record.browserWindowId ? 100 : 0)
          - Math.abs((a.tab.index ?? record.index) - record.index);
        const scoreB = (b.tab.windowId === record.browserWindowId ? 100 : 0)
          - Math.abs((b.tab.index ?? record.index) - record.index);
        return scoreB - scoreA || b.lastModified - a.lastModified;
      })[0];
    if (!session) continue;
    usedSessionIds.add(session.tab.sessionId);
    assignments.set(record.id, session.tab.sessionId);
  }
  return assignments;
}

function snapshotTab(tab) {
  return {
    id: tab.id,
    browserTabId: tab.browserTabId,
    browserWindowId: tab.browserWindowId,
    windowId: tab.windowId,
    groupId: tab.groupId,
    url: tab.url,
    title: tab.title,
    index: tab.index,
    status: tab.status,
  };
}

function pendingDeleteTabIds(state, liveWindows) {
  const tabs = liveWindows.flatMap((window) => window.tabs ?? []);
  const excluded = new Set();
  const operationIds = new Map();
  for (const operation of state.operations.filter((item) => item.type === "delete-group")) {
    const records = (operation.payload.deletedRecords ?? []).filter((record) => record.status === "open");
    const recovered = [];
    for (const record of records) {
      const direct = tabs.find((tab) => tab.id === record.browserTabId && !excluded.has(tab.id));
      const match = direct ?? tabs
        .filter((tab) => !excluded.has(tab.id)
          && (tab.url ?? tab.pendingUrl ?? "") === record.url
          && (!record.title || !tab.title || tab.title === record.title))
        .sort((a, b) => {
          const sameWindowA = a.windowId === record.browserWindowId ? 100 : 0;
          const sameWindowB = b.windowId === record.browserWindowId ? 100 : 0;
          return (sameWindowB - Math.abs(b.index - record.index))
            - (sameWindowA - Math.abs(a.index - record.index));
        })[0];
      if (match) {
        excluded.add(match.id);
        recovered.push(match.id);
      }
    }
    if (recovered.length) operationIds.set(operation.id, recovered);
  }
  return { excludedIds: excluded, operationIds };
}

function operationClosesTab(operation, state, browserTabId) {
  if (operation.payload.closingTabIds?.includes(browserTabId)) return true;
  const closesRecords = operation.type === "switch-group"
    || operation.type === "delete-group"
    || operation.payload.shouldClose;
  if (!closesRecords) return false;
  const records = [...(operation.payload.closeRecords ?? []), operation.payload.closeRecord]
    .filter(Boolean);
  return records.some((record) => record.browserTabId === browserTabId
    || state.tabs.some((tab) => tab.id === record.id && tab.browserTabId === browserTabId));
}
