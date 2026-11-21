export const UNLOAD_RESTORED_TABS_STORAGE_KEY = "hiddentabby.unloadRestoredTabs";

// On by default. A stored false means the user opted out and wants restored tabs kept loaded.
export function createUnloadRestoredTabsSetting(storage) {
  return async () => {
    const stored = await storage.get(UNLOAD_RESTORED_TABS_STORAGE_KEY).catch(() => ({}));
    return stored?.[UNLOAD_RESTORED_TABS_STORAGE_KEY] !== false;
  };
}
