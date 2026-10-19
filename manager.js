const groupsElement = document.querySelector("#groups");
const statusElement = document.querySelector("#status");
const createForm = document.querySelector("#create-form");
const nameInput = document.querySelector("#group-name");
const braveContainerCard = document.querySelector("#brave-container-card");
const braveContainersHelp = document.querySelector("#brave-containers-help");
const openBraveContainerSettings = document.querySelector(
  "#open-brave-container-settings",
);
const collapsedGroupIds = new Set();
const tabDragDataType = "application/x-hiddentabby-tab-id";
let draggedTabId = null;

const colors = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
];
const colorValues = {
  grey: "#929aa5",
  blue: "#61a9ff",
  red: "#ff6f73",
  yellow: "#f1c75b",
  green: "#54c58c",
  pink: "#f27bb7",
  purple: "#b397ff",
  cyan: "#51d4dc",
  orange: "#ffa45d",
};
let stateLoadGeneration = 0;

async function command(type, values = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...values });
  if (!response?.ok)
    throw new Error(
      response?.error ?? "HiddenTabby could not complete that action.",
    );
  return response.value;
}

async function configureBraveContainerControls() {
  let isBrave = false;
  try {
    isBrave = Boolean(await navigator.brave?.isBrave?.());
  } catch {
    isBrave = false;
  }
  braveContainerCard.hidden = !isBrave;
  braveContainersHelp.hidden = !isBrave;
}

function setStatus(message, kind = "info") {
  statusElement.textContent = message;
  statusElement.dataset.kind = kind;
}

