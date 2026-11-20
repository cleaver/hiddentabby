import { UNLOAD_RESTORED_TABS_STORAGE_KEY } from "./src/settings.js";

const unloadRestoredTabsInput = document.querySelector("#unload-restored-tabs");
const settingStatus = document.querySelector("#setting-status");

function setStatus(message, kind = "") {
  settingStatus.textContent = message;
  settingStatus.dataset.kind = kind;
}

async function loadSetting() {
  try {
    const stored = await chrome.storage.local.get(UNLOAD_RESTORED_TABS_STORAGE_KEY);
    unloadRestoredTabsInput.checked = stored[UNLOAD_RESTORED_TABS_STORAGE_KEY] === true;
    unloadRestoredTabsInput.disabled = false;
  } catch {
    setStatus("Could not load this setting.", "error");
  }
}

unloadRestoredTabsInput.addEventListener("change", async () => {
  const nextValue = unloadRestoredTabsInput.checked;
  unloadRestoredTabsInput.disabled = true;
  setStatus("Saving…");

  try {
    await chrome.storage.local.set({ [UNLOAD_RESTORED_TABS_STORAGE_KEY]: nextValue });
    setStatus("Setting saved.");
  } catch {
    unloadRestoredTabsInput.checked = !nextValue;
    setStatus("Could not save this setting.", "error");
  } finally {
    unloadRestoredTabsInput.disabled = false;
  }
});

void loadSetting();
