export const UNLOAD_RESTORED_TABS_STORAGE_KEY = "hiddentabby.unloadRestoredTabs";

// Off by default: unloading restored background tabs is an opt-in memory saving.
export function createUnloadRestoredTabsSetting(storage) {
  return async () => {
    const stored = await storage.get(UNLOAD_RESTORED_TABS_STORAGE_KEY).catch(() => ({}));
    return stored?.[UNLOAD_RESTORED_TABS_STORAGE_KEY] === true;
  };
}