function makeButton(label, className, action, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button ${className}`.trim();
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", action);
  return button;
}

function closeMovePanel(controlPanel, restoreFocus = false) {
  const controls = controlPanel.parentElement;
  const moveToggle = controls?.querySelector(".tab-move-toggle");
  controlPanel.hidden = true;
  controls?.closest(".tab-row")?.classList.remove("tab-row-move-open");
  moveToggle?.setAttribute("aria-expanded", "false");
  if (restoreFocus) moveToggle?.focus();
}

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Node)) return;
  for (const controlPanel of document.querySelectorAll(
    ".tab-move-panel:not([hidden])",
  )) {
    if (controlPanel.parentElement?.contains(event.target)) continue;
    closeMovePanel(controlPanel);
  }
});

function getGroupCard(target) {
  return target instanceof Element ? target.closest(".group-card[data-group-id]") : null;
}

function clearDropTargets() {
  document.querySelectorAll(".group-card-drop-target").forEach((card) => {
    card.classList.remove("group-card-drop-target");
  });
}

groupsElement.addEventListener("dragstart", (event) => {
  const row = event.target instanceof Element ? event.target.closest(".tab-row") : null;
  if (!row || !event.dataTransfer || !row.dataset.tabId) return;
  draggedTabId = row.dataset.tabId;
  event.dataTransfer.setData(tabDragDataType, draggedTabId);
  event.dataTransfer.effectAllowed = "move";
  row.classList.add("tab-row-dragging");
  const title = row.querySelector(".tab-title")?.textContent || "Tab";
  setStatus(`Dragging ${title}. Drop it on a group.`);
});

groupsElement.addEventListener("dragover", (event) => {
  const groupCard = getGroupCard(event.target);
  if (!draggedTabId || !groupCard) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  clearDropTargets();
  groupCard.classList.add("group-card-drop-target");
});

groupsElement.addEventListener("dragleave", (event) => {
  const groupCard = getGroupCard(event.target);
  if (!groupCard) return;
  if (event.relatedTarget instanceof Node && groupCard.contains(event.relatedTarget)) return;
  groupCard.classList.remove("group-card-drop-target");
});

groupsElement.addEventListener("drop", (event) => {
  const groupCard = getGroupCard(event.target);
  const tabId = event.dataTransfer?.getData(tabDragDataType) || draggedTabId;
  if (!groupCard || !tabId || !groupCard.dataset.groupId) return;
  event.preventDefault();
  clearDropTargets();

  const sourceRow = [...document.querySelectorAll(".tab-row")]
    .find((row) => row.dataset.tabId === tabId);
  const sourceGroupId = sourceRow?.closest(".group-card")?.dataset.groupId;
  const destinationGroupId = groupCard.dataset.groupId;
  if (sourceGroupId === destinationGroupId) {
    setStatus("That tab is already in this group.");
    return;
  }

  const destinationName = groupCard.dataset.groupName || "the selected group";
  void refreshAfter(
    () => command("tab:move", { tabId, groupId: destinationGroupId }),
    `Moved tab to ${destinationName}.`,
  );
});

groupsElement.addEventListener("dragend", (event) => {
  const row = event.target instanceof Element ? event.target.closest(".tab-row") : null;
  row?.classList.remove("tab-row-dragging");
  clearDropTargets();
  draggedTabId = null;
});

function makeColorPalette(selectedColor, label, groupId) {
  const palette = document.createElement("fieldset");
  palette.className = "color-palette";
  const legend = document.createElement("legend");
  legend.className = "sr-only";
  legend.textContent = `Color for ${label}`;
  palette.append(legend);

  for (const color of colors) {
    const choice = document.createElement("label");
    choice.className = "color-choice";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = `group-color-${groupId}`;
    radio.value = color;
    radio.setAttribute(
      "aria-label",
      `${color[0].toUpperCase()}${color.slice(1)}`,
    );
    radio.checked = color === selectedColor;
    const swatch = document.createElement("span");
    swatch.className = "color-swatch";
    swatch.style.setProperty("--swatch-color", colorValues[color]);
    swatch.setAttribute("aria-hidden", "true");
    choice.append(radio, swatch);
    palette.append(choice);
  }
  return palette;
}

async function refreshAfter(action, successMessage) {
  try {
    const result = await action();
    if (result?.failures?.length) setStatus(result.failures.join(" "), "error");
    else if (successMessage) setStatus(successMessage, "success");
    await loadState();
    if (result?.failures?.length) setStatus(result.failures.join(" "), "error");
    else if (successMessage) setStatus(successMessage, "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function makeGroupCard(group, index, state, windowLabels, managerTabContext) {
  const groupTabs = state.tabs.filter((tab) => tab.groupId === group.id);
  const openCount = groupTabs.filter((tab) => tab.status === "open").length;
  const savedCount = groupTabs.length - openCount;
  const card = document.createElement("article");
  card.className = "group-card";
  card.dataset.groupId = group.id;
  card.dataset.groupName = group.name;
  const disclosure = document.createElement("details");
  disclosure.className = "group-disclosure";
  disclosure.dataset.groupId = group.id;
  disclosure.open = !collapsedGroupIds.has(group.id);
  disclosure.addEventListener("toggle", () => {
    if (disclosure.open) collapsedGroupIds.delete(group.id);
    else collapsedGroupIds.add(group.id);
  });

  const titleRow = document.createElement("div");
  titleRow.className = "group-title-row";
  const dot = document.createElement("span");
  dot.className = "color-dot";
  dot.style.setProperty(
    "--group-color",
    colorValues[group.color] ?? colorValues.grey,
  );
  dot.setAttribute("aria-hidden", "true");
  const title = document.createElement("h3");
  title.className = "group-title";
  title.textContent = group.name;
  titleRow.append(dot, title);
  if (state.activeGroupId === group.id) {
    const badge = document.createElement("span");
    badge.className = "active-badge";
    badge.textContent = "Current";
    titleRow.append(badge);
  }
  const count = document.createElement("span");
  count.className = "group-count";
  count.textContent = savedCount
    ? `${openCount} open · ${savedCount} saved`
    : `${openCount} tab${openCount === 1 ? "" : "s"}`;
  titleRow.append(count);

  const summary = document.createElement("summary");
  summary.className = "group-summary";
  summary.append(titleRow);

  const renameForm = document.createElement("form");
  renameForm.className = "group-controls";
  const renameInput = document.createElement("input");
  renameInput.type = "text";
  renameInput.maxLength = 40;
  renameInput.value = group.name;
  renameInput.setAttribute("aria-label", `Rename ${group.name}`);
  const isDefaultGroup = group.name.toLocaleLowerCase() === "default";
  if (isDefaultGroup) {
    renameInput.disabled = true;
    renameInput.title = "Keep one group named Default at all times.";
  }
  const colorPalette = makeColorPalette(group.color, group.name, group.id);
  const renameButton = document.createElement("button");
  renameButton.type = "submit";
  renameButton.className = "button secondary";
  renameButton.textContent = "Save";
  renameButton.disabled = isDefaultGroup;
  renameForm.append(renameInput, renameButton, colorPalette);
  renameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = renameInput.value.trim();
    if (!name) {
      setStatus("Enter a group name.", "error");
      renameInput.focus();
      return;
    }
    void refreshAfter(
      () => command("group:rename", { groupId: group.id, name }),
      `Renamed group to ${name}.`,
    );
  });
  colorPalette.addEventListener("change", (event) => {
    if (!(event.target instanceof HTMLInputElement) || !event.target.checked)
      return;
    void refreshAfter(
      () =>
        command("group:recolor", {
          groupId: group.id,
          color: event.target.value,
        }),
      `Updated ${group.name}'s color.`,
    );
  });

  const actions = document.createElement("div");
  actions.className = "group-actions";
  const closedCount = groupTabs.filter((tab) => tab.status === "closed").length;
  const isActive = state.activeGroupId === group.id;
  actions.append(
    makeButton(
      isActive
        ? closedCount
          ? "Restore saved tabs"
          : "Current group"
        : "Switch to group",
      "secondary",
      () =>
        void refreshAfter(
          () => command("group:switch", { groupId: group.id }),
          `Showing ${group.name}.`,
        ),
      isActive && closedCount === 0,
    ),
  );
  const moveUp = makeButton(
    "Move up",
    "secondary",
    () => void reorderAt(index, -1, state),
    index === 0,
  );
  moveUp.setAttribute("aria-label", `Move ${group.name} up`);
  const moveDown = makeButton(
    "Move down",
    "secondary",
    () => void reorderAt(index, 1, state),
    index === state.groups.length - 1,
  );
  moveDown.setAttribute("aria-label", `Move ${group.name} down`);
  actions.append(moveUp, moveDown);
  const deleteButton = makeButton("Delete", "danger", async () => {
    const defaultNote =
      group.name.toLocaleLowerCase() === "default"
        ? " A fresh empty Default group will replace it."
        : state.activeGroupId === group.id
          ? " Default will become active."
          : "";
    const warning = `Delete “${group.name}”? This closes ${openCount} open tab${openCount === 1 ? "" : "s"} and forgets ${groupTabs.length} saved/live tab${groupTabs.length === 1 ? "" : "s"} across all windows. Nothing is moved to another group and browser history is not deleted.${defaultNote}`;
    if (!window.confirm(warning)) return;
    await refreshAfter(
      () => command("group:delete", { groupId: group.id }),
      `Deleted ${group.name}.`,
    );
  });
  deleteButton.setAttribute("aria-label", `Delete ${group.name} group`);
  actions.append(deleteButton);

  const tabList = document.createElement("div");
  tabList.className = "tab-list";
  const orderedTabs = groupTabs.sort((a, b) =>
    a.browserWindowId - b.browserWindowId || a.index - b.index,
  );
  if (orderedTabs.length) {
    tabList.append(...orderedTabs.map((tab) => makeTabRow(tab, state, windowLabels, managerTabContext)));
  } else {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No tabs in this group yet.";
    tabList.append(empty);
  }

  const content = document.createElement("div");
  content.className = "group-content";
  content.append(renameForm, actions, tabList);
  disclosure.append(summary, content);
  card.append(disclosure);
  return card;
}

