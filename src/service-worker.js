import { createChromeBrowserApi } from "./chrome-browser.js";
import {
  PIN_ONBOARDING_STORAGE_KEY,
  reconcilePinOnboardingPreference,
} from "./pin-onboarding-state.js";
import { createChromeStorageAdapter, StateStore } from "./state-store.js";
import { createInitialStateFactory, WorkspaceController } from "./workspace-controller.js";

export function registerServiceWorker(chromeApi, controller) {
  let pinPreferenceUpdate = Promise.resolve();
  const run = (label, operation) => {
    Promise.resolve(operation).catch((error) => {
      console.error(`HiddenTabby ${label} failed:`, error);
    });
  };

  chromeApi.runtime.onInstalled.addListener(() => run("installation", controller.initialize()));
  chromeApi.runtime.onStartup.addListener(() => run("startup", controller.initialize()));
  chromeApi.tabs.onCreated.addListener((tab) => run("tab creation", controller.onTabCreated(tab)));
  chromeApi.tabs.onActivated.addListener((activeInfo) => run("tab activation", controller.onTabActivated(activeInfo)));
  chromeApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    run("tab update", controller.onTabUpdated(tabId, changeInfo, tab));
  });
  chromeApi.tabs.onRemoved.addListener((tabId, removeInfo) => {
    run("tab removal", controller.onTabRemoved(tabId, removeInfo));
  });
  chromeApi.windows.onRemoved.addListener((windowId) => run("window removal", controller.onWindowRemoved(windowId)));
  chromeApi.tabs.onAttached.addListener((tabId, attachInfo) => {
    run("tab attachment", controller.onTabAttached(tabId, attachInfo));
  });
  chromeApi.tabs.onMoved.addListener((tabId, moveInfo) => {
    run("tab reorder", controller.onTabMoved(tabId, moveInfo));
  });
  chromeApi.contextMenus.onClicked.addListener((info, tab) => {
    const prefix = "hiddentabby-move:";
    if (typeof info.menuItemId !== "string" || !info.menuItemId.startsWith(prefix)
      || !Number.isInteger(tab?.id)) return;
    const groupId = info.menuItemId.slice(prefix.length);
    run("tab move", controller.moveTab(tab.id, groupId));
  });
  chromeApi.action?.onUserSettingsChanged?.addListener((userSettings) => {
    if (typeof userSettings?.isOnToolbar !== "boolean" || !chromeApi.storage?.local) return;
    pinPreferenceUpdate = pinPreferenceUpdate.catch(() => {}).then(async () => {
      const stored = await chromeApi.storage.local.get(PIN_ONBOARDING_STORAGE_KEY);
      const current = stored[PIN_ONBOARDING_STORAGE_KEY];
      const next = reconcilePinOnboardingPreference(current, userSettings.isOnToolbar);
      if (current?.dismissed !== next.dismissed || current?.isOnToolbar !== next.isOnToolbar) {
        await chromeApi.storage.local.set({ [PIN_ONBOARDING_STORAGE_KEY]: next });
      }
    }).catch((error) => {
      console.error("HiddenTabby pin onboarding update failed:", error);
    });
    return pinPreferenceUpdate;
  });
  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object" || typeof message.type !== "string") return false;
    const isFullPageManagerSender = typeof sender?.url === "string"
      && sender.tab?.url === sender.url
      && /^chrome-extension:\/\/[^/]+\/manager\.html(?:[?#]|$)/.test(sender.url);
    const commands = {
      "state:get": () => controller.getState(),
      "group:create": () => controller.createGroup(message.details),
      "group:rename": () => controller.renameGroup(message.groupId, message.name),
      "group:recolor": () => controller.recolorGroup(message.groupId, message.color),
      "group:reorder": () => controller.reorderGroups(message.orderedIds),
      "group:delete": () => controller.deleteGroup(message.groupId),
      "group:switch": () => controller.switchGroup(message.groupId),
      "tab:move": () => controller.moveTab(message.tabId, message.groupId),
      "tab:delete": () => isFullPageManagerSender
        ? controller.deleteTab(message.tabId, { managerTabId: sender.tab.id })
        : controller.deleteTab(message.tabId),
    };
    const command = commands[message.type];
    if (!command) return false;
    Promise.resolve().then(command).then(
      (value) => sendResponse({ ok: true, value }),
      (error) => sendResponse({ ok: false, error: error.message }),
    );
    return true;
  });
}

if (globalThis.chrome?.runtime?.onInstalled) {
  const browser = createChromeBrowserApi(chrome);
  const store = new StateStore(createChromeStorageAdapter(chrome.storage.local), {
    createInitialState: createInitialStateFactory(browser),
  });
  registerServiceWorker(chrome, new WorkspaceController({ store, browser }));
}
