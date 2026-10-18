const groupsElement = document.querySelector("#groups");
const statusElement = document.querySelector("#status");
const windowCountElement = document.querySelector("#window-count");
const createForm = document.querySelector("#create-form");
const nameInput = document.querySelector("#group-name");
const sidePanelButton = document.querySelector("#open-side-panel");
let stateLoadGeneration = 0;

async function sendCommand(type, values = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...values });
  if (!response?.ok) throw new Error(response?.error ?? "HiddenTabby could not complete that action.");
  return response.value;
}

function setStatus(message, kind = "info") {
  statusElement.textContent = message;
  statusElement.dataset.kind = kind;
}

function makeGroupButton(group, state) {
  const tabs = state.tabs.filter((tab) => tab.groupId === group.id);
  const openCount = tabs.filter((tab) => tab.status === "open").length;
  const savedCount = tabs.length - openCount;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "group-choice";
  button.setAttribute("aria-current", String(state.activeGroupId === group.id));
  button.disabled = state.activeGroupId === group.id && savedCount === 0;

  const nameWrap = document.createElement("span");
  nameWrap.className = "group-name-wrap";
  const dot = document.createElement("span");
  dot.className = "color-dot";
  dot.style.setProperty("--group-color", group.color);
  dot.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.className = "group-name";
  name.textContent = group.name;
  nameWrap.append(dot, name);

  const meta = document.createElement("span");
  meta.className = "group-meta";
  meta.textContent = savedCount ? `${openCount} open · ${savedCount} saved` : `${openCount} tab${openCount === 1 ? "" : "s"}`;
  button.append(nameWrap, meta);
  button.addEventListener("click", async () => {
    setStatus(state.activeGroupId === group.id ? "Restoring saved tabs…" : `Switching to ${group.name}…`);
    try {
      const result = await sendCommand("group:switch", { groupId: group.id });
      await loadState();
      setStatus(result.failures?.length ? result.failures.join(" ") : `Showing ${group.name}.`, result.failures?.length ? "error" : "info");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
  return button;
}

async function loadState({ preserveStatus = false } = {}) {
  const generation = ++stateLoadGeneration;
  try {
    const state = await sendCommand("state:get");
    if (generation !== stateLoadGeneration) return;
    const orderedGroups = [...state.groups].sort((a, b) => a.order - b.order);
    groupsElement.replaceChildren();
    for (const group of orderedGroups) groupsElement.append(makeGroupButton(group, state));
    const openWindows = state.windows.filter((window) => window.isOpen).length;
    windowCountElement.textContent = `${openWindows} window${openWindows === 1 ? "" : "s"}`;
    if (!preserveStatus) {
      setStatus("Switching closes tabs in other groups. Page state may not survive restoration.");
    }
  } catch (error) {
    if (generation !== stateLoadGeneration) return;
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Groups could not be loaded. Reload the extension and try again.";
    groupsElement.replaceChildren(empty);
    setStatus(error.message, "error");
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes["hiddentabby.state"]) {
    void loadState({ preserveStatus: true });
  }
});

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  setStatus("Creating group…");
  try {
    await sendCommand("group:create", { details: { name } });
    nameInput.value = "";
    await loadState();
    setStatus(`Created ${name}; your active group did not change.`);
  } catch (error) {
    setStatus(error.message, "error");
  }
});

document.querySelector("#open-manager").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("manager.html") });
});

if (chrome.sidePanel?.open) {
  sidePanelButton.hidden = false;
  sidePanelButton.addEventListener("click", async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab || !Number.isInteger(tab.windowId)) throw new Error("Open a normal browser window first.");
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
}

void loadState();
