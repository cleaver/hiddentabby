const PERMISSION = { permissions: ["nativeMessaging"] };

const toggle = document.getElementById("agent-access-toggle");
const status = document.getElementById("agent-access-status");

function render(granted) {
  toggle.disabled = false;
  toggle.textContent = granted ? "Revoke access" : "Allow access";
  toggle.setAttribute("aria-pressed", String(granted));
  toggle.classList.toggle("danger", granted);
  toggle.classList.toggle("secondary", !granted);
  status.textContent = granted
    ? "Allowed. HiddenTabby connects to the local helper when it is installed."
    : "Not allowed.";
}

async function refresh() {
  render(await chrome.permissions.contains(PERMISSION));
}

toggle.addEventListener("click", async () => {
  const granted = toggle.getAttribute("aria-pressed") === "true";
  try {
    if (granted) {
      await chrome.permissions.remove(PERMISSION);
    } else {
      await chrome.permissions.request(PERMISSION);
    }
  } catch (error) {
    status.dataset.kind = "error";
    status.textContent = `Could not change access: ${error.message}`;
    return;
  }
  delete status.dataset.kind;
  await refresh();
});

chrome.permissions.onAdded?.addListener(() => void refresh());
chrome.permissions.onRemoved?.addListener(() => void refresh());
void refresh();