async function reorderAt(index, offset, state) {
  const ordered = [...state.groups]
    .sort((a, b) => a.order - b.order)
    .map((group) => group.id);
  const destination = index + offset;
  [ordered[index], ordered[destination]] = [
    ordered[destination],
    ordered[index],
  ];
  await refreshAfter(
    () => command("group:reorder", { orderedIds: ordered }),
    "Group order updated.",
  );
}

function makeTabFavicon(tab) {
  const favicon = document.createElement("span");
  favicon.className = "tab-favicon";
  favicon.setAttribute("aria-hidden", "true");
  if (!tab.faviconUrl) {
    favicon.classList.add("tab-favicon-placeholder");
    return favicon;
  }

  const image = document.createElement("img");
  image.alt = "";
  image.src = tab.faviconUrl;
  image.addEventListener("error", () => {
    favicon.classList.add("tab-favicon-placeholder");
    image.remove();
  }, { once: true });
  favicon.append(image);
  return favicon;
}

function makeTabRow(tab, state, windowLabels, managerTabContext) {
  const row = document.createElement("article");
  row.className = "tab-row";
  row.dataset.tabId = tab.id;
  row.draggable = state.groups.length > 1;
  const copy = document.createElement("div");
  copy.className = "tab-copy";
  const heading = document.createElement("div");
  heading.className = "tab-heading";
  heading.append(makeTabFavicon(tab));
  const title = document.createElement("p");
  title.className = "tab-title";
  title.textContent = tab.title || tab.url || "Untitled tab";
  heading.append(title);
  const url = document.createElement("p");
  url.className = "tab-url";
  url.textContent = tab.url;
  url.title = tab.url;
  const meta = document.createElement("p");
  meta.className = "tab-meta";
  meta.textContent = windowLabels.get(tab.windowId)
    ?? windowLabels.get(tab.browserWindowId)
    ?? "Window";
  copy.append(heading, url, meta);

  const controls = document.createElement("div");
  controls.className = "tab-actions";
  const controlPanel = document.createElement("div");
  controlPanel.className = "tab-move-panel";
  controlPanel.id = `tab-move-controls-${tab.id}`;
  controlPanel.hidden = true;
  const select = document.createElement("select");
  select.setAttribute(
    "aria-label",
    `Move ${tab.title || tab.url || "tab"} to group`,
  );
  for (const candidate of [...state.groups].sort((a, b) => a.order - b.order)) {
    const option = document.createElement("option");
    option.value = candidate.id;
    option.textContent = candidate.name;
    option.selected = candidate.id === tab.groupId;
    select.append(option);
  }
  const moveButton = makeButton(
    "Move",
    "secondary",
    () => {
      if (select.value === tab.groupId) return;
      const identifier = tab.status === "open" ? tab.browserTabId : tab.id;
      void refreshAfter(
        () => command("tab:move", { tabId: identifier, groupId: select.value }),
        "Tab moved.",
      );
    },
    state.groups.length < 2,
  );
  const cancelButton = makeButton(
    "Cancel",
    "secondary",
    () => closeMovePanel(controlPanel, true),
  );
  controlPanel.append(select, moveButton, cancelButton);

  const moveToggle = makeButton(
    "",
    "secondary tab-action-icon-button tab-move-toggle",
    () => {
      if (controlPanel.hidden) {
        controlPanel.hidden = false;
        row.classList.add("tab-row-move-open");
        moveToggle.setAttribute("aria-expanded", "true");
        select.focus();
      } else {
        closeMovePanel(controlPanel);
      }
    },
    state.groups.length < 2,
  );
  moveToggle.setAttribute(
    "aria-label",
    `Move ${tab.title || tab.url || "tab"} to another group`,
  );
  moveToggle.setAttribute("aria-controls", controlPanel.id);
  moveToggle.setAttribute("aria-expanded", "false");
  moveToggle.setAttribute("title", "Move to another group");
  moveToggle.dataset.tooltip = "Move to another group";
  const moveIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  moveIcon.setAttribute("class", "tab-move-icon");
  moveIcon.setAttribute("viewBox", "0 0 24 24");
  moveIcon.setAttribute("aria-hidden", "true");
  moveIcon.setAttribute("focusable", "false");
  const folderPath = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "path",
  );
  folderPath.setAttribute(
    "d",
    "M4 6.5A1.5 1.5 0 0 1 5.5 5h4l2 2h7A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z",
  );
  const arrowPath = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "path",
  );
  arrowPath.setAttribute("d", "M8 12h8m-3-3 3 3-3 3");
  moveIcon.append(folderPath, arrowPath);
  moveToggle.append(moveIcon);

  const isProtectedManagerTab = managerTabContext?.isOnlyTab === true
    && tab.status === "open"
    && tab.browserTabId === managerTabContext.tabId;
  const deleteButton = makeButton(
    "",
    "danger tab-action-icon-button tab-delete-button",
    () => {
      const identifier = tab.status === "open" ? tab.browserTabId : tab.id;
      void refreshAfter(
        () => command("tab:delete", { tabId: identifier }),
        "Tab removed from group.",
      );
    },
    isProtectedManagerTab,
  );
  deleteButton.setAttribute(
    "aria-label",
    isProtectedManagerTab
      ? "Cannot delete the Workspace Manager because it is the only tab in this window"
      : `Delete ${tab.title || tab.url || "tab"} from group`,
  );
  const deleteTooltip = isProtectedManagerTab
    ? "The only Workspace Manager tab in this window cannot be deleted"
    : "Delete tab from group";
  deleteButton.setAttribute("title", deleteTooltip);
  deleteButton.dataset.tooltip = deleteTooltip;
  const deleteIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  deleteIcon.setAttribute("class", "tab-delete-icon");
  deleteIcon.setAttribute("viewBox", "0 0 24 24");
  deleteIcon.setAttribute("aria-hidden", "true");
  deleteIcon.setAttribute("focusable", "false");
  const deletePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  deletePath.setAttribute("d", "M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3");
  deleteIcon.append(deletePath);
  deleteButton.append(deleteIcon);

  controls.append(moveToggle, deleteButton, controlPanel);
  row.append(copy, controls);
  return row;
}

