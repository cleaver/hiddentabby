const groupsElement = document.querySelector("#groups");
const tabsElement = document.querySelector("#tabs");
const statusElement = document.querySelector("#status");
const tabSummaryElement = document.querySelector("#tab-summary");
const createForm = document.querySelector("#create-form");
const nameInput = document.querySelector("#group-name");
const braveContainerCard = document.querySelector("#brave-container-card");
const braveContainersHelp = document.querySelector("#brave-containers-help");
const openBraveContainerSettings = document.querySelector("#open-brave-container-settings");

const colors = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
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

async function command(type, values = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...values });
  if (!response?.ok) throw new Error(response?.error ?? "HiddenTabby could not complete that action.");
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
    radio.setAttribute("aria-label", `${color[0].toUpperCase()}${color.slice(1)}`);
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

function makeGroupCard(group, index, state) {
  const groupTabs = state.tabs.filter((tab) => tab.groupId === group.id);
  const openCount = groupTabs.filter((tab) => tab.status === "open").length;
  const savedCount = groupTabs.length - openCount;
  const card = document.createElement("article");
  card.className = "group-card";

  const titleRow = document.createElement("div");
  titleRow.className = "group-title-row";
  const dot = document.createElement("span");
  dot.className = "color-dot";
  dot.style.setProperty("--group-color", colorValues[group.color] ?? colorValues.grey);
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
  count.textContent = savedCount ? `${openCount} open · ${savedCount} saved` : `${openCount} tab${openCount === 1 ? "" : "s"}`;
  titleRow.append(count);

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
    void refreshAfter(() => command("group:rename", { groupId: group.id, name }), `Renamed group to ${name}.`);
  });
  colorPalette.addEventListener("change", (event) => {
    if (!(event.target instanceof HTMLInputElement) || !event.target.checked) return;
    void refreshAfter(() => command("group:recolor", { groupId: group.id, color: event.target.value }), `Updated ${group.name}'s color.`);
  });

  const actions = document.createElement("div");
  actions.className = "group-actions";
  const closedCount = groupTabs.filter((tab) => tab.status === "closed").length;
  const isActive = state.activeGroupId === group.id;
  actions.append(makeButton(
    isActive ? (closedCount ? "Restore saved tabs" : "Current group") : "Switch to group",
    "secondary",
    () => void refreshAfter(() => command("group:switch", { groupId: group.id }), `Showing ${group.name}.`),
    isActive && closedCount === 0,
  ));
  const moveUp = makeButton("Move up", "secondary", () => void reorderAt(index, -1, state), index === 0);
  moveUp.setAttribute("aria-label", `Move ${group.name} up`);
  const moveDown = makeButton("Move down", "secondary", () => void reorderAt(index, 1, state), index === state.groups.length - 1);
  moveDown.setAttribute("aria-label", `Move ${group.name} down`);
  actions.append(moveUp, moveDown);
  const deleteButton = makeButton("Delete", "danger", async () => {
    const defaultNote = group.name.toLocaleLowerCase() === "default"
      ? " A fresh empty Default group will replace it."
      : state.activeGroupId === group.id
        ? " Default will become active."
        : "";
    const warning = `Delete “${group.name}”? This closes ${openCount} open tab${openCount === 1 ? "" : "s"} and forgets ${groupTabs.length} saved/live tab${groupTabs.length === 1 ? "" : "s"} across all windows. Nothing is moved to another group, and browser history is not deleted.${defaultNote}`;
    if (!window.confirm(warning)) return;
    await refreshAfter(() => command("group:delete", { groupId: group.id }), `Deleted ${group.name}.`);
  });
  deleteButton.setAttribute("aria-label", `Delete ${group.name} group`);
  actions.append(deleteButton);

  card.append(titleRow, renameForm, actions);
  return card;
}

async function reorderAt(index, offset, state) {
  const ordered = [...state.groups].sort((a, b) => a.order - b.order).map((group) => group.id);
  const destination = index + offset;
  [ordered[index], ordered[destination]] = [ordered[destination], ordered[index]];
  await refreshAfter(() => command("group:reorder", { orderedIds: ordered }), "Group order updated.");
}

function makeTabRow(tab, state) {
  const row = document.createElement("article");
  row.className = "tab-row";
  const copy = document.createElement("div");
  copy.className = "tab-copy";
  const title = document.createElement("p");
  title.className = "tab-title";
  title.textContent = tab.title || tab.url || "Untitled tab";
  const url = document.createElement("p");
  url.className = "tab-url";
  url.textContent = tab.url;
  const group = state.groups.find((candidate) => candidate.id === tab.groupId);
  const meta = document.createElement("p");
  meta.className = "tab-meta";
  meta.textContent = `${group?.name ?? "Unknown group"} · ${tab.status === "open" ? "Open" : "Saved for restoration"} · window ${tab.browserWindowId}`;
  copy.append(title, url, meta);

  const controls = document.createElement("div");
  controls.className = "tab-move";
  const select = document.createElement("select");
  select.setAttribute("aria-label", `Move ${tab.title || tab.url || "tab"} to group`);
  for (const candidate of [...state.groups].sort((a, b) => a.order - b.order)) {
    const option = document.createElement("option");
    option.value = candidate.id;
    option.textContent = candidate.name;
    option.selected = candidate.id === tab.groupId;
    select.append(option);
  }
  const moveButton = makeButton("Move", "secondary", () => {
    if (select.value === tab.groupId) return;
    const identifier = tab.status === "open" ? tab.browserTabId : tab.id;
    void refreshAfter(() => command("tab:move", { tabId: identifier, groupId: select.value }), "Tab moved.");
  }, state.groups.length < 2);
  controls.append(select, moveButton);
  row.append(copy, controls);
  return row;
}

async function loadState() {
  try {
    const state = await command("state:get");
    const orderedGroups = [...state.groups].sort((a, b) => a.order - b.order);
    groupsElement.replaceChildren(...orderedGroups.map((group, index) => makeGroupCard(group, index, state)));
    const orderedTabs = [...state.tabs].sort((a, b) => {
      const groupA = state.groups.find((group) => group.id === a.groupId)?.order ?? 0;
      const groupB = state.groups.find((group) => group.id === b.groupId)?.order ?? 0;
      return groupA - groupB || a.browserWindowId - b.browserWindowId || a.index - b.index;
    });
    tabsElement.replaceChildren(...orderedTabs.map((tab) => makeTabRow(tab, state)));
    if (!orderedTabs.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No saved tabs yet. New tabs join the current group automatically.";
      tabsElement.append(empty);
    }
    const savedCount = orderedTabs.filter((tab) => tab.status === "closed").length;
    const openCount = orderedTabs.length - savedCount;
    tabSummaryElement.textContent = `${openCount} open · ${savedCount} saved`;
  setStatus("Tab titles and URLs stay in this browser profile; HiddenTabby does not upload them to an external service.");
  } catch (error) {
    const groupsEmpty = document.createElement("p");
    groupsEmpty.className = "empty-state";
    groupsEmpty.textContent = "Groups could not be loaded. Reload the extension and try again.";
    groupsElement.replaceChildren(groupsEmpty);
    tabsElement.replaceChildren();
    setStatus(error.message, "error");
  }
}

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (!name) {
    setStatus("Enter a group name.", "error");
    nameInput.focus();
    return;
  }
  await refreshAfter(() => command("group:create", { details: { name } }), `Created ${name}; the active group did not change.`);
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
