export function createChromeBrowserApi(chromeApi = globalThis.chrome) {
  if (!chromeApi?.tabs || !chromeApi?.windows || !chromeApi?.tabGroups) {
    throw new Error("Chromium tab, window, and tab-group APIs are required.");
  }

  const placeholderUrl = chromeApi.runtime.getURL("placeholder.html");
  const makePlaceholderUrl = (logicalWindowId) => {
    if (typeof logicalWindowId !== "string" || !logicalWindowId) return placeholderUrl;
    const url = new URL(placeholderUrl);
    url.searchParams.set("window", logicalWindowId);
    return url.toString();
  };
  const isPlaceholderUrl = (url) => typeof url === "string"
    && (url === placeholderUrl || url.startsWith(`${placeholderUrl}?`));
  const getPlaceholderWindowKey = (url) => {
    if (!isPlaceholderUrl(url)) return null;
    try {
      return new URL(url).searchParams.get("window");
    } catch {
      return null;
    }
  };

  return {
    placeholderUrl,
    isPlaceholderUrl,
    getPlaceholderWindowKey,

    async getNormalWindows() {
      const windows = await chromeApi.windows.getAll({ populate: true, windowTypes: ["normal"] });
      return windows
        .filter((window) => !window.incognito && window.type === "normal")
        .map((window) => ({ ...window, tabs: (window.tabs ?? []).filter((tab) => !tab.incognito) }));
    },

    async getLastFocusedWindow() {
      const window = await chromeApi.windows.getLastFocused({ populate: false });
      if (!window || window.incognito || (window.type && window.type !== "normal")) return null;
      return window;
    },

    async getTab(tabId) {
      return chromeApi.tabs.get(tabId);
    },

    async removeTabs(tabIds) {
      const uniqueIds = [...new Set(tabIds.filter(Number.isInteger))];
      if (!uniqueIds.length) return;
      const requestedIds = new Set(uniqueIds);
      const liveTabs = (await chromeApi.tabs.query({})).filter((tab) => requestedIds.has(tab.id)
        && !tab.incognito && !tab.pinned);
      if (liveTabs.length) await chromeApi.tabs.remove(liveTabs.map((tab) => tab.id));
    },

    async createTab(properties) {
      const createProperties = { ...properties };
      if (!Number.isInteger(createProperties.index) || createProperties.index < 0) {
        delete createProperties.index;
      }
      return chromeApi.tabs.create(createProperties);
    },

    async createWindow(properties = {}) {
      return chromeApi.windows.create(properties);
    },

    async removeWindow(windowId) {
      return chromeApi.windows.remove(windowId);
    },

    async focusWindow(windowId) {
      return chromeApi.windows.update(windowId, { focused: true });
    },

    async createWindowWithPlaceholder(logicalWindowId) {
      const url = makePlaceholderUrl(logicalWindowId);
      const created = await chromeApi.windows.create({ url, focused: false });
      const isPlaceholderTab = (tab) => isPlaceholderUrl(tab.url) || isPlaceholderUrl(tab.pendingUrl);
      let placeholder = created.tabs?.find(isPlaceholderTab);
      if (!placeholder) {
        const currentTabs = await chromeApi.tabs.query({ windowId: created.id });
        placeholder = currentTabs.find(isPlaceholderTab);
      }
      if (!placeholder) placeholder = await chromeApi.tabs.create({ windowId: created.id, url, active: true });
      if (Number.isInteger(placeholder.groupId) && placeholder.groupId >= 0) {
        await chromeApi.tabs.ungroup([placeholder.id]);
      }
      return { windowId: created.id, placeholderTabId: placeholder.id };
    },

    async createPlaceholder(windowId, logicalWindowId) {
      const placeholder = await chromeApi.tabs.create({
        windowId,
        url: makePlaceholderUrl(logicalWindowId),
        active: true,
      });
      if (Number.isInteger(placeholder.groupId) && placeholder.groupId >= 0) {
        await chromeApi.tabs.ungroup([placeholder.id]);
      }
      return placeholder;
    },

    async restoreSession(sessionId) {
      if (!sessionId || !chromeApi.sessions?.restore) return null;
      return chromeApi.sessions.restore(sessionId);
    },

    async getRecentlyClosed(maxResults = 25) {
      if (!chromeApi.sessions?.getRecentlyClosed) return [];
      return chromeApi.sessions.getRecentlyClosed({ maxResults });
    },

    async moveTabToWindow(tabId, windowId, index) {
      const moveProperties = { windowId };
      if (Number.isInteger(index) && index >= 0) moveProperties.index = index;
      return chromeApi.tabs.move(tabId, moveProperties);
    },

    async orderTabs(tabIds, windowId) {
      const requestedIds = [...new Set(tabIds.filter(Number.isInteger))];
      if (!requestedIds.length) return;
      const tabs = (await chromeApi.tabs.query({ windowId }))
        .filter((tab) => !tab.incognito)
        .sort((a, b) => a.index - b.index);
      const orderedIds = requestedIds.filter((id) => tabs.some((tab) => tab.id === id && !tab.pinned));
      const firstUnpinnedIndex = tabs.filter((tab) => tab.pinned).length;
      for (let index = 0; index < orderedIds.length; index += 1) {
        await chromeApi.tabs.move(orderedIds[index], {
          windowId,
          index: firstUnpinnedIndex + index,
        });
      }
    },

    async activateTab(tabId) {
      return chromeApi.tabs.update(tabId, { active: true });
    },

    async findMatchingTab(snapshot, windowId, excludedTabIds = []) {
      const excluded = new Set(excludedTabIds);
      const windows = await this.getNormalWindows();
      const tabs = windows.flatMap((window) => window.tabs ?? [])
        .filter((tab) => tab.windowId === windowId && !tab.incognito && !tab.pinned
          && !excluded.has(tab.id)
          && !this.isPlaceholderUrl(tab.url) && !this.isPlaceholderUrl(tab.pendingUrl)
          && (tab.url ?? tab.pendingUrl ?? "") === snapshot.url
          && (!snapshot.title || !tab.title || tab.title === snapshot.title));
      return tabs.sort((a, b) => Math.abs(a.index - snapshot.index) - Math.abs(b.index - snapshot.index))[0] ?? null;
    },

    async adoptInitialTabs(state) {
      for (const window of state.windows.filter((item) => item.isOpen)) {
        const tabs = await chromeApi.tabs.query({ windowId: window.browserWindowId });
        const normalUnpinned = tabs.filter((tab) => !tab.incognito && !tab.pinned);
        const groupedIds = normalUnpinned.filter((tab) => tab.groupId >= 0).map((tab) => tab.id);
        if (groupedIds.length) await chromeApi.tabs.ungroup(groupedIds);

        for (const group of state.groups) {
          await this.groupManagedTabs(state, group.id, window.browserWindowId);
        }
      }
    },

    async groupManagedTabs(state, groupId, browserWindowId) {
      const group = state.groups.find((candidate) => candidate.id === groupId);
      if (!group) return;
      const managedIds = new Set(state.tabs
        .filter((tab) => tab.groupId === groupId
          && tab.browserWindowId === browserWindowId
          && tab.status === "open")
        .map((tab) => tab.browserTabId));
      const liveTabs = await chromeApi.tabs.query({ windowId: browserWindowId });
      const tabs = liveTabs.filter((tab) => !tab.incognito && !tab.pinned && managedIds.has(tab.id));
      if (!tabs.length) return;
      if (tabs.length === 1) {
        if (tabs[0].groupId >= 0) await chromeApi.tabs.ungroup([tabs[0].id]);
        return;
      }

      const nativeGroupIds = new Set(tabs.filter((tab) => tab.groupId >= 0).map((tab) => tab.groupId));
      const [nativeGroupId] = nativeGroupIds;
      for (const otherGroupId of nativeGroupIds) {
        if (otherGroupId !== nativeGroupId) {
          const ungroupIds = tabs.filter((tab) => tab.groupId === otherGroupId).map((tab) => tab.id);
          await chromeApi.tabs.ungroup(ungroupIds);
        }
      }
      const tabIds = tabs.map((tab) => tab.id);
      const resolvedGroupId = Number.isInteger(nativeGroupId)
        ? await chromeApi.tabs.group({ tabIds, groupId: nativeGroupId })
        : await chromeApi.tabs.group({
          tabIds,
          createProperties: { windowId: browserWindowId },
        });
      await chromeApi.tabGroups.update(resolvedGroupId, { title: group.name, color: group.color });
    },

    async updateNativeGroups(state) {
      for (const window of state.windows.filter((item) => item.isOpen)) {
        for (const group of state.groups) {
          await this.groupManagedTabs(state, group.id, window.browserWindowId);
        }
      }
    },

    async createMoveMenu(state) {
      if (!chromeApi.contextMenus) return;
      await chromeApi.contextMenus.removeAll();
      chromeApi.contextMenus.create({
        id: "hiddentabby-move-root",
        title: "Move tab to group",
        contexts: ["tab"],
      });
      for (const group of state.groups) {
        chromeApi.contextMenus.create({
          id: `hiddentabby-move:${group.id}`,
          parentId: "hiddentabby-move-root",
          title: group.name,
          contexts: ["tab"],
        });
      }
    },
  };
}