async function loadState({ preserveStatus = false } = {}) {
  const generation = ++stateLoadGeneration;
  try {
    const [state, managerTabContext] = await Promise.all([
      command("state:get"),
      getManagerTabContext(),
    ]);
    if (generation !== stateLoadGeneration) return;
    const orderedGroups = [...state.groups].sort((a, b) => a.order - b.order);
    const windowLabels = new Map();
    state.windows.forEach((window, index) => {
      const label = `Window #${index + 1}`;
      windowLabels.set(window.id, label);
      windowLabels.set(window.browserWindowId, label);
    });
    groupsElement.replaceChildren(
      ...orderedGroups.map((group, index) =>
        makeGroupCard(group, index, state, windowLabels, managerTabContext),
      ),
    );
    if (!preserveStatus) {
      setStatus(
        "Tab titles and URLs stay in this browser profile; HiddenTabby does not upload them to an external service.",
      );
    }
  } catch (error) {
    if (generation !== stateLoadGeneration) return;
    const groupsEmpty = document.createElement("p");
    groupsEmpty.className = "empty-state";
    groupsEmpty.textContent =
      "Groups could not be loaded. Reload the extension and try again.";
    groupsElement.replaceChildren(groupsEmpty);
    setStatus(error.message, "error");
  }
}

async function getManagerTabContext() {
  try {
    const current = await chrome.tabs.getCurrent();
    const managerUrl = chrome.runtime.getURL("manager.html");
    if (!Number.isInteger(current?.id)
      || !Number.isInteger(current.windowId)
      || !current.url?.startsWith(managerUrl)) return null;
    const tabs = await chrome.tabs.query({ windowId: current.windowId });
    return { tabId: current.id, isOnlyTab: tabs.length === 1 };
  } catch {
    return null;
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
  if (!name) {
    setStatus("Enter a group name.", "error");
    nameInput.focus();
    return;
  }
  await refreshAfter(
    () => command("group:create", { details: { name } }),
    `Created ${name}; the active group did not change.`,
  );
  nameInput.value = "";
});

openBraveContainerSettings.addEventListener("click", async (event) => {
  event.preventDefault();
  try {
    await command("brave:containers:open-settings");
    setStatus("Opened Brave Container settings.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

void configureBraveContainerControls();
void loadState();
