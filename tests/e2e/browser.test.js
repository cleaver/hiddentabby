import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const archive = join(root, "dist", "HiddenTabby.zip");
const browserPath = process.env.BROWSER_BIN || "/usr/bin/chromium";
const browserStartupTimeout = 60_000;
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

class DevToolsClient {
  constructor(webSocket) {
    this.webSocket = webSocket;
    this.nextId = 0;
    this.pending = new Map();
    webSocket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const resolvePending = this.pending.get(message.id);
      if (resolvePending) {
        this.pending.delete(message.id);
        resolvePending(message);
      }
    });
  }

  static async connect(url) {
    const webSocket = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      webSocket.addEventListener("open", resolveOpen, { once: true });
      webSocket.addEventListener("error", rejectOpen, { once: true });
    });
    return new DevToolsClient(webSocket);
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    this.webSocket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveMessage, rejectMessage) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectMessage(new Error("DevTools command timed out: " + method));
      }, 10000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) rejectMessage(new Error(message.error.message));
        else resolveMessage(message.result);
      });
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      const details = response.exceptionDetails.exception?.description
        || response.exceptionDetails.text
        || "unknown page error";
      throw new Error("Browser page evaluation failed: " + details);
    }
    return response.result?.value;
  }

  close() {
    this.webSocket.close();
  }
}

async function waitFor(readValue, predicate, label, timeout = 15000) {
  const startedAt = Date.now();
  let lastValue;
  while (Date.now() - startedAt < timeout) {
    try {
      lastValue = await readValue();
      if (predicate(lastValue)) return lastValue;
    } catch {
      // Extension startup and page navigation can briefly make a read unavailable.
    }
    await wait(100);
  }
  throw new Error(label + " timed out. Last value: " + JSON.stringify(lastValue));
}

async function browserTargets(endpoint) {
  return (await (await fetch(endpoint + "/json/list")).json());
}

async function findExtensionId(profileDirectory, endpoint) {
  return waitFor(async () => {
    const worker = (await browserTargets(endpoint))
      .find((target) => target.type === "service_worker"
        && target.url.includes("/src/service-worker.js"));
    const workerId = worker?.url.match(/chrome-extension:\/\/([^/]+)/)?.[1];
    if (workerId) return workerId;

    try {
      const preferences = JSON.parse(await readFile(join(profileDirectory, "Default", "Preferences"), "utf8"));
      const entries = Object.entries(preferences.extensions?.settings ?? {});
      return entries.find(([, details]) => details.manifest?.name === "HiddenTabby")?.[0] ?? null;
    } catch {
      return null;
    }
  }, Boolean, "extension installation");
}

async function openExtensionPage(browserClient, endpoint, extensionId, pageName) {
  const created = await browserClient.send("Target.createTarget", {
    url: "chrome-extension://" + extensionId + "/" + pageName,
  });
  const target = await waitFor(async () => (await browserTargets(endpoint))
    .find((candidate) => candidate.id === created.targetId), Boolean, pageName + " page");
  const client = await DevToolsClient.connect(target.webSocketDebuggerUrl);
  await waitFor(() => client.evaluate("document.readyState"), (value) => value === "complete", pageName + " load");
  return { client, target };
}

async function readState(client) {
  const response = await client.evaluate("chrome.runtime.sendMessage({type:'state:get'})");
  if (!response?.ok) throw new Error(response?.error ?? "Could not read HiddenTabby state.");
  return response.value;
}

async function clickGroup(client, name) {
  await client.evaluate("(() => { const button = [...document.querySelectorAll('.group-choice')].find((item) => item.querySelector('.group-name')?.textContent === "
    + JSON.stringify(name)
    + "); if (!button) throw new Error('Group button not found: ' + "
    + JSON.stringify(name)
    + "); button.click(); return true; })()");
  const result = await waitFor(
    () => client.evaluate("({text:document.querySelector('#status').textContent,kind:document.querySelector('#status').dataset.kind})"),
    (status) => status.text === "Showing " + name + "." || status.kind === "error",
    "popup switch to " + name,
  );
  assert.notEqual(result.kind, "error", result.text);
}

async function dragTabToGroup(client, { tabUrl, sourceGroupName, destinationGroupName }) {
  return client.evaluate(`(() => {
    const row = [...document.querySelectorAll(".tab-row")]
      .find((item) => item.querySelector(".tab-url")?.textContent === ${JSON.stringify(tabUrl)});
    const source = row?.closest(".group-card");
    const destination = [...document.querySelectorAll(".group-card")]
      .find((card) => card.querySelector(".group-title")?.textContent === ${JSON.stringify(destinationGroupName)});
    if (!row || !source || !destination
      || source.querySelector(".group-title")?.textContent !== ${JSON.stringify(sourceGroupName)}) return null;
    const dataTransfer = new DataTransfer();
    row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
    const dragStarted = {
      draggable: row.draggable,
      recordId: dataTransfer.getData("application/x-hiddentabby-tab-id"),
      rowMarkedDragging: row.classList.contains("tab-row-dragging"),
    };
    const details = destination.querySelector(".group-disclosure");
    const destinationInitiallyCollapsed = !details?.open;
    const dragover = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer });
    destination.dispatchEvent(dragover);
    const dragoverFeedback = {
      prevented: dragover.defaultPrevented,
      targetMarked: destination.classList.contains("group-card-drop-target"),
      destinationInitiallyCollapsed,
    };
    const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer });
    destination.dispatchEvent(drop);
    row.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
    return {
      sourceGroupId: source.dataset.groupId,
      destinationGroupId: destination.dataset.groupId,
      dragStarted,
      dragoverFeedback,
      dropPrevented: drop.defaultPrevented,
      dragStylesCleaned: !row.classList.contains("tab-row-dragging")
        && !destination.classList.contains("group-card-drop-target"),
    };
  })()`);
}

test("packaged HiddenTabby manages real Chromium tabs and windows", { timeout: 120000 }, async (t) => {
  assert.ok(process.platform === "linux", "The installed-browser E2E harness currently targets Linux.");
  assert.ok(process.env.E2E_SKIP_BROWSER !== "1", "Browser E2E was disabled by E2E_SKIP_BROWSER.");

  const temporaryRoot = await mkdtemp(join(tmpdir(), "hiddentabby-e2e-"));
  const extensionDirectory = join(temporaryRoot, "extension");
  const profileDirectory = join(temporaryRoot, "profile");
  const artifactDirectory = join(root, "test-results");
  const browserClients = [];
  let browserProcess;
  let browserExit;
  let fixtureServer;
  let testError;

  try {
    execFileSync("unzip", ["-q", archive, "-d", extensionDirectory], { stdio: "inherit" });
    fixtureServer = createServer((request, response) => {
      if (request.url === "/favicon.svg") {
        response.writeHead(200, {
          "content-type": "image/svg+xml",
          "cache-control": "no-store",
        });
        response.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#54c58c"/></svg>');
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end('<!doctype html><link rel="icon" type="image/svg+xml" href="/favicon.svg"><title>Placeholder Joined</title><main>Local HiddenTabby fixture</main>');
    });
    await new Promise((resolveListen, rejectListen) => {
      fixtureServer.once("error", rejectListen);
      fixtureServer.listen(0, "127.0.0.1", resolveListen);
    });
    fixtureServer.unref();
    const fixtureUrl = "http://127.0.0.1:" + fixtureServer.address().port + "/placeholder";
    browserProcess = spawn(browserPath, [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-crash-reporter",
      "--disable-breakpad",
      "--no-first-run",
      "--no-default-browser-check",
      "--user-data-dir=" + profileDirectory,
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      "--disable-extensions-except=" + extensionDirectory,
      "--load-extension=" + extensionDirectory,
      "about:blank",
    ], { detached: true, stdio: "ignore" });
    browserExit = new Promise((resolveExit) => browserProcess.once("exit", resolveExit));

    const endpoint = await waitFor(async () => {
      try {
        const portLine = (await readFile(join(profileDirectory, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0];
        const port = Number(portLine);
        const version = await (await fetch("http://127.0.0.1:" + port + "/json/version")).json();
        return { port, version };
      } catch {
        if (browserProcess.exitCode !== null) throw new Error("Browser exited before DevTools started.");
        return null;
      }
    }, Boolean, "browser DevTools endpoint", browserStartupTimeout);
    assert.match(endpoint.version.Browser, /Chrom|Brave/i);

    const endpointUrl = "http://127.0.0.1:" + endpoint.port;
    const browserClient = await DevToolsClient.connect(endpoint.version.webSocketDebuggerUrl);
    browserClients.push(browserClient);
    const extensionId = await findExtensionId(profileDirectory, endpointUrl);
    const popup = await openExtensionPage(browserClient, endpointUrl, extensionId, "popup.html");
    browserClients.push(popup.client);

    const manifest = await popup.client.evaluate("chrome.runtime.getManifest()");
    assert.equal(manifest.name, "HiddenTabby");
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.permissions.includes("storage"), true);

    const initialState = await waitFor(
      () => readState(popup.client),
      (state) => state.groups?.some((group) => group.name === "Default"),
      "first-run Default group",
    );
    const persistedState = await popup.client.evaluate("chrome.storage.local.get('hiddentabby.state').then((values)=>values['hiddentabby.state'])");
    const popupCapabilities = await popup.client.evaluate("({sidePanel:Boolean(chrome.sidePanel?.open),sidePanelButtonHidden:document.querySelector('#open-side-panel').hidden})");
    assert.equal(initialState.groups.length, 1);
    let defaultGroup = initialState.groups[0];
    assert.equal(initialState.activeGroupId, defaultGroup.id);
    assert.ok(initialState.tabs.some((tab) => tab.url === "about:blank"), "First-run tabs should join Default.");
    assert.equal(persistedState.activeGroupId, defaultGroup.id, "First-run state should be stored in chrome.storage.local.");
    assert.equal(popupCapabilities.sidePanel, true);
    assert.equal(popupCapabilities.sidePanelButtonHidden, false);

    const sidePanelButtonPoint = await popup.client.evaluate("(() => { const rect=document.querySelector('#open-side-panel').getBoundingClientRect(); return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}; })()");
    await popup.client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: sidePanelButtonPoint.x, y: sidePanelButtonPoint.y,
    });
    await popup.client.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: sidePanelButtonPoint.x, y: sidePanelButtonPoint.y, button: "left", clickCount: 1,
    });
    await popup.client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: sidePanelButtonPoint.x, y: sidePanelButtonPoint.y, button: "left", clickCount: 1,
    });
    const sidePanelTarget = await waitFor(async () => (await browserTargets(endpointUrl))
      .find((target) => target.type === "page" && target.url.endsWith("/manager.html")) ?? null,
    Boolean, "side-panel manager page opened by the popup action");
    const sidePanelClient = await DevToolsClient.connect(sidePanelTarget.webSocketDebuggerUrl);
    browserClients.push(sidePanelClient);
    const sidePanelHeading = await waitFor(
      () => sidePanelClient.evaluate("document.querySelector('h1')?.textContent ?? null"),
      (value) => value === "HiddenTabby",
      "side-panel manager heading",
    );
    assert.equal(sidePanelHeading, "HiddenTabby");
    await sidePanelClient.send("Emulation.setDeviceMetricsOverride", {
      width: 320, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await waitFor(
      () => sidePanelClient.evaluate('Boolean(document.querySelector(".group-card .color-palette"))'),
      Boolean,
      "side-panel color palette rendered",
    );
    const initialColorPalette = await sidePanelClient.evaluate(`(() => {
      const card = [...document.querySelectorAll(".group-card")]
        .find((item) => item.querySelector(".group-title")?.textContent === "Default");
      const palette = card?.querySelector(".color-palette");
      if (!palette) return null;
      const box = palette.getBoundingClientRect();
      const choices = [...palette.querySelectorAll('input[type="radio"]')].map((input) => {
        const target = input.closest("label").getBoundingClientRect();
        return { color: input.value, checked: input.checked, width: target.width, height: target.height };
      });
      return { width: box.width, scrollWidth: palette.scrollWidth, clientWidth: palette.clientWidth, choices };
    })()`);
    assert.ok(initialColorPalette, "The side panel should keep the group color choices visible.");
    assert.equal(initialColorPalette.choices.length, 9);
    assert.ok(initialColorPalette.choices.every((choice) => choice.width >= 28 && choice.height >= 28),
      "Each color should have a usable target at side-panel width: " + JSON.stringify(initialColorPalette));
    assert.ok(initialColorPalette.scrollWidth <= initialColorPalette.clientWidth,
      "The color palette should fit in the side panel: " + JSON.stringify(initialColorPalette));
    await sidePanelClient.evaluate(`(() => {
      const purple = [...document.querySelectorAll(".group-card")]
        .find((item) => item.querySelector(".group-title")?.textContent === "Default")
        ?.querySelector('.color-palette input[value="purple"]');
      if (!purple) throw new Error("Purple color choice is missing.");
      purple.click();
    })()`);
    const recoloredDefault = await waitFor(
      () => sidePanelClient.evaluate(`(async () => {
        const response = await chrome.runtime.sendMessage({type:"state:get"});
        const state = response?.value;
        const group = state?.groups.find((item) => item.name === "Default");
        const card = [...document.querySelectorAll(".group-card")]
          .find((item) => item.querySelector(".group-title")?.textContent === "Default");
        const palette = card?.querySelector(".color-palette");
        return { color: group?.color, choiceCount: palette?.querySelectorAll('input[type="radio"]').length,
          selected: palette?.querySelector('input[type="radio"]:checked')?.value };
      })()`),
      (result) => result?.color === "purple" && result.choiceCount === 9 && result.selected === "purple",
      "persistent side-panel color selection",
    );
    assert.equal(recoloredDefault.color, "purple");
    const expectedBrave = /brave/i.test(browserPath) || /Brave/i.test(endpoint.version.Browser);
    const braveControls = await waitFor(
      () => sidePanelClient.evaluate("(async()=>({isBrave:Boolean(await navigator.brave?.isBrave?.()),cardHidden:document.querySelector('#brave-container-card').hidden,helpHidden:document.querySelector('#brave-containers-help').hidden}))()"),
      (controls) => controls.isBrave === expectedBrave
        && controls.cardHidden === !expectedBrave && controls.helpHidden === !expectedBrave,
      "browser-specific Brave Container controls",
    );
    assert.equal(braveControls.isBrave, expectedBrave, "The manager should identify the tested browser correctly.");
    assert.equal(braveControls.cardHidden, !braveControls.isBrave);
    assert.equal(braveControls.helpHidden, !braveControls.isBrave);
    if (braveControls.isBrave) {
      const settingsClickPoint = await sidePanelClient.evaluate("(() => { const link=document.querySelector('#open-brave-container-settings'); link.scrollIntoView({block:'center'}); const rect=link.getBoundingClientRect(); return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}; })()");
      await sidePanelClient.send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: settingsClickPoint.x, y: settingsClickPoint.y,
      });
      await sidePanelClient.send("Input.dispatchMouseEvent", {
        type: "mousePressed", x: settingsClickPoint.x, y: settingsClickPoint.y, button: "left", clickCount: 1,
      });
      await sidePanelClient.send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: settingsClickPoint.x, y: settingsClickPoint.y, button: "left", clickCount: 1,
      });
      const openedSettings = await waitFor(async () => {
        const [status, targets] = await Promise.all([
          sidePanelClient.evaluate("({text:document.querySelector('#status').textContent,kind:document.querySelector('#status').dataset.kind})"),
          browserTargets(endpointUrl),
        ]);
        const settings = targets.find((target) => target.type === "page"
          && /^(brave|chrome):\/\/settings\/braveContent/.test(target.url));
        return { status, settings };
      }, (value) => value.settings && value.status.text === "Opened Brave Container settings."
        && value.status.kind === "success", "Brave Container settings opened from manager");
      assert.match(openedSettings.settings.url, /^(brave|chrome):\/\/settings\/braveContent/);
      await browserClient.send("Target.closeTarget", { targetId: openedSettings.settings.id });
    }

    const controllerTab = await popup.client.evaluate("chrome.tabs.getCurrent().then((tab) => ({id:tab.id,windowId:tab.windowId}))");
    await popup.client.evaluate("chrome.tabs.update(" + controllerTab.id + ", {pinned:true})");
    await waitFor(
      () => readState(popup.client),
      (state) => !state.tabs.some((tab) => tab.browserTabId === controllerTab.id)
        && state.windows.some((window) => window.pinnedTabIds.includes(controllerTab.id)),
      "pinned controller exclusion",
    );

    const preexistingNativeTabs = await popup.client.evaluate("(async()=>{const tabs=[];for(const title of ['Old Native One','Old Native Two','Old Native Three','Old Native Four'])tabs.push(await chrome.tabs.create({windowId:" + controllerTab.windowId + ",url:'data:text/html,<title>'+title+'</title>',active:false}));const firstGroup=await chrome.tabs.group({tabIds:tabs.slice(0,2).map((tab)=>tab.id)});await chrome.tabGroups.update(firstGroup,{title:'Old Native Alpha',color:'blue'});const secondGroup=await chrome.tabs.group({tabIds:tabs.slice(2).map((tab)=>tab.id)});await chrome.tabGroups.update(secondGroup,{title:'Old Native Beta',color:'green'});return{ids:tabs.map((tab)=>tab.id),titles:tabs.map((tab)=>tab.title),windowId:" + controllerTab.windowId + "};})()");
    await waitFor(
      () => readState(popup.client),
      (state) => preexistingNativeTabs.ids.every((tabId) => state.tabs.some((tab) => tab.browserTabId === tabId)),
      "tabs created inside pre-existing native groups adopted by the current state",
    );
    await popup.client.evaluate("chrome.storage.local.remove('hiddentabby.state')");
    const firstRunWorkerTarget = await waitFor(
      async () => (await browserTargets(endpointUrl)).find((target) => target.type === "service_worker"
        && target.url === "chrome-extension://" + extensionId + "/src/service-worker.js") ?? null,
      Boolean,
      "worker before first-run native-group adoption",
    );
    const firstRunWorkerClose = await browserClient.send("Target.closeTarget", { targetId: firstRunWorkerTarget.id });
    assert.equal(firstRunWorkerClose.success, true, "The test must restart the worker after removing local state.");
    await waitFor(
      async () => !(await browserTargets(endpointUrl)).some((target) => target.id === firstRunWorkerTarget.id),
      Boolean,
      "worker termination before first-run native-group adoption",
    );
    const firstRunAfterNativeGroups = await waitFor(
      () => readState(popup.client),
      (state) => state.groups?.length === 1 && preexistingNativeTabs.ids.every((tabId) => state.tabs
        .some((tab) => tab.browserTabId === tabId && tab.groupId === state.groups[0].id && tab.status === "open")),
      "first-run adoption of pre-existing native groups",
    );
    defaultGroup = firstRunAfterNativeGroups.groups[0];
    const nativeGroupAdoptionEvidence = await popup.client.evaluate("(async()=>{const tabs=await chrome.tabs.query({windowId:" + controllerTab.windowId + "});const nativeGroups=await chrome.tabGroups.query({windowId:" + controllerTab.windowId + "});const selected=tabs.filter((tab)=>" + JSON.stringify(preexistingNativeTabs.ids) + ".includes(tab.id));return{tabs:selected.map((tab)=>({id:tab.id,groupId:tab.groupId,pinned:tab.pinned})),groups:nativeGroups.map((group)=>({id:group.id,title:group.title}))};})()");
    assert.equal(nativeGroupAdoptionEvidence.tabs.length, preexistingNativeTabs.ids.length);
    assert.ok(nativeGroupAdoptionEvidence.tabs.every((tab) => !tab.pinned
      && tab.groupId === nativeGroupAdoptionEvidence.groups.find((group) => group.title === "Default")?.id),
    "First-run adoption should move all unpinned tabs out of their old native groups into Default.");
    assert.ok(!nativeGroupAdoptionEvidence.groups.some((group) => ["Old Native Alpha", "Old Native Beta"].includes(group.title)),
      "First-run adoption should replace pre-existing native group definitions for managed tabs.");

    await popup.client.evaluate("(() => { const input=document.querySelector('#group-name'); input.value='Group B'; document.querySelector('#create-form').requestSubmit(); return true; })()");
    const stateAfterCreate = await waitFor(
      () => readState(popup.client),
      (state) => state.groups.some((group) => group.name === "Group B"),
      "group creation from popup",
    );
    const destinationGroup = stateAfterCreate.groups.find((group) => group.name === "Group B");
    assert.equal(stateAfterCreate.activeGroupId, defaultGroup.id, "Creating a group must not activate it.");
    const menuEvidence = await popup.client.evaluate("(async () => { const probe=(id)=>new Promise((resolve)=>chrome.contextMenus.create({id,title:'HiddenTabby E2E probe',contexts:['tab']},()=>{const error=chrome.runtime.lastError?.message||''; if(error)resolve(error); else chrome.contextMenus.remove(id,()=>resolve('created'));})); return {root:await probe('hiddentabby-move-root'),group:await probe('hiddentabby-move:' + "
      + JSON.stringify(destinationGroup.id)
      + ")}; })()");
    assert.match(menuEvidence.root, /duplicate/i, "The tab-strip move menu root should be registered in Chromium.");
    assert.match(menuEvidence.group, /duplicate/i, "Each group should have a registered tab-strip destination.");

    const firstWindowId = controllerTab.windowId;
    const firstWindowTabs = await popup.client.evaluate("(async () => { const tab=await chrome.tabs.create({url:'data:text/html,<title>Chromium QA Tab</title>',active:false}); const pin=await chrome.tabs.create({url:'data:text/html,<title>Pinned QA Tab</title>',active:false}); await chrome.tabs.update(pin.id,{pinned:true}); return {tabId:tab.id,pinnedTabId:pin.id}; })()");
    const pinUnpinProbeId = await popup.client.evaluate(
      "chrome.tabs.create({url:'data:text/html,<title>Pin toggle probe</title>',active:false}).then((tab)=>tab.id)",
    );
    await waitFor(
      () => readState(popup.client),
      (state) => state.tabs.some((tab) => tab.browserTabId === pinUnpinProbeId),
      "pin/unpin probe adoption",
    );
    await popup.client.evaluate("chrome.tabs.update(" + pinUnpinProbeId + ", {pinned:true})");
    await waitFor(
      () => readState(popup.client),
      (state) => !state.tabs.some((tab) => tab.browserTabId === pinUnpinProbeId)
        && state.windows.some((window) => window.pinnedTabIds.includes(pinUnpinProbeId)),
      "real tab pinning exclusion",
    );
    await popup.client.evaluate("chrome.tabs.update(" + pinUnpinProbeId + ", {pinned:false})");
    await waitFor(
      () => readState(popup.client),
      (state) => state.tabs.some((tab) => tab.browserTabId === pinUnpinProbeId
        && tab.groupId === state.activeGroupId && tab.status === "open"),
      "real tab unpinning adoption",
    );

    const manualCloseProbe = await popup.client.evaluate(
      "chrome.tabs.create({url:'data:text/html,<title>Manual close probe</title>',active:false}).then((tab)=>({id:tab.id,url:tab.url}))",
    );
    await waitFor(
      () => readState(popup.client),
      (state) => state.tabs.some((tab) => tab.browserTabId === manualCloseProbe.id),
      "manual-close probe adoption",
    );
    await popup.client.evaluate("chrome.tabs.remove(" + manualCloseProbe.id + ")");
    await waitFor(
      () => readState(popup.client),
      (state) => !state.tabs.some((tab) => tab.browserTabId === manualCloseProbe.id),
      "manual tab close removes its record",
    );

    const titleProbe = await popup.client.evaluate(
      "chrome.tabs.create({url:'data:text/html,<title>Original E2E title</title>',active:false}).then((tab)=>({id:tab.id,url:tab.url}))",
    );
    await waitFor(
      () => readState(popup.client),
      (state) => state.tabs.some((tab) => tab.browserTabId === titleProbe.id && tab.title === "Original E2E title"),
      "title probe adoption",
    );
    const titleTarget = await waitFor(
      async () => (await browserTargets(endpointUrl))
        .find((target) => target.type === "page" && target.title === "Original E2E title") ?? null,
      Boolean,
      "title probe page target",
    );
    const titleClient = await DevToolsClient.connect(titleTarget.webSocketDebuggerUrl);
    browserClients.push(titleClient);
    await titleClient.evaluate("document.title='Updated E2E title'");
    await waitFor(
      () => readState(popup.client),
      (state) => state.tabs.some((tab) => tab.browserTabId === titleProbe.id && tab.title === "Updated E2E title"),
      "tab title update tracking",
    );

    const duplicateTabIds = await popup.client.evaluate("(async () => { const url="
      + JSON.stringify(fixtureUrl)
      + "; const first=await chrome.tabs.create({url,active:false}); const second=await chrome.tabs.create({url,active:false}); return [first.id,second.id]; })()");
    const duplicateRecordsBeforeSwitch = await waitFor(
      () => readState(popup.client),
      (state) => duplicateTabIds.every((tabId) => state.tabs.some((tab) => tab.browserTabId === tabId)),
      "duplicate URL tab adoption",
    );
    const duplicateRecordIds = duplicateTabIds.map((tabId) => duplicateRecordsBeforeSwitch.tabs
      .find((tab) => tab.browserTabId === tabId).id);
    assert.notEqual(duplicateRecordIds[0], duplicateRecordIds[1],
      "Two live tabs with the same URL must keep separate extension identities.");

    await popup.client.evaluate("chrome.tabs.update(" + firstWindowTabs.tabId + ", {active:true})");
    await waitFor(
      () => readState(popup.client),
      (state) => state.tabs.some((tab) => tab.browserTabId === firstWindowTabs.tabId && tab.lastActive),
      "real last-active tab tracking",
    );

    await popup.client.evaluate("(() => { window.__secondWindowTrace=[]; chrome.tabs.onCreated.addListener((tab)=>window.__secondWindowTrace.push({event:'created',id:tab.id,windowId:tab.windowId,groupId:tab.groupId,url:tab.url,pendingUrl:tab.pendingUrl})); chrome.tabs.onAttached.addListener((id,info)=>window.__secondWindowTrace.push({event:'attached',id,newWindowId:info.newWindowId,newPosition:info.newPosition})); chrome.tabs.onUpdated.addListener((id,info,tab)=>{if(info.url||info.pinned!==undefined)window.__secondWindowTrace.push({event:'updated',id,windowId:tab.windowId,url:tab.url,pendingUrl:tab.pendingUrl,changeUrl:info.url,groupId:tab.groupId,pinned:tab.pinned});}); })()");
    const secondWindow = await popup.client.evaluate("(async () => { const window=await chrome.windows.create({url:'about:blank',focused:false}); const bootstrap=(await chrome.tabs.query({windowId:window.id}))[0]; const tab=await chrome.tabs.create({windowId:window.id,url:'data:text/html,<title>Second QA Tab</title>',active:false}); const pin=await chrome.tabs.create({windowId:window.id,url:'data:text/html,<title>Second Window Pin</title>',active:false}); await chrome.tabs.update(pin.id,{pinned:true}); await chrome.tabs.remove(bootstrap.id); return {windowId:window.id,bootstrapTabId:bootstrap.id,tabId:tab.id,tabWindowId:tab.windowId,pinnedTabId:pin.id,pinWindowId:pin.windowId}; })()");
    await waitFor(
      () => readState(popup.client),
      (state) => state.windows.filter((window) => window.isOpen).length === 2
        && [firstWindowTabs.tabId, secondWindow.tabId].every((tabId) => state.tabs.some((tab) => tab.browserTabId === tabId)),
      "two-window tab tracking",
    );
    const secondWindowSingleton = await waitFor(
      async () => ({
        tab: await popup.client.evaluate("chrome.tabs.get(" + secondWindow.tabId + ").then((tab)=>({id:tab.id,groupId:tab.groupId,windowId:tab.windowId}))"),
        state: await readState(popup.client),
      }),
      ({ tab, state }) => tab.groupId === -1
        && !state.tabs.some((item) => item.browserTabId === secondWindow.bootstrapTabId),
      "single managed tab ungrouped in its browser window",
    );
    assert.equal(secondWindowSingleton.tab.windowId, secondWindow.windowId);
    const browserTabEvidence = await popup.client.evaluate("(async () => { const tab=await chrome.tabs.get("
      + firstWindowTabs.tabId
      + "); const group=await chrome.tabGroups.get(tab.groupId); const pinned=await chrome.tabs.get("
      + firstWindowTabs.pinnedTabId
      + "); return {title:group.title,pinned:pinned.pinned,groupId:tab.groupId}; })()");
    assert.equal(browserTabEvidence.title, "Default", "New tabs should join the active native group.");
    assert.equal(browserTabEvidence.pinned, true);

    const stateBeforeSwitch = await readState(popup.client);
    const secondTabRecord = stateBeforeSwitch.tabs.find((tab) => tab.browserTabId === secondWindow.tabId);
    assert.ok(secondTabRecord, "The second-window tab should be tracked.");
    const firstLastActiveRecord = stateBeforeSwitch.tabs.find((tab) => tab.browserTabId === firstWindowTabs.tabId);
    assert.ok(firstLastActiveRecord?.lastActive, "The chosen first-window tab should be recorded as last active.");
    const duplicateBrowserOrderBeforeSwitch = await popup.client.evaluate("chrome.tabs.query({windowId:"
      + firstWindowId
      + "}).then((tabs)=>tabs.filter((tab)=>tab.url==="
      + JSON.stringify(fixtureUrl)
      + ").sort((a,b)=>a.index-b.index).map((tab)=>({id:tab.id,index:tab.index})))");
    const expectedDuplicateOrder = duplicateBrowserOrderBeforeSwitch.map((liveTab) => stateBeforeSwitch.tabs
      .find((tab) => tab.browserTabId === liveTab.id)?.id);
    assert.equal(expectedDuplicateOrder.length, 2);
    assert.ok(expectedDuplicateOrder.every(Boolean), "Both live duplicate tabs should have stable records.");
    assert.notEqual(secondWindow.windowId, firstWindowId);
    assert.equal(secondWindow.tabWindowId, secondWindow.windowId,
      "tabs.create should return the requested second window ID: " + JSON.stringify(secondWindow));
    assert.equal(secondWindow.pinWindowId, secondWindow.windowId,
      "Pinned test tab should also be created in the second window: " + JSON.stringify(secondWindow));
    const secondLiveTab = await popup.client.evaluate("chrome.tabs.get("
      + secondWindow.tabId + ").then((tab)=>({id:tab.id,windowId:tab.windowId,url:tab.url}))");
    assert.equal(secondLiveTab.windowId, secondWindow.windowId,
      "The browser should honor the requested second window. Live tab: " + JSON.stringify(secondLiveTab)
        + "; trace: " + JSON.stringify(await popup.client.evaluate("window.__secondWindowTrace")));
    assert.equal(secondTabRecord.browserWindowId, secondWindow.windowId,
      "The logical tab record should retain the real second browser window ID. Browser trace: "
        + JSON.stringify(await popup.client.evaluate("window.__secondWindowTrace")));
    const dormantWindow = await popup.client.evaluate(
      "chrome.windows.create({url:'data:text/html,<title>Dormant window probe</title>',focused:false}).then((window)=>({windowId:window.id,tabId:window.tabs[0].id}))",
    );
    const stateBeforeUserClosedWindow = await waitFor(
      () => readState(popup.client),
      (state) => state.tabs.some((tab) => tab.browserTabId === dormantWindow.tabId
        && tab.status === "open")
        && state.windows.some((window) => window.browserWindowId === dormantWindow.windowId && window.isOpen),
      "new window tab adoption",
    );
    const userClosedWindowRecord = stateBeforeUserClosedWindow.tabs
      .find((tab) => tab.browserTabId === dormantWindow.tabId);
    await popup.client.evaluate("chrome.windows.remove(" + dormantWindow.windowId + ")");
    const stateAfterUserClosedWindow = await waitFor(
      () => readState(popup.client),
      (state) => {
        const window = state.windows.find((item) => item.id === userClosedWindowRecord.windowId);
        return !state.tabs.some((tab) => tab.id === userClosedWindowRecord.id)
          && (!window || window.isOpen === false);
      },
      "user-closed nonfinal window forgets its active-group tabs",
    );
    assert.equal(stateAfterUserClosedWindow.tabs.some((tab) => tab.id === userClosedWindowRecord.id), false,
      "A tab closed with its window must not be restored after later group switches.");
    const originalDefaultRecordIds = stateAfterUserClosedWindow.tabs
      .filter((tab) => tab.groupId === defaultGroup.id)
      .map((tab) => tab.id);
    await clickGroup(popup.client, "Group B");
    const switchedState = await waitFor(async () => {
      const state = await readState(popup.client);
      const tabs = await popup.client.evaluate("chrome.tabs.query({}).then((items) => items.map((tab) => ({id:tab.id,url:tab.url,pinned:tab.pinned,groupId:tab.groupId,windowId:tab.windowId})))");
      return { state, tabs };
    }, ({ state, tabs }) => state.activeGroupId === destinationGroup.id
      && state.windows.filter((window) => window.isOpen).length === 2
      && state.windows.filter((window) => window.isOpen).every((window) => window.pinnedTabIds.length > 0
        && window.placeholderTabId === null)
      && originalDefaultRecordIds.every((recordId) => state.tabs.find((tab) => tab.id === recordId)?.status === "closed")
      && !tabs.some((tab) => tab.id === firstWindowTabs.tabId || tab.id === secondWindow.tabId),
    "global switch keeps pinned windows open without blank placeholders");
    assert.ok(switchedState.tabs.some((tab) => tab.id === firstWindowTabs.pinnedTabId && tab.pinned));
    assert.ok(switchedState.tabs.some((tab) => tab.id === secondWindow.pinnedTabId && tab.pinned));
    assert.equal(switchedState.state.windows.filter((window) => window.isOpen).length, 2);
    assert.ok(switchedState.state.windows.filter((item) => item.isOpen)
      .every((window) => window.placeholderTabId === null));
    const closedDuplicateRecords = switchedState.state.tabs
      .filter((tab) => duplicateRecordIds.includes(tab.id))
      .map((tab) => ({ id: tab.id, index: tab.index, sessionId: tab.sessionId, status: tab.status }));
    const recentDuplicateSessions = await popup.client.evaluate("chrome.sessions.getRecentlyClosed({maxResults:25}).then((items)=>items.filter((item)=>item.tab?.url==="
      + JSON.stringify(fixtureUrl)
      + ").map((item)=>({sessionId:item.tab.sessionId,index:item.tab.index,windowId:item.tab.windowId,url:item.tab.url,lastModified:item.lastModified})))");

    const activeGroupTab = await popup.client.evaluate("chrome.tabs.create({windowId:"
      + firstWindowId
      + ",url:" + JSON.stringify(fixtureUrl)
      + ",active:false}).then((tab)=>({id:tab.id,url:tab.url,pendingUrl:tab.pendingUrl,groupId:tab.groupId}))");
    const activeGroupTabState = await waitFor(
      () => readState(popup.client),
      (state) => state.tabs.some((tab) => tab.browserTabId === activeGroupTab.id
        && tab.groupId === destinationGroup.id && tab.status === "open"),
      "new tab joins the currently active group",
    );
    assert.ok(activeGroupTabState.tabs.some((tab) => tab.browserTabId === activeGroupTab.id
      && tab.url === fixtureUrl));

    await clickGroup(popup.client, "Default");
    const restoredDefaultState = await waitFor(
      () => readState(popup.client),
      (state) => state.activeGroupId === defaultGroup.id
        && originalDefaultRecordIds.every((recordId) => state.tabs.find((tab) => tab.id === recordId)?.status === "open")
        && state.windows.filter((window) => window.isOpen).every((window) => window.placeholderTabId === null)
        && state.tabs.find((tab) => tab.id === secondTabRecord.id)?.browserWindowId === secondWindow.windowId,
      "global restore of Default tabs",
      25000,
    );
    const restoredDefaultRecordIds = restoredDefaultState.tabs
      .filter((tab) => tab.groupId === defaultGroup.id && tab.status === "open")
      .map((tab) => tab.id)
      .sort();
    const unexpectedDefaultRecords = restoredDefaultState.tabs
      .filter((tab) => tab.groupId === defaultGroup.id && tab.status === "open"
        && !originalDefaultRecordIds.includes(tab.id))
      .map(({ id, url, title, browserTabId, browserWindowId, index, sessionId }) => ({
        id, url, title, browserTabId, browserWindowId, index, sessionId,
      }));
    assert.deepEqual(restoredDefaultRecordIds, [...originalDefaultRecordIds].sort(),
      "Switching from a new empty group must restore exactly the Default snapshots captured before switching. "
        + "Unexpected records: " + JSON.stringify(unexpectedDefaultRecords));
    const defaultLiveTabIds = await popup.client.evaluate("chrome.tabs.query({}).then((tabs)=>tabs.filter((tab)=>!tab.pinned&&!tab.url?.includes('/placeholder.html')&&!tab.pendingUrl?.includes('/placeholder.html')).map((tab)=>tab.id).sort((a,b)=>a-b))");
    const defaultSnapshotTabIds = restoredDefaultState.tabs
      .filter((tab) => tab.groupId === defaultGroup.id && tab.status === "open")
      .map((tab) => tab.browserTabId)
      .sort((a, b) => a - b);
    assert.deepEqual(defaultLiveTabIds, defaultSnapshotTabIds,
      "Every live unpinned non-placeholder tab after restoring Default must have exactly one pre-existing snapshot.");
    const manuallyClosedTabs = await popup.client.evaluate("chrome.tabs.query({}).then((tabs)=>tabs.filter((tab)=>tab.url==="
      + JSON.stringify(manualCloseProbe.url)
      + ").map((tab)=>({id:tab.id,url:tab.url})))");
    assert.deepEqual(manuallyClosedTabs, [], "A manually closed tab must stay gone across a group switch.");
    assert.equal(restoredDefaultState.tabs.some((tab) => tab.id === userClosedWindowRecord.id), false,
      "Switching back must not bring back tabs closed with their nonfinal window.");
    assert.ok(restoredDefaultState.tabs.some((tab) => tab.groupId === destinationGroup.id && tab.status === "closed"));
    const restoredDuplicateRecords = restoredDefaultState.tabs
      .filter((tab) => duplicateRecordIds.includes(tab.id) && tab.status === "open");
    assert.equal(restoredDuplicateRecords.length, 2);
    assert.equal(new Set(restoredDuplicateRecords.map((tab) => tab.browserTabId)).size, 2,
      "Duplicate URLs must restore into two distinct browser tabs.");
    const duplicateBrowserOrderAfterSwitch = await popup.client.evaluate("chrome.tabs.query({windowId:"
      + firstWindowId
      + "}).then((tabs)=>tabs.filter((tab)=>tab.url==="
      + JSON.stringify(fixtureUrl)
      + ").sort((a,b)=>a.index-b.index).map((tab)=>({id:tab.id,index:tab.index})))");
    const restoredDuplicateOrder = duplicateBrowserOrderAfterSwitch.map((liveTab) => restoredDefaultState.tabs
      .find((tab) => tab.browserTabId === liveTab.id)?.id);
    assert.deepEqual(restoredDuplicateOrder, expectedDuplicateOrder,
      "Duplicate URL tabs should retain live browser order. Before: "
        + JSON.stringify(duplicateBrowserOrderBeforeSwitch) + "; after: "
        + JSON.stringify(duplicateBrowserOrderAfterSwitch) + "; records: "
        + JSON.stringify(restoredDuplicateRecords) + "; closed records: "
        + JSON.stringify(closedDuplicateRecords) + "; recent sessions: "
        + JSON.stringify(recentDuplicateSessions));
    const firstRestoreEvidence = await popup.client.evaluate("(async () => { const tabs=await chrome.tabs.query({windowId:"
      + firstWindowId
      + "}); const groups=await Promise.all([...new Set(tabs.filter((tab)=>!tab.pinned&&tab.groupId>=0).map((tab)=>tab.groupId))].map((id)=>chrome.tabGroups.get(id))); return {tabs:tabs.map((tab)=>({id:tab.id,windowId:tab.windowId,pinned:tab.pinned,groupId:tab.groupId,index:tab.index,active:tab.active})),groups:groups.map((group)=>({id:group.id,title:group.title,windowId:group.windowId}))}; })()");
    const firstRestoredLastActiveRecord = restoredDefaultState.tabs.find((tab) => tab.id === firstLastActiveRecord.id);
    assert.equal(firstRestoreEvidence.tabs.find((tab) => tab.id === firstRestoredLastActiveRecord?.browserTabId)?.active, true,
      "The first switch back should reactivate the tab chosen before switching.");
    const manuallyOrderedDuplicateIds = [...expectedDuplicateOrder].reverse();
    const tabToMove = restoredDuplicateRecords.find((tab) => tab.id === manuallyOrderedDuplicateIds[0]);
    const firstDuplicateIndex = Math.min(...duplicateBrowserOrderAfterSwitch.map((tab) => tab.index));
    await popup.client.evaluate("chrome.tabs.move(" + tabToMove.browserTabId
      + ", {windowId:" + firstWindowId + ",index:" + firstDuplicateIndex + "})");
    const manualOrderState = await waitFor(
      async () => {
        const state = await readState(popup.client);
        const liveOrder = await popup.client.evaluate("chrome.tabs.query({windowId:" + firstWindowId
          + "}).then((tabs)=>tabs.filter((tab)=>tab.url===" + JSON.stringify(fixtureUrl)
          + ").sort((a,b)=>a.index-b.index).map((tab)=>({id:tab.id,index:tab.index})))");
        return { state, liveOrder };
      },
      ({ state, liveOrder }) => liveOrder.map((liveTab) => state.tabs
        .find((tab) => tab.browserTabId === liveTab.id)?.id).join(",") === manuallyOrderedDuplicateIds.join(",")
        && manuallyOrderedDuplicateIds.every((recordId) => state.tabs.find((tab) => tab.id === recordId)?.index
          === liveOrder.find((liveTab) => state.tabs.find((tab) => tab.id === recordId)?.browserTabId === liveTab.id)?.index),
      "manual duplicate-tab reorder tracking",
    );
    const lastActiveBeforeManualSwitch = manualOrderState.state.tabs.find((tab) => tab.windowId === firstLastActiveRecord.windowId
      && tab.groupId === defaultGroup.id && tab.lastActive);
    assert.ok(lastActiveBeforeManualSwitch, "The active group should retain one last-active tab before switching away.");
    await clickGroup(popup.client, "Group B");
    await waitFor(() => readState(popup.client), (state) => state.activeGroupId === destinationGroup.id,
      "switch away after manually reordering duplicate tabs");
    await clickGroup(popup.client, "Default");
    const manuallyRestoredState = await waitFor(
      async () => {
        const state = await readState(popup.client);
        const liveOrder = await popup.client.evaluate("chrome.tabs.query({windowId:" + firstWindowId
          + "}).then((tabs)=>tabs.filter((tab)=>tab.url===" + JSON.stringify(fixtureUrl)
          + ").sort((a,b)=>a.index-b.index).map((tab)=>({id:tab.id,index:tab.index})))");
        const activeTab = await popup.client.evaluate("chrome.tabs.query({windowId:" + firstWindowId
          + "}).then((tabs)=>tabs.find((tab)=>tab.active))");
        return { state, liveOrder, activeTab };
      },
      ({ state, liveOrder, activeTab }) => state.activeGroupId === defaultGroup.id
        && state.operations.length === 0
        && manuallyOrderedDuplicateIds.every((recordId) => state.tabs.find((tab) => tab.id === recordId)?.status === "open")
        && liveOrder.map((liveTab) => state.tabs.find((tab) => tab.browserTabId === liveTab.id)?.id).join(",")
          === manuallyOrderedDuplicateIds.join(",")
        && state.tabs.some((tab) => tab.id === lastActiveBeforeManualSwitch.id && tab.browserTabId === activeTab?.id),
      "manually ordered duplicate tabs restore in user-selected order",
      25000,
    );
    assert.deepEqual(manuallyRestoredState.liveOrder.map((liveTab) => manuallyRestoredState.state.tabs
      .find((tab) => tab.browserTabId === liveTab.id)?.id), manuallyOrderedDuplicateIds);
    const restoredEvidence = await popup.client.evaluate("(async () => { const tabs=await chrome.tabs.query({}); const groups=await Promise.all([...new Set(tabs.filter((tab)=>!tab.pinned&&tab.groupId>=0).map((tab)=>tab.groupId))].map((id)=>chrome.tabGroups.get(id))); return {tabs:tabs.map((tab)=>({id:tab.id,windowId:tab.windowId,pinned:tab.pinned,groupId:tab.groupId,index:tab.index,active:tab.active})),groups:groups.map((group)=>({id:group.id,title:group.title,windowId:group.windowId}))}; })()");
    assert.ok(restoredEvidence.groups.some((group) => group.title === "Default" && group.windowId === firstWindowId));
    assert.equal(restoredEvidence.groups.some((group) => group.title === "Default" && group.windowId === secondWindow.windowId), false,
      "A window with only one managed tab should not retain a native group that prompts on tab close: "
        + JSON.stringify(restoredEvidence));
    const restoredSingleton = restoredEvidence.tabs.filter((tab) => tab.windowId === secondWindow.windowId && !tab.pinned);
    assert.equal(restoredSingleton.length, 1,
      "The window should contain one unpinned tab after the group is restored: " + JSON.stringify(restoredEvidence));
    assert.equal(restoredSingleton[0].groupId, -1,
      "The singleton tab should remain native-ungrouped after a workspace switch: " + JSON.stringify(restoredEvidence));
    const restoredSingletonRecord = restoredDefaultState.tabs.find((tab) => tab.id === secondTabRecord.id);
    assert.equal(restoredSingletonRecord?.groupId, defaultGroup.id,
      "The singleton tab must remain logically assigned to Default in HiddenTabby.");
    const fixtureFaviconState = await waitFor(
      () => readState(popup.client),
      (state) => state.tabs.some((tab) => tab.id === duplicateRecordIds[0]
        && tab.faviconUrl?.endsWith("/favicon.svg")),
      "fixture favicon tracking",
    );
    const fixtureFaviconUrl = fixtureFaviconState.tabs.find((tab) => tab.id === duplicateRecordIds[0])?.faviconUrl;
    await popup.client.evaluate("document.querySelector('#open-manager').click()");
    const manager = await waitFor(async () => {
      const target = (await browserTargets(endpointUrl)).find((candidate) => candidate.url.endsWith("/manager.html"));
      return target ?? null;
    }, Boolean, "manager page opened from popup");
    const managerClient = await DevToolsClient.connect(manager.webSocketDebuggerUrl);
    browserClients.push(managerClient);
    await waitFor(() => managerClient.evaluate("document.readyState"), (value) => value === "complete", "manager page load");
    await managerClient.send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await waitFor(
      () => managerClient.evaluate('document.querySelectorAll(".group-card").length'),
      (count) => count > 0,
      "workspace manager group cards rendered",
    );
    const retryLoadInjection = await managerClient.evaluate(`(async () => {
      const storageKey = "hiddentabby.state";
      const stored = await chrome.storage.local.get(storageKey);
      const originalState = stored[storageKey];
      const originalDescriptor = Object.getOwnPropertyDescriptor(chrome.runtime, "sendMessage");
      const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
      let failureScenario = null;
      const wrappedSendMessage = (message, ...args) => {
        if (message?.type === "state:get" && failureScenario) {
          failureScenario.attempts += 1;
          failureScenario.attemptTimes.push(Date.now());
          if (failureScenario.failuresRemaining > 0) {
            failureScenario.failuresRemaining -= 1;
            if (failureScenario.changeStorageDuringRetry && failureScenario.attempts === 1) {
              setTimeout(() => {
                void chrome.storage.local.set({
                  [storageKey]: { ...originalState, retryProbe: Date.now() },
                });
              }, 100);
            }
            return Promise.reject(new Error(failureScenario.message));
          }
        }
        return sendMessage(message, ...args);
      };
      let intercepted = false;
      try {
        Object.defineProperty(chrome.runtime, "sendMessage", {
          configurable: true,
          writable: true,
          value: wrappedSendMessage,
        });
        intercepted = chrome.runtime.sendMessage === wrappedSendMessage;
      } catch {}
      if (!intercepted) return { intercepted: false };
      window.startLoadFailureScenario = async (
        message,
        changeStorageDuringRetry = false,
        failuresRemaining = 1,
      ) => {
        failureScenario = {
          message,
          failuresRemaining,
          attempts: 0,
          attemptTimes: [],
          changeStorageDuringRetry,
        };
        await chrome.storage.local.set({
          [storageKey]: { ...originalState, retryProbe: Date.now() },
        });
      };
      window.triggerLoadRefresh = () => chrome.storage.local.set({
        [storageKey]: { ...originalState, retryProbe: Date.now() },
      });
      window.readLoadFailureScenario = () => ({
        attempts: failureScenario?.attempts,
        attemptTimes: failureScenario?.attemptTimes,
      });
      window.retryAfterLoadError = () => {
        const button = document.querySelector(".empty-state button");
        if (!button) return false;
        button.click();
        return true;
      };
      window.restoreRetryProbe = async () => {
        await chrome.storage.local.set({ [storageKey]: originalState });
        if (originalDescriptor) {
          Object.defineProperty(chrome.runtime, "sendMessage", originalDescriptor);
        } else {
          delete chrome.runtime.sendMessage;
        }
      };
      return { intercepted: true };
    })()`);
    assert.equal(retryLoadInjection.intercepted, true,
      "The manager test should be able to inject one transient state-read failure.");
    const tabEditLockError = "Tabs cannot be edited right now (user may be dragging a tab).";
    await managerClient.evaluate(`window.startLoadFailureScenario(${JSON.stringify(tabEditLockError)}, true)`);
    await waitFor(
      () => managerClient.evaluate(`({
        groups: document.querySelectorAll(".group-card").length,
        retry: Boolean(document.querySelector(".empty-state button")),
        status: document.querySelector("#status")?.textContent,
        attempts: window.readLoadFailureScenario().attempts
      })`),
      (view) => view.groups > 0 && !view.retry && view.attempts === 2
        && view.status?.startsWith("Tab titles and URLs stay in this browser profile"),
      "automatic one-time retry after a transient tab-edit lock",
    );
    const retryTiming = await managerClient.evaluate("window.readLoadFailureScenario()");
    assert.ok(retryTiming.attemptTimes[1] - retryTiming.attemptTimes[0] >= 350,
      "The retry should wait about 400 ms and absorb storage changes during the delay.");
    await wait(250);
    assert.equal(await managerClient.evaluate("window.readLoadFailureScenario().attempts"), 2,
      "A storage event during the retry delay should not start another state read.");

    await managerClient.evaluate(`window.startLoadFailureScenario(${JSON.stringify(tabEditLockError)}, false, 3)`);
    await waitFor(
      () => managerClient.evaluate(`({
        message: document.querySelector(".empty-state")?.textContent,
        status: document.querySelector("#status")?.textContent,
        button: document.querySelector(".empty-state button")?.getAttribute("aria-label"),
        attempts: window.readLoadFailureScenario().attempts
      })`),
      (view) => view.message?.includes("Groups could not be loaded")
        && view.status === tabEditLockError
        && view.button === "Reload workspace groups"
        && view.attempts === 2,
      "manual retry control after the one automatic retry also fails",
    );
    await wait(500);
    assert.equal(await managerClient.evaluate("window.readLoadFailureScenario().attempts"), 2,
      "A persistent tab-edit lock should stop after one automatic retry.");
    await managerClient.evaluate("window.triggerLoadRefresh()");
    await waitFor(
      () => managerClient.evaluate("window.readLoadFailureScenario().attempts"),
      (attempts) => attempts === 3,
      "a later storage-triggered load after the failed retry",
    );
    await wait(500);
    assert.equal(await managerClient.evaluate("window.readLoadFailureScenario().attempts"), 3,
      "A later storage event should not restart automatic retries until recovery or manual reload.");
    assert.equal(await managerClient.evaluate("window.retryAfterLoadError()"), true,
      "Manual reload should be available after the automatic retry is exhausted.");
    await waitFor(
      () => managerClient.evaluate(`({
        groups: document.querySelectorAll(".group-card").length,
        retry: Boolean(document.querySelector(".empty-state button"))
      })`),
      (view) => view.groups > 0 && !view.retry,
      "manual recovery after the tab-edit lock clears",
    );

    await managerClient.evaluate(`window.startLoadFailureScenario("Unrelated state read failure")`);
    await waitFor(
      () => managerClient.evaluate(`({
        message: document.querySelector(".empty-state")?.textContent,
        status: document.querySelector("#status")?.textContent,
        button: document.querySelector(".empty-state button")?.getAttribute("aria-label")
      })`),
      (view) => view.message?.includes("Groups could not be loaded")
        && view.status === "Unrelated state read failure"
        && view.button === "Reload workspace groups",
      "manual retry control for a non-tab-edit state-read failure",
    );
    await wait(500);
    assert.equal(await managerClient.evaluate("window.readLoadFailureScenario().attempts"), 1,
      "Unrelated errors should not trigger an automatic retry.");
    assert.equal(await managerClient.evaluate("window.retryAfterLoadError()"), true,
      "The manual retry control should remain available after an unrelated error.");
    await waitFor(
      () => managerClient.evaluate(`({
        groups: document.querySelectorAll(".group-card").length,
        retry: Boolean(document.querySelector(".empty-state button"))
      })`),
      (view) => view.groups > 0 && !view.retry,
      "groups restored by the retry control",
    );
    await managerClient.evaluate("window.restoreRetryProbe()");
    await waitFor(
      () => managerClient.evaluate('document.querySelectorAll(".group-card").length'),
      (count) => count > 0,
      "manager state after restoring the test profile",
    );
    const managerWorkspaceLayout = await managerClient.evaluate(`(async () => {
      const state = (await chrome.runtime.sendMessage({type: "state:get"})).value;
      const cards = [...document.querySelectorAll(".group-card")];
      const rows = [...document.querySelectorAll(".tab-row")];
      const windowLabels = rows.map((row) => row.querySelector(".tab-meta")?.textContent ?? "");
      const urls = rows.map((row) => row.querySelector(".tab-url"));
      const actionLayouts = rows.map((row) => {
        const move = row.querySelector(".tab-move-toggle");
        const remove = row.querySelector(".tab-delete-button");
        const moveRect = move?.getBoundingClientRect();
        const removeRect = remove?.getBoundingClientRect();
        return {
          hasMove: Boolean(move),
          hasDelete: Boolean(remove),
          moveWidth: moveRect?.width ?? 0,
          deleteWidth: removeRect?.width ?? 0,
          topAligned: Boolean(moveRect && removeRect && Math.abs(moveRect.top - removeRect.top) < 1),
          deleteHasAccessibleName: Boolean(remove?.getAttribute("aria-label")),
          deleteHasTooltip: Boolean(remove?.getAttribute("title")),
        };
      });
      const firstRecord = state.tabs.find((tab) => tab.id === ${JSON.stringify(firstLastActiveRecord.id)});
      const secondRecord = state.tabs.find((tab) => tab.id === ${JSON.stringify(secondTabRecord.id)});
      const firstRow = rows.find((row) => row.dataset.tabId === firstRecord?.id);
      const secondRow = rows.find((row) => row.dataset.tabId === secondRecord?.id);
      return {
        hasSeparateTabsPanel: Boolean(document.querySelector("#tabs")),
        groupCount: cards.length,
        groupsWithTabLists: cards.filter((card) => card.querySelector(".tab-list")).length,
        tabRows: rows.length,
        tabRowsInsideGroups: rows.filter((row) => row.closest(".group-card")).length,
        actionsAreCompactAndTopAligned: actionLayouts.every((actions) => actions.hasMove
          && actions.hasDelete && actions.moveWidth <= 30 && actions.deleteWidth <= 30
          && actions.topAligned && actions.deleteHasAccessibleName && actions.deleteHasTooltip),
        rowsHaveFriendlyWindowLabels: windowLabels.every((label) => label.startsWith("Window #")
          && /^[0-9]+$/.test(label.slice(8))),
        windowLabelsContainNoGroupOrStatus: windowLabels.every((label) => !/ · |Open|Saved for restoration/.test(label)),
        firstWindowLabel: firstRow?.querySelector(".tab-meta")?.textContent,
        expectedFirstWindowLabel: "Window #" + (state.windows.findIndex((window) => window.id === firstRecord?.windowId) + 1),
        secondWindowLabel: secondRow?.querySelector(".tab-meta")?.textContent,
        expectedSecondWindowLabel: "Window #" + (state.windows.findIndex((window) => window.id === secondRecord?.windowId) + 1),
        urlsStayOnOneSelectableLine: urls.every((url) => {
          if (!url) return false;
          const style = getComputedStyle(url);
          return style.whiteSpace === "nowrap" && style.overflow === "hidden"
            && style.textOverflow === "ellipsis" && style.userSelect === "all";
        }),
      };
    })()`);
    assert.equal(managerWorkspaceLayout.hasSeparateTabsPanel, false,
      "Saved tabs should no longer have a separate manager panel.");
    assert.equal(managerWorkspaceLayout.groupsWithTabLists, managerWorkspaceLayout.groupCount,
      "Every group should contain its own tab list.");
    assert.equal(managerWorkspaceLayout.tabRowsInsideGroups, managerWorkspaceLayout.tabRows,
      "Every saved tab should be rendered inside its owning group.");
    assert.ok(managerWorkspaceLayout.tabRows > 0, "The manager test should exercise tabs within groups.");
    assert.equal(managerWorkspaceLayout.actionsAreCompactAndTopAligned, true,
      "Each tab should have compact, accessible move and delete buttons aligned at the row top.");
    assert.equal(managerWorkspaceLayout.rowsHaveFriendlyWindowLabels, true,
      "Tab rows should show simple window numbers instead of browser IDs.");
    assert.equal(managerWorkspaceLayout.windowLabelsContainNoGroupOrStatus, true,
      "Tab rows should not repeat the group name or open/saved state.");
    assert.equal(managerWorkspaceLayout.firstWindowLabel, managerWorkspaceLayout.expectedFirstWindowLabel);
    assert.equal(managerWorkspaceLayout.secondWindowLabel, managerWorkspaceLayout.expectedSecondWindowLabel);
    assert.equal(managerWorkspaceLayout.firstWindowLabel, "Window #1");
    assert.equal(managerWorkspaceLayout.secondWindowLabel, "Window #2");
    assert.notEqual(managerWorkspaceLayout.firstWindowLabel, managerWorkspaceLayout.secondWindowLabel,
      "Tabs in different browser windows should show different friendly labels.");
    assert.equal(managerWorkspaceLayout.urlsStayOnOneSelectableLine, true,
      "Long URLs should stay on one ellipsized line and select as a unit for copying.");
    const faviconEvidence = await waitFor(
      () => managerClient.evaluate(`(async () => {
        const response = await chrome.runtime.sendMessage({type: "state:get"});
        const record = response.value.tabs.find((tab) => tab.id === ${JSON.stringify(duplicateRecordIds[0])});
        const card = [...document.querySelectorAll(".group-card")]
          .find((item) => item.dataset.groupId === record?.groupId);
        const disclosure = card?.querySelector(".group-disclosure");
        if (disclosure && !disclosure.open) disclosure.open = true;
        const row = [...document.querySelectorAll(".tab-row")]
          .find((item) => item.dataset.tabId === record?.id);
        const icon = row?.querySelector(".tab-favicon img");
        const title = row?.querySelector(".tab-title");
        return {
          source: icon?.src ?? null,
          faviconUrl: record?.faviconUrl ?? null,
          loaded: Boolean(icon?.complete && icon.naturalWidth > 0),
          beforeTitle: Boolean(icon && title
            && (icon.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING)),
        };
      })()`),
      (result) => result?.loaded && result.source === result.faviconUrl,
      "manager tab favicon rendering",
    );
    assert.equal(faviconEvidence.source, fixtureFaviconUrl,
      "The manager should render the browser-provided favicon URL.");
    assert.equal(faviconEvidence.beforeTitle, true,
      "The favicon should appear before the tab title.");
    const groupHeightLayout = await managerClient.evaluate(`(() => {
      const details = document.querySelector(".group-disclosure[open]");
      const summary = details?.querySelector(".group-summary");
      const tabList = details?.querySelector(".tab-list");
      const sample = tabList?.querySelector(".tab-row");
      if (!details || !summary || !tabList || !sample) return null;
      const clones = [];
      while (tabList.children.length + clones.length < 14) {
        clones.push(sample.cloneNode(true));
      }
      tabList.append(...clones);
      const card = details.closest(".group-card");
      const scrollable = details.scrollHeight > details.clientHeight;
      details.scrollTop = details.scrollHeight;
      const summaryRect = summary.getBoundingClientRect();
      const detailsRect = details.getBoundingClientRect();
      const result = {
        groupHeight: card.getBoundingClientRect().height,
        scrollable,
        scrollPositionChanged: details.scrollTop > 0,
        summarySticky: getComputedStyle(summary).position === "sticky",
        summaryVisibleAfterScroll: summaryRect.bottom > detailsRect.top
          && summaryRect.top < detailsRect.bottom,
      };
      details.scrollTop = 0;
      clones.forEach((clone) => clone.remove());
      return result;
    })()`);
    assert.ok(groupHeightLayout, "The manager should render an expanded group with tabs.");
    assert.ok(groupHeightLayout.groupHeight <= 622,
      "An expanded group should stay within its 620px height cap: " + JSON.stringify(groupHeightLayout));
    assert.equal(groupHeightLayout.scrollable, true,
      "Group contents beyond the height cap should be scrollable.");
    assert.equal(groupHeightLayout.scrollPositionChanged, true,
      "The expanded group should accept vertical scrolling.");
    assert.equal(groupHeightLayout.summarySticky, true,
      "The group heading should stay sticky while its contents scroll.");
    assert.equal(groupHeightLayout.summaryVisibleAfterScroll, true,
      "The group heading should remain visible at the end of the scrollable content.");
    const measureManagerColumns = async (width) => {
      await managerClient.send("Emulation.setDeviceMetricsOverride", {
        width, height: 1000, deviceScaleFactor: 1, mobile: false,
      });
      return managerClient.evaluate(`(() => {
      const grid = document.querySelector("#groups");
      const existingCards = [...grid.querySelectorAll(":scope > .group-card")];
      existingCards.forEach((card) => { card.hidden = true; });
      const probes = Array.from({length: 6}, (_, index) => {
        const card = document.createElement("article");
        card.className = "group-card layout-probe";
        card.dataset.layoutProbe = String(index);
        card.style.height = "120px";
        return card;
      });
      grid.append(...probes);
      const columns = new Set(probes
        .map((card) => Math.round(card.getBoundingClientRect().left)));
      const result = {columns: columns.size, maxColumns: getComputedStyle(grid).columnCount,
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth};
      probes.forEach((card) => card.remove());
      existingCards.forEach((card) => { card.hidden = false; });
      return result;
    })()`);
    };
    const twoColumnLayout = await measureManagerColumns(800);
    assert.equal(twoColumnLayout.columns, 2,
      "The manager should reflow to two columns when three minimum-width columns do not fit.");
    assert.equal(twoColumnLayout.maxColumns, "3",
      "The workspace manager should have a global maximum of three columns.");
    assert.ok(twoColumnLayout.pageWidth <= twoColumnLayout.viewportWidth,
      "Two-column manager layout should not overflow horizontally: " + JSON.stringify(twoColumnLayout));
    const threeColumnLayout = await measureManagerColumns(1280);
    assert.equal(threeColumnLayout.columns, 3,
      "The manager should use three columns when the available width permits it.");
    assert.equal(threeColumnLayout.maxColumns, "3",
      "The workspace manager should keep the same three-column maximum at desktop widths.");
    assert.ok(threeColumnLayout.pageWidth <= threeColumnLayout.viewportWidth,
      "Three-column manager layout should not overflow horizontally: " + JSON.stringify(threeColumnLayout));
    const wideGroupLayout = await measureManagerColumns(1600);
    assert.equal(wideGroupLayout.columns, 3,
      "Wide managers should remain capped at three masonry columns.");
    assert.equal(wideGroupLayout.maxColumns, "3",
      "The workspace manager should never exceed three configured columns.");
    assert.ok(wideGroupLayout.pageWidth <= wideGroupLayout.viewportWidth,
      "Wide manager layout should not overflow horizontally: " + JSON.stringify(wideGroupLayout));
    await managerClient.send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    const managerExpansion = await managerClient.evaluate(`(() => {
      const details = document.querySelector(".group-card .group-disclosure");
      const summary = details?.querySelector(".group-summary");
      const tabList = details?.querySelector(".tab-list");
      if (!details || !summary || !tabList) return null;
      const initiallyExpanded = details.open;
      summary.click();
      const collapsed = !details.open;
      summary.click();
      return { initiallyExpanded, collapsed, expandedAgain: details.open };
    })()`);
    assert.deepEqual(managerExpansion, {
      initiallyExpanded: true,
      collapsed: true,
      expandedAgain: true,
    }, "Each group's native disclosure should collapse and restore its member tabs.");
    const collapsedGroupB = await managerClient.evaluate(`(() => {
      const card = [...document.querySelectorAll(".group-card")]
        .find((item) => item.querySelector(".group-title")?.textContent === "Group B");
      const details = card?.querySelector(".group-disclosure");
      if (!details) return false;
      details.querySelector(".group-summary").click();
      return !details.open;
    })()`);
    assert.equal(collapsedGroupB, true, "A group can remain collapsed while another group is edited.");
    const managerPaletteLayout = await managerClient.evaluate(`(() => {
      const card = [...document.querySelectorAll(".group-card")]
        .find((item) => item.querySelector(".group-title")?.textContent === "Default");
      const palette = card?.querySelector(".color-palette");
      const choices = [...(palette?.querySelectorAll(".color-choice") ?? [])];
      return { count: choices.length, rows: new Set(choices.map((item) => Math.round(item.getBoundingClientRect().top))).size,
        gap: getComputedStyle(palette).columnGap };
    })()`);
    assert.deepEqual(managerPaletteLayout, { count: 9, rows: 1, gap: "4px" },
      "The full workspace manager should keep the palette compact and on one line at desktop width.");
    await managerClient.evaluate(`(() => {
      const card = [...document.querySelectorAll(".group-card")]
        .find((item) => item.querySelector(".group-title")?.textContent === "Default");
      const green = card?.querySelector('.color-palette input[value="green"]');
      if (!green) throw new Error("Green color choice is missing from the workspace manager.");
      green.click();
    })()`);
    const recoloredInManager = await waitFor(
      () => managerClient.evaluate(`(async () => {
        const response = await chrome.runtime.sendMessage({type:"state:get"});
        const group = response?.value?.groups.find((item) => item.name === "Default");
        const card = [...document.querySelectorAll(".group-card")]
          .find((item) => item.querySelector(".group-title")?.textContent === "Default");
        return { color: group?.color, selected: card?.querySelector('.color-palette input:checked')?.value };
      })()`),
      (result) => result?.color === "green" && result.selected === "green",
      "workspace manager color selection",
    );
    assert.equal(recoloredInManager.color, "green");
    const groupBCollapsedAfterRefresh = await managerClient.evaluate(`(() => {
      const card = [...document.querySelectorAll(".group-card")]
        .find((item) => item.querySelector(".group-title")?.textContent === "Group B");
      return card?.querySelector(".group-disclosure")?.open ?? null;
    })()`);
    assert.equal(groupBCollapsedAfterRefresh, false,
      "Updating another group should preserve this group's collapsed state.");

    const qaTabUrl = "data:text/html,<title>Chromium QA Tab</title>";
    const moveTarget = await waitFor(
      () => managerClient.evaluate("(async () => { const state=(await chrome.runtime.sendMessage({type:'state:get'})).value; const record=state.tabs.find((tab)=>tab.url==="
        + JSON.stringify(qaTabUrl)
        + "&&tab.groupId==="
      + JSON.stringify(defaultGroup.id)
      + "&&tab.status==='open'); const row=[...document.querySelectorAll('.tab-row')].find((item)=>item.querySelector('.tab-url')?.textContent==="
        + JSON.stringify(qaTabUrl)
        + "); const toggle=row?.querySelector('.tab-move-toggle'); const panel=row?.querySelector('.tab-move-panel'); return record&&row?{recordId:record.id,browserTabId:record.browserTabId,moveControl:{label:toggle?.getAttribute('aria-label')??null,title:toggle?.getAttribute('title')??null,tooltip:toggle?.getAttribute('data-tooltip')??null,expanded:toggle?.getAttribute('aria-expanded')??null,panelHidden:panel?.hidden??null}}:null; })()"),
      Boolean,
      "manager renders the Default QA tab row",
    );
    assert.deepEqual(moveTarget.moveControl, {
      label: "Move Chromium QA Tab to another group",
      title: "Move to another group",
      tooltip: "Move to another group",
      expanded: "false",
      panelHidden: true,
    }, "The compact move icon should have an accessible name and tooltip, with controls initially hidden.");
    const exposedMoveControls = await managerClient.evaluate("(() => { const row=[...document.querySelectorAll('.tab-row')].find((item)=>item.querySelector('.tab-url')?.textContent==="
      + JSON.stringify(qaTabUrl)
      + "); const toggle=row?.querySelector('.tab-move-toggle'); const panel=row?.querySelector('.tab-move-panel'); const rowHeightBefore=row?.getBoundingClientRect().height; toggle?.click(); const panelRect=panel?.getBoundingClientRect(); const toggleRect=toggle?.getBoundingClientRect(); return {expanded:toggle?.getAttribute('aria-expanded'),panelHidden:panel?.hidden,rowMarkedOpen:row?.classList.contains('tab-row-move-open'),selectFocused:document.activeElement===panel?.querySelector('select'),hasMoveButton:Boolean(panel?.querySelector('button')),hasCancelButton:[...(panel?.querySelectorAll('button')??[])].some((button)=>button.textContent.trim()==='Cancel'),position:getComputedStyle(panel).position,rowHeightUnchanged:rowHeightBefore===row?.getBoundingClientRect().height,panelBeforeIcon:panelRect?.right<=toggleRect?.left}; })()");
    assert.deepEqual(exposedMoveControls, {
      expanded: "true",
      panelHidden: false,
      rowMarkedOpen: true,
      selectFocused: true,
      hasMoveButton: true,
      hasCancelButton: true,
      position: "absolute",
      rowHeightUnchanged: true,
      panelBeforeIcon: true,
    }, "Activating the move icon should reveal and focus the existing move controls.");
    const insideComponentClick = await managerClient.evaluate("(() => { const row=[...document.querySelectorAll('.tab-row')].find((item)=>item.querySelector('.tab-url')?.textContent==="
      + JSON.stringify(qaTabUrl)
      + "); const panel=row?.querySelector('.tab-move-panel'); panel?.click(); return {expanded:row?.querySelector('.tab-move-toggle')?.getAttribute('aria-expanded'),panelHidden:panel?.hidden,rowMarkedOpen:row?.classList.contains('tab-row-move-open')}; })()");
    assert.deepEqual(insideComponentClick, { expanded: "true", panelHidden: false, rowMarkedOpen: true },
      "Clicking a control inside the move component should not dismiss it.");
    const canceledMove = await managerClient.evaluate("(() => { const row=[...document.querySelectorAll('.tab-row')].find((item)=>item.querySelector('.tab-url')?.textContent==="
      + JSON.stringify(qaTabUrl)
      + "); const toggle=row?.querySelector('.tab-move-toggle'); const panel=row?.querySelector('.tab-move-panel'); [...(panel?.querySelectorAll('button')??[])].find((button)=>button.textContent.trim()==='Cancel')?.click(); return {expanded:toggle?.getAttribute('aria-expanded'),panelHidden:panel?.hidden,rowMarkedOpen:row?.classList.contains('tab-row-move-open'),focusReturned:document.activeElement===toggle}; })()");
    assert.deepEqual(canceledMove, { expanded: "false", panelHidden: true, rowMarkedOpen: false, focusReturned: true },
      "Cancel should close the move component and return focus to its toggle.");
    const outsideClickDismissal = await managerClient.evaluate("(() => { const row=[...document.querySelectorAll('.tab-row')].find((item)=>item.querySelector('.tab-url')?.textContent==="
      + JSON.stringify(qaTabUrl)
      + "); const toggle=row?.querySelector('.tab-move-toggle'); const panel=row?.querySelector('.tab-move-panel'); toggle?.click(); const opened=!panel?.hidden; document.querySelector('#status')?.click(); return {opened,expanded:toggle?.getAttribute('aria-expanded'),panelHidden:panel?.hidden,rowMarkedOpen:row?.classList.contains('tab-row-move-open')}; })()");
    assert.deepEqual(outsideClickDismissal, { opened: true, expanded: "false", panelHidden: true, rowMarkedOpen: false },
      "Clicking outside the move component should dismiss it.");
    const dragToCollapsedGroup = await dragTabToGroup(managerClient, {
      tabUrl: qaTabUrl,
      sourceGroupName: "Default",
      destinationGroupName: "Group B",
    });
    assert.deepEqual(dragToCollapsedGroup, {
      sourceGroupId: defaultGroup.id,
      destinationGroupId: destinationGroup.id,
      dragStarted: {
        draggable: true,
        recordId: moveTarget.recordId,
        rowMarkedDragging: true,
      },
      dragoverFeedback: {
        prevented: true,
        targetMarked: true,
        destinationInitiallyCollapsed: true,
      },
      dropPrevented: true,
      dragStylesCleaned: true,
    }, "Tab rows should drag onto any group card, including a collapsed card, with clear target feedback.");
    const movedByDrop = await waitFor(
      () => readState(managerClient),
      (state) => state.tabs.some((tab) => tab.id === moveTarget.recordId
        && tab.groupId === destinationGroup.id && tab.status === "closed"),
      "drag a live tab to an inactive group",
    );
    assert.equal(movedByDrop.activeGroupId, defaultGroup.id,
      "Dropping onto an inactive group should not switch the active group.");
    const expandedGroupB = await managerClient.evaluate(`(() => {
      const card = [...document.querySelectorAll(".group-card")]
        .find((item) => item.querySelector(".group-title")?.textContent === "Group B");
      const details = card?.querySelector(".group-disclosure");
      if (!details) return false;
      if (!details.open) details.querySelector(".group-summary").click();
      return details.open;
    })()`);
    assert.equal(expandedGroupB, true, "The destination group should retain the dropped tab for a reverse drag.");
    const dragBackToActiveGroup = await dragTabToGroup(managerClient, {
      tabUrl: qaTabUrl,
      sourceGroupName: "Group B",
      destinationGroupName: "Default",
    });
    assert.deepEqual(dragBackToActiveGroup, {
      sourceGroupId: destinationGroup.id,
      destinationGroupId: defaultGroup.id,
      dragStarted: {
        draggable: true,
        recordId: moveTarget.recordId,
        rowMarkedDragging: true,
      },
      dragoverFeedback: {
        prevented: true,
        targetMarked: true,
        destinationInitiallyCollapsed: false,
      },
      dropPrevented: true,
      dragStylesCleaned: true,
    }, "A saved tab should be draggable back into the active group.");
    const restoredByDrop = await waitFor(
      () => readState(managerClient),
      (state) => state.activeGroupId === defaultGroup.id
        && state.tabs.some((tab) => tab.id === moveTarget.recordId
          && tab.groupId === defaultGroup.id && tab.status === "open"
          && Number.isInteger(tab.browserTabId)),
      "drag a saved tab into the active group",
    );
    assert.ok(restoredByDrop.tabs.find((tab) => tab.id === moveTarget.recordId)?.browserTabId,
      "Moving a saved tab into the active group should restore it in the browser.");
    await waitFor(
      () => managerClient.evaluate("document.querySelector("
        + JSON.stringify(`[data-tab-id="${moveTarget.recordId}"]`)
        + ")?.closest('.group-card')?.dataset.groupId ?? null"),
      (groupId) => groupId === defaultGroup.id,
      "manager reflects the restored tab before moving it again",
    );
    await managerClient.evaluate("(() => { const row=[...document.querySelectorAll('.tab-row')].find((item)=>item.querySelector('.tab-url')?.textContent==="
      + JSON.stringify(qaTabUrl)
      + "); if(!row) throw new Error('QA tab row not found'); const toggle=row.querySelector('.tab-move-toggle'); const panel=row.querySelector('.tab-move-panel'); if(panel.hidden) toggle.click(); const select=panel.querySelector('select'); select.value="
      + JSON.stringify(destinationGroup.id)
      + "; panel.querySelector('button').click(); return true; })()");
    const moveStatus = await waitFor(
      () => managerClient.evaluate("({text:document.querySelector('#status').textContent,kind:document.querySelector('#status').dataset.kind})"),
      (status) => status.text === "Tab moved." || status.kind === "error",
      "manager move completion",
    );
    assert.notEqual(moveStatus.kind, "error", moveStatus.text);
    const movedState = await waitFor(
      () => readState(popup.client),
      (state) => state.activeGroupId === defaultGroup.id
        && state.tabs.some((tab) => tab.id === moveTarget.recordId
          && tab.groupId === destinationGroup.id && tab.status === "closed"),
      "move tab to inactive group",
    );
    const movedRecord = movedState.tabs.find((tab) => tab.id === moveTarget.recordId);
    assert.equal(movedRecord.browserTabId, null,
      "Moving to an inactive group should close the live tab. Target: " + JSON.stringify(moveTarget));

    await managerClient.evaluate("(() => { const row=document.querySelector('[data-tab-id=\"" + moveTarget.recordId
      + "\"]'); const button=row?.querySelector('.tab-delete-button'); if(!button) throw new Error('Saved tab delete button not found'); button.click(); return true; })()");
    const savedDeleteStatus = await waitFor(
      () => managerClient.evaluate("({text:document.querySelector('#status').textContent,kind:document.querySelector('#status').dataset.kind})"),
      (status) => status.text === "Tab removed from group." || status.kind === "error",
      "saved-tab deletion completion",
    );
    assert.notEqual(savedDeleteStatus.kind, "error", savedDeleteStatus.text);
    const afterSavedTabDelete = await waitFor(
      () => readState(popup.client),
      (state) => !state.tabs.some((tab) => tab.id === moveTarget.recordId) && state.operations.length === 0,
      "delete a saved inactive-group tab",
    );
    assert.ok(afterSavedTabDelete.groups.some((group) => group.id === destinationGroup.id),
      "Deleting a saved tab should leave its group in place.");

    await clickGroup(popup.client, "Group B");
    const groupAfterSavedTabDelete = await waitFor(
      () => readState(popup.client),
      (state) => state.activeGroupId === destinationGroup.id,
      "switch to group after deleting its saved tab",
    );
    assert.equal(groupAfterSavedTabDelete.tabs.some((tab) => tab.id === moveTarget.recordId), false,
      "Switching to a group should not restore a tab that was deleted from its saved snapshot.");

    await clickGroup(popup.client, "Default");
    await waitFor(() => readState(popup.client), (state) => state.activeGroupId === defaultGroup.id, "return to Default");

    const closingManagerUrl = "chrome-extension://" + extensionId + "/manager.html?window-lifecycle-test=1";
    const closingManagerWindow = await popup.client.evaluate("(async()=>{const window=await chrome.windows.create({url:"
      + JSON.stringify(closingManagerUrl)
      + ",focused:true}); const tabs=await chrome.tabs.query({windowId:window.id}); return {windowId:window.id,tabId:tabs[0].id};})()");
    const managerStateBeforeSwitch = await waitFor(
      () => readState(popup.client),
      (state) => state.tabs.some((tab) => tab.browserTabId === closingManagerWindow.tabId
        && tab.groupId === defaultGroup.id && tab.status === "open"),
      "manager tab adopted into Default before its window closes",
    );
    const closingManagerRecord = managerStateBeforeSwitch.tabs
      .find((tab) => tab.browserTabId === closingManagerWindow.tabId);
    const closingManagerTarget = await waitFor(async () => (await browserTargets(endpointUrl))
      .find((target) => target.url === closingManagerUrl) ?? null,
    Boolean, "manager page opened in a disposable window");
    const closingManagerClient = await DevToolsClient.connect(closingManagerTarget.webSocketDebuggerUrl);
    browserClients.push(closingManagerClient);
    await waitFor(() => closingManagerClient.evaluate("document.readyState"),
      (value) => value === "complete", "disposable manager page load");
    const focusedManagerWindowBeforeSwitch = await popup.client.evaluate(
      "chrome.windows.getLastFocused({populate:false}).then((window)=>window.id)",
    );
    assert.equal(focusedManagerWindowBeforeSwitch, closingManagerWindow.windowId,
      "The manager's browser window should be focused when it initiates the switch.");
    await closingManagerClient.evaluate("(() => { const button=document.querySelector('.group-card[data-group-id=\""
      + destinationGroup.id
      + "\"] .group-actions button'); if(!button || button.textContent.trim()!=='Switch to group') throw new Error('Destination group switch button not found'); button.click(); return true; })()");
    const stateAfterManagerWindowClose = await waitFor(
      () => readState(popup.client),
      (state) => state.activeGroupId === destinationGroup.id && state.operations.length === 0,
      "switch completes after its manager window closes",
    );
    const liveWindowsAfterManagerClose = await popup.client.evaluate(
      "chrome.windows.getAll({populate:false,windowTypes:['normal']}).then((windows)=>windows.map((window)=>window.id))",
    );
    assert.equal(liveWindowsAfterManagerClose.includes(closingManagerWindow.windowId), false,
      "A manager window outside the destination layout closes as part of the switch.");
    const destinationWindowIds = stateAfterManagerWindowClose.tabs
      .filter((tab) => tab.groupId === destinationGroup.id && tab.status === "open")
      .map((tab) => stateAfterManagerWindowClose.windows
        .find((window) => window.id === tab.windowId)?.browserWindowId)
      .filter(Number.isInteger);
    assert.ok(destinationWindowIds.length > 0, "The destination group should have a useful window to focus.");
    const destinationLastActiveTabIds = stateAfterManagerWindowClose.tabs
      .filter((tab) => tab.groupId === destinationGroup.id && tab.status === "open" && tab.lastActive)
      .map((tab) => tab.browserTabId)
      .filter(Number.isInteger);
    const activeDestinationTabIds = await popup.client.evaluate(
      "chrome.tabs.query({}).then((tabs)=>tabs.filter((tab)=>tab.active&&"
        + JSON.stringify(destinationLastActiveTabIds)
        + ".includes(tab.id)).map((tab)=>tab.id))",
    );
    assert.ok(activeDestinationTabIds.length > 0,
      "The destination group's last-active tab should be selected after its manager window closes.");
    const managerSnapshotAfterSwitch = stateAfterManagerWindowClose.tabs
      .find((tab) => tab.id === closingManagerRecord.id);
    if (managerSnapshotAfterSwitch) {
      const deleteManagerSnapshot = await popup.client.evaluate("chrome.runtime.sendMessage({type:'tab:delete',tabId:"
        + JSON.stringify(closingManagerRecord.id)
        + "})");
      assert.equal(deleteManagerSnapshot.ok, true, deleteManagerSnapshot.error);
    }
    const afterManagerSnapshotDelete = await waitFor(
      () => readState(popup.client),
      (state) => !state.tabs.some((tab) => tab.id === closingManagerRecord.id),
      "finish reconciling the manager tab after its containing window closes",
    );
    assert.equal(afterManagerSnapshotDelete.windows.some((window) =>
      window.id === closingManagerRecord.windowId && window.isOpen), false,
    "The closed manager window stays out of the active browser layout.");
    const restoreDefaultAfterManager = await popup.client.evaluate("chrome.runtime.sendMessage({type:'group:switch',groupId:"
      + JSON.stringify(defaultGroup.id)
      + "})");
    assert.equal(restoreDefaultAfterManager.ok, true, restoreDefaultAfterManager.error);
    await waitFor(() => readState(popup.client), (state) => state.activeGroupId === defaultGroup.id,
      "restore Default after the manager-window lifecycle check");

    await popup.client.evaluate("document.querySelector('#open-manager').click()");
    const managerAgain = await waitFor(async () => {
      const target = (await browserTargets(endpointUrl)).find((candidate) => candidate.url.endsWith("/manager.html"));
      return target ?? null;
    }, Boolean, "manager reopened");
    const managerAgainClient = await DevToolsClient.connect(managerAgain.webSocketDebuggerUrl);
    browserClients.push(managerAgainClient);
    await waitFor(() => managerAgainClient.evaluate("document.readyState"), (value) => value === "complete", "manager reload");

    const screenshotName = (process.env.BROWSER_BIN || "chromium").split("/").pop().replace(/[^a-z0-9_-]/gi, "-");
    await mkdir(artifactDirectory, { recursive: true });
    await managerAgainClient.send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 900, deviceScaleFactor: 2, mobile: false,
    });
    const retinaLogo = await waitFor(
      () => managerAgainClient.evaluate(`(() => {
        const image = document.querySelector(".brand-mark img");
        const rect = image.getBoundingClientRect();
        const managerStylesheet = [...document.styleSheets]
          .find((stylesheet) => stylesheet.href?.endsWith("/manager.css"));
        let managerStylesLoaded = false;
        try { managerStylesLoaded = Boolean(managerStylesheet?.cssRules.length); } catch {}
        return { complete: image.complete, naturalWidth: image.naturalWidth,
          cssWidth: rect.width, devicePixelRatio: window.devicePixelRatio, managerStylesLoaded };
      })()`),
      (image) => image.complete && image.naturalWidth > 0 && image.managerStylesLoaded,
      "high-resolution manager logo image",
    );
    assert.equal(retinaLogo.complete, true, "The high-resolution manager logo should load.");
    assert.equal(retinaLogo.managerStylesLoaded, true, "The manager stylesheet should load before measuring the logo.");
    assert.equal(retinaLogo.devicePixelRatio, 2);
    assert.ok(retinaLogo.naturalWidth >= retinaLogo.cssWidth * retinaLogo.devicePixelRatio,
      "The manager logo should provide at least one source pixel per rendered retina pixel: "
      + JSON.stringify(retinaLogo));
    const retinaScreenshot = await managerAgainClient.send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: false,
    });
    await writeFile(join(artifactDirectory, screenshotName + "-manager-retina.png"),
      Buffer.from(retinaScreenshot.data, "base64"));
    await managerAgainClient.send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    const wideLayout = await managerAgainClient.evaluate(
      "({viewport:window.innerWidth,content:document.documentElement.scrollWidth})",
    );
    assert.ok(wideLayout.content <= wideLayout.viewport, "Wide manager layout should not overflow horizontally.");
    await waitFor(
      () => managerAgainClient.evaluate("document.querySelectorAll('.group-card').length"),
      (count) => count > 0,
      "manager group cards rendered",
    );
    const managerColorPalette = await managerAgainClient.evaluate(`(() => {
      const card = [...document.querySelectorAll(".group-card")]
        .find((item) => item.querySelector(".group-title")?.textContent === "Default");
      const palette = card?.querySelector(".color-palette");
      return palette ? { count: palette.querySelectorAll('input[type="radio"]').length,
        selected: palette.querySelector('input[type="radio"]:checked')?.value } : null;
    })()`);
    assert.deepEqual(managerColorPalette, { count: 9, selected: "green" },
      "The full workspace manager should retain the same persistent group color palette.");
    const accessibilityTree = await managerAgainClient.send("Accessibility.getFullAXTree");
    const buttonNames = accessibilityTree.nodes
      .filter((node) => node.role?.value === "button")
      .map((node) => node.name?.value)
      .filter(Boolean);
    const buttonLabelEvidence = await managerAgainClient.evaluate(
      "[...document.querySelectorAll('button')].map((button)=>({text:button.textContent.trim(),label:button.getAttribute('aria-label'),disabled:button.disabled}))",
    );
    assert.ok(buttonNames.includes("Create group"), "The manager create action should have an accessible name.");
    assert.ok(buttonLabelEvidence.some((button) => button.label === "Delete Default group"),
      "The manager delete button should expose the affected group in its accessible label.");
    const screenshot = await managerAgainClient.send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: false,
    });
    await writeFile(join(artifactDirectory, screenshotName + "-manager.png"), Buffer.from(screenshot.data, "base64"));
    await managerAgainClient.send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: false,
    });
    const narrowLayout = await managerAgainClient.evaluate(
      "({viewport:window.innerWidth,content:document.documentElement.scrollWidth})",
    );
    assert.ok(narrowLayout.content <= narrowLayout.viewport,
      "Narrow manager layout should not overflow horizontally: " + JSON.stringify(narrowLayout));
    const narrowMoveOverlay = await managerAgainClient.evaluate(`(() => {
      const toggle = [...document.querySelectorAll(".tab-move-toggle")]
        .find((button) => !button.disabled);
      const row = toggle?.closest(".tab-row");
      const panel = row?.querySelector(".tab-move-panel");
      if (!toggle || !row || !panel) return null;
      const rowHeight = row.getBoundingClientRect().height;
      toggle.click();
      const rect = panel.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const result = {
        expanded: toggle.getAttribute("aria-expanded"),
        insideViewport: rect.left >= 0 && rect.right <= viewportWidth,
        noPageOverflow: document.documentElement.scrollWidth <= viewportWidth,
        rowHeightUnchanged: rowHeight === row.getBoundingClientRect().height,
      };
      toggle.click();
      return result;
    })()`);
    assert.deepEqual(narrowMoveOverlay, {
      expanded: "true",
      insideViewport: true,
      noPageOverflow: true,
      rowHeightUnchanged: true,
    }, "The narrow-screen move panel should float within the viewport without shifting its row.");
    const narrowScreenshot = await managerAgainClient.send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: false,
    });
    await writeFile(join(artifactDirectory, screenshotName + "-manager-narrow.png"),
      Buffer.from(narrowScreenshot.data, "base64"));
    await managerAgainClient.send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    });

    const activeDeleteBefore = await readState(managerAgainClient);
    const activeDeleteRecord = activeDeleteBefore.tabs.find((tab) => tab.id === secondTabRecord.id);
    assert.equal(activeDeleteRecord?.status, "open",
      "The active-tab delete check needs a live tab in the manager.");
    const activeDeleteControl = await managerAgainClient.evaluate(`(() => {
      const row = document.querySelector('.tab-row[data-tab-id="${secondTabRecord.id}"]');
      const button = row?.querySelector('.tab-delete-button');
      const evidence = { label: button?.getAttribute('aria-label'),
        title: button?.getAttribute('title'), width: button?.getBoundingClientRect().width };
      if (!button) throw new Error('Active tab delete button not found');
      button.click();
      return evidence;
    })()`);
    assert.equal(activeDeleteControl.label, "Delete Second QA Tab from group");
    assert.equal(activeDeleteControl.title, "Delete tab from group");
    assert.ok(activeDeleteControl.width <= 30);
    const activeDeleteStatus = await waitFor(
      () => managerAgainClient.evaluate("({text:document.querySelector('#status').textContent,kind:document.querySelector('#status').dataset.kind})"),
      (status) => status.text === "Tab removed from group." || status.kind === "error",
      "active-tab deletion completion",
    );
    assert.notEqual(activeDeleteStatus.kind, "error", activeDeleteStatus.text);
    const afterActiveTabDelete = await waitFor(
      () => readState(popup.client),
      (state) => !state.tabs.some((tab) => tab.id === secondTabRecord.id)
        && state.operations.length === 0,
      "delete the active tab without restoring it",
    );
    assert.ok(afterActiveTabDelete.groups.some((group) => group.id === defaultGroup.id),
      "Deleting an active tab must leave the workspace intact.");
    const liveIdsAfterActiveDelete = await popup.client.evaluate(
      "chrome.tabs.query({}).then((tabs)=>tabs.map((tab)=>tab.id))",
    );
    assert.equal(liveIdsAfterActiveDelete.includes(activeDeleteRecord.browserTabId), false,
      "Deleting from the active group must close the corresponding browser tab.");

    const defaultRecordsToDelete = (await readState(managerAgainClient)).tabs
      .filter((tab) => tab.groupId === defaultGroup.id && Number.isInteger(tab.browserTabId))
      .map((tab) => tab.browserTabId);
    await managerAgainClient.evaluate("(() => { window.confirm=(message)=>{window.__lastConfirm=message; return false;}; const button=document.querySelector('[aria-label=\"Delete Default group\"]'); if(!button) throw new Error('Default delete button not found'); button.click(); return true; })()");
    const cancelWarning = await managerAgainClient.evaluate("window.__lastConfirm");
    assert.match(cancelWarning, /Delete.*Default/);
    const afterCancel = await readState(popup.client);
    assert.ok(afterCancel.groups.some((group) => group.id === defaultGroup.id), "Canceling deletion must preserve the group.");

    await managerAgainClient.evaluate("(() => { window.confirm=(message)=>{window.__lastConfirm=message; return true;}; document.querySelector('[aria-label=\"Delete Default group\"]').click(); return true; })()");
    const afterDefaultDelete = await waitFor(
      () => readState(popup.client),
      (state) => !state.groups.some((group) => group.id === defaultGroup.id)
        && state.groups.filter((group) => group.name.toLocaleLowerCase() === "default").length === 1
        && state.activeGroupId !== defaultGroup.id
        && state.operations.length === 0
        && state.tabs.every((tab) => tab.groupId !== defaultGroup.id),
      "delete Default and create its empty replacement",
    );
    const replacementDefault = afterDefaultDelete.groups.find((group) => group.name === "Default");
    assert.equal(afterDefaultDelete.activeGroupId, replacementDefault.id);
    assert.equal(afterDefaultDelete.tabs.some((tab) => tab.groupId === defaultGroup.id), false);
    assert.ok(afterDefaultDelete.windows.filter((window) => window.isOpen).every((window) =>
      window.pinnedTabIds.length > 0 && window.placeholderTabId === null),
    "Deleting the active group should retain pinned windows and remove their temporary placeholders: "
      + JSON.stringify(afterDefaultDelete.windows.filter((window) => window.isOpen)));
    const liveAfterDefaultDelete = await popup.client.evaluate("chrome.tabs.query({}).then((tabs)=>tabs.map((tab)=>tab.id))");
    assert.ok(defaultRecordsToDelete.every((tabId) => !liveAfterDefaultDelete.includes(tabId)),
      "Deleting Default should close every captured open member tab.");

    await popup.client.evaluate("document.querySelector('#open-manager').click()");
    const finalManagerTarget = await waitFor(async () => {
      const target = (await browserTargets(endpointUrl)).find((candidate) => candidate.url.endsWith("/manager.html"));
      return target ?? null;
    }, Boolean, "manager opened for final deletion");
    const finalManager = await DevToolsClient.connect(finalManagerTarget.webSocketDebuggerUrl);
    browserClients.push(finalManager);
    await waitFor(() => finalManager.evaluate("document.readyState"), (value) => value === "complete", "final manager load");
    const managerTab = await finalManager.evaluate("chrome.tabs.getCurrent().then((tab)=>({id:tab.id}))");
    await popup.client.evaluate("chrome.tabs.update(" + managerTab.id + ", {pinned:true})");
    await finalManager.send("Page.reload");
    await waitFor(() => finalManager.evaluate("document.readyState"), (value) => value === "complete", "pinned manager reload");
    const beforeOtherDelete = await readState(popup.client);
    const liveBeforeOtherDelete = await popup.client.evaluate("chrome.tabs.query({}).then((tabs)=>tabs.map((tab)=>({id:tab.id,url:tab.url,pinned:tab.pinned,windowId:tab.windowId})))");
    assert.ok(beforeOtherDelete.tabs.filter((tab) => tab.groupId === destinationGroup.id)
      .every((tab) => tab.status === "closed"),
    "Inactive-group snapshots should be closed before deletion. State: " + JSON.stringify(beforeOtherDelete));
    assert.ok(liveBeforeOtherDelete.filter((tab) => !tab.pinned)
      .every((tab) => beforeOtherDelete.windows.some((window) => window.placeholderTabId === tab.id)),
    "Only placeholders should remain unpinned before the final delete. Live tabs: "
      + JSON.stringify(liveBeforeOtherDelete) + "; state: " + JSON.stringify(beforeOtherDelete));
    await finalManager.evaluate("(() => { const button=document.querySelector('[aria-label=\"Delete Group B group\"]'); if(!button) throw new Error('Group B delete button not found'); window.confirm=()=>true; button.click(); return true; })()");
    const finalState = await waitFor(
      () => readState(popup.client),
      (state) => state.groups.length === 1 && state.groups[0].name === "Default"
        && state.groups[0].id === replacementDefault.id
        && state.activeGroupId === replacementDefault.id
        && state.operations.length === 0,
      "delete final other group without restoring its tabs",
    );
    assert.ok(finalState.windows.filter((window) => window.isOpen).every((window) =>
      window.pinnedTabIds.length > 0 && window.placeholderTabId === null),
    "Deleting an inactive group should not add temporary placeholders: "
      + JSON.stringify(finalState.windows.filter((window) => window.isOpen)));
    const liveAfterOtherDelete = await popup.client.evaluate("chrome.tabs.query({}).then((tabs)=>tabs.map((tab)=>({id:tab.id,url:tab.url,pinned:tab.pinned,windowId:tab.windowId})))");
    assert.equal(finalState.tabs.length, 0,
      "Deleting the final non-Default group should not reassign its tabs. State: "
        + JSON.stringify(finalState) + "; live tabs: " + JSON.stringify(liveAfterOtherDelete)
        + "; browser events: " + JSON.stringify(await popup.client.evaluate("window.__secondWindowTrace")));
    assert.ok(finalState.windows.filter((window) => window.isOpen).every((window) =>
      window.pinnedTabIds.length > 0 || Number.isInteger(window.placeholderTabId)));

    const finalBrowserEvidence = await popup.client.evaluate("(async () => { const state=(await chrome.runtime.sendMessage({type:'state:get'})).value; const tabs=await chrome.tabs.query({}); const recent=await chrome.sessions.getRecentlyClosed({maxResults:25}); return {groups:state.groups,tabs:state.tabs,windowCount:state.windows.filter((item)=>item.isOpen).length,placeholders:state.windows.filter((item)=>item.isOpen).map((item)=>item.placeholderTabId),windowDetails:state.windows.filter((item)=>item.isOpen).map(({id,browserWindowId,pinnedTabIds,placeholderTabId})=>({id,browserWindowId,pinnedTabIds,placeholderTabId})),pinned:tabs.filter((tab)=>tab.pinned).length,recentTabSessions:recent.filter((session)=>session.tab).length,sidePanelSupported:Boolean(chrome.sidePanel?.open)}; })()");
    assert.equal(finalBrowserEvidence.groups[0].name, "Default");
    assert.equal(finalBrowserEvidence.tabs.length, 0);
    assert.equal(finalBrowserEvidence.windowCount, 2,
      "The explicitly closed nonfinal window must not be recreated after group switches.");
    assert.ok(finalBrowserEvidence.placeholders.every((tabId) => tabId === null),
      "Pinned tabs keep the remaining windows usable without extra placeholders: "
        + JSON.stringify(finalBrowserEvidence.windowDetails));
    const finalLiveWindows = await popup.client.evaluate(
      "chrome.windows.getAll({populate:true,windowTypes:['normal']}).then((windows)=>windows.filter((window)=>!window.incognito).map((window)=>({id:window.id,placeholderIds:(window.tabs??[]).filter((tab)=>tab.url?.includes('/placeholder.html')||tab.pendingUrl?.includes('/placeholder.html')).map((tab)=>tab.id)})))",
    );
    assert.equal(finalLiveWindows.length, 2);
    const openStateWindows = finalState.windows.filter((window) => window.isOpen);
    assert.equal(openStateWindows.length, 2);
    for (const stateWindow of openStateWindows) {
      const actualWindow = finalLiveWindows.find((window) => window.id === stateWindow.browserWindowId);
      assert.deepEqual(actualWindow?.placeholderIds,
        Number.isInteger(stateWindow.placeholderTabId) ? [stateWindow.placeholderTabId] : [],
        "A window's placeholder should match stored state; pinned windows need none.");
    }
    assert.ok(finalBrowserEvidence.pinned >= 3, "Pinned tabs should survive switching and remain excluded.");

    const madcssTab = await popup.client.evaluate("chrome.tabs.create({windowId:" + firstWindowId
      + ",url:'https://www.madcss.com/',active:false}).then((tab)=>({id:tab.id,url:tab.url,windowId:tab.windowId}))");
    const madcssStateBeforeClose = await waitFor(
      () => readState(popup.client),
      (state) => state.tabs.some((tab) => tab.browserTabId === madcssTab.id
        && tab.status === "open" && tab.url.includes("madcss.com")),
      "madcss.com tab adopted before close",
    );
    const madcssRecord = madcssStateBeforeClose.tabs.find((tab) => tab.browserTabId === madcssTab.id);
    const madcssTarget = await waitFor(async () => (await browserTargets(endpointUrl))
      .find((target) => target.type === "page" && target.url.includes("madcss.com")) ?? null,
    Boolean, "madcss.com browser page target");
    await popup.client.evaluate("window.__madcssCloseTrace=[];chrome.tabs.onRemoved.addListener((id,info)=>{if(id==="
      + madcssTab.id
      + ")window.__madcssCloseTrace.push({event:'tab-removed',id,isWindowClosing:info.isWindowClosing,windowId:info.windowId});});chrome.tabs.onCreated.addListener((tab)=>{if(tab.url?.includes('madcss.com')||tab.pendingUrl?.includes('madcss.com'))window.__madcssCloseTrace.push({event:'tab-created',id:tab.id,url:tab.url,pendingUrl:tab.pendingUrl});});");
    const workerBeforeClose = await waitFor(async () => (await browserTargets(endpointUrl))
      .find((target) => target.type === "service_worker"
        && target.url === "chrome-extension://" + extensionId + "/src/service-worker.js") ?? null,
    Boolean, "service worker before cold tab close");
    const workerStopped = await browserClient.send("Target.closeTarget", { targetId: workerBeforeClose.id });
    assert.equal(workerStopped.success, true);
    await waitFor(async () => !(await browserTargets(endpointUrl))
      .some((target) => target.id === workerBeforeClose.id), Boolean,
    "service worker stops before the tab close wakes it");
    const closeResult = await browserClient.send("Target.closeTarget", { targetId: madcssTarget.id });
    assert.equal(closeResult.success, true, "The browser must close the actual madcss.com tab target.");
    const madcssStateAfterClose = await waitFor(
      () => readState(popup.client),
      (state) => !state.tabs.some((tab) => tab.id === madcssRecord.id
        || tab.browserTabId === madcssTab.id || tab.url.includes("madcss.com")),
      "madcss.com browser close removes its HiddenTabby record",
    );
    await wait(500);
    assert.equal(await popup.client.evaluate("chrome.tabs.query({}).then((tabs)=>tabs.some((tab)=>tab.url?.includes('madcss.com')))") , false,
      "The original madcss.com browser tab should be gone after Target.closeTarget.");
    const workerBeforeRestart = await waitFor(async () => (await browserTargets(endpointUrl))
      .find((target) => target.type === "service_worker"
        && target.url === "chrome-extension://" + extensionId + "/src/service-worker.js") ?? null,
    Boolean, "service worker before madcss.com removal restart check");
    await browserClient.send("Target.closeTarget", { targetId: workerBeforeRestart.id });
    await waitFor(async () => !(await browserTargets(endpointUrl))
      .some((target) => target.id === workerBeforeRestart.id), Boolean,
    "service worker stops after madcss.com removal");
    const madcssStateAfterRestart = await readState(popup.client);
    assert.equal(madcssStateAfterRestart.tabs.some((tab) => tab.id === madcssRecord.id
      || tab.url.includes("madcss.com")), false,
    "Startup reconciliation should not restore a manually closed madcss.com tab.");
    const reproGroupResponse = await popup.client.evaluate("chrome.runtime.sendMessage({type:'group:create',details:{name:'Close Tab Repro'}})");
    assert.equal(reproGroupResponse.ok, true, reproGroupResponse.error);
    const reproGroup = reproGroupResponse.value.groups.find((group) => group.name === "Close Tab Repro");
    const switchAwayResponse = await popup.client.evaluate("chrome.runtime.sendMessage({type:'group:switch',groupId:" + JSON.stringify(reproGroup.id) + "})");
    assert.equal(switchAwayResponse.ok, true, switchAwayResponse.error);
    await waitFor(() => readState(popup.client), (state) => state.activeGroupId === reproGroup.id,
      "switch away from the closed madcss.com tab");
    const switchBackResponse = await popup.client.evaluate("chrome.runtime.sendMessage({type:'group:switch',groupId:" + JSON.stringify(replacementDefault.id) + "})");
    assert.equal(switchBackResponse.ok, true, switchBackResponse.error);
    const madcssStateAfterReturn = await waitFor(
      () => readState(popup.client),
      (state) => state.activeGroupId === replacementDefault.id && state.operations.length === 0,
      "return to Default after closing madcss.com",
    );
    assert.equal(madcssStateAfterClose.tabs.some((tab) => tab.id === madcssRecord.id
      || tab.url.includes("madcss.com")), false);
    assert.equal(madcssStateAfterReturn.tabs.some((tab) => tab.id === madcssRecord.id
      || tab.url.includes("madcss.com")), false,
    "Switching away and back must not recreate a manually closed madcss.com tab.");
    assert.equal(await popup.client.evaluate("chrome.tabs.query({}).then((tabs)=>tabs.some((tab)=>tab.url?.includes('madcss.com')))") , false,
      "The madcss.com page must remain closed after the workspace round trip.");
    t.diagnostic("madcss.com removal events: "
      + JSON.stringify(await popup.client.evaluate("window.__madcssCloseTrace")));
    t.diagnostic("madcss.com close result: "
      + JSON.stringify({ browserTabId: madcssTab.id, recordId: madcssRecord.id,
        before: madcssStateBeforeClose.tabs.some((tab) => tab.browserTabId === madcssTab.id),
        afterClose: madcssStateAfterClose.tabs.some((tab) => tab.id === madcssRecord.id),
        afterRestart: madcssStateAfterRestart.tabs.some((tab) => tab.id === madcssRecord.id),
        afterSwitch: madcssStateAfterReturn.tabs.some((tab) => tab.id === madcssRecord.id) }));

    t.diagnostic("Browser: " + endpoint.version.Browser);
    t.diagnostic("Loaded artifact: " + archive);
    t.diagnostic("Extension id: " + extensionId);
    t.diagnostic("Recent closed tab sessions exposed by Chromium: " + finalBrowserEvidence.recentTabSessions);
    t.diagnostic("Side panel API present: " + finalBrowserEvidence.sidePanelSupported);
    t.diagnostic("Screenshot: " + join(artifactDirectory, screenshotName + "-manager.png"));
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    for (const client of browserClients) client.close();
    if (browserProcess && browserProcess.exitCode === null) {
      try {
        process.kill(-browserProcess.pid, "SIGTERM");
      } catch {
        browserProcess.kill("SIGTERM");
      }
      await Promise.race([browserExit, wait(3000)]);
      if (browserProcess.exitCode === null) {
        try {
          process.kill(-browserProcess.pid, "SIGKILL");
        } catch {
          browserProcess.kill("SIGKILL");
        }
        await browserExit;
      }
    }
    if (fixtureServer?.listening) {
      fixtureServer.closeAllConnections();
      await new Promise((resolveClose) => fixtureServer.close(resolveClose));
    }
    try {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (cleanupError) {
      if (!testError) throw cleanupError;
    }
  }
});

test("packaged group state survives a browser restart", { timeout: 90000 }, async (t) => {
  assert.ok(process.platform === "linux", "The installed-browser E2E harness currently targets Linux.");

  const temporaryRoot = await mkdtemp(join(tmpdir(), "hiddentabby-restart-e2e-"));
  const extensionDirectory = join(temporaryRoot, "extension");
  const profileDirectory = join(temporaryRoot, "profile");
  let currentBrowser;
  let popupClient;
  let popupTargetId;
  let lifecycleWorkerClient;
  let testError;

  async function launchBrowser() {
    await rm(join(profileDirectory, "DevToolsActivePort"), { force: true });
    const child = spawn(browserPath, [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-crash-reporter",
      "--disable-breakpad",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=430,824",
      "--user-data-dir=" + profileDirectory,
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      "--disable-extensions-except=" + extensionDirectory,
      "--load-extension=" + extensionDirectory,
      "about:blank",
    ], { detached: true, stdio: "ignore" });
    const exit = new Promise((resolveExit) => child.once("exit", resolveExit));
    const endpoint = await waitFor(async () => {
      try {
        const portLine = (await readFile(join(profileDirectory, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0];
        const port = Number(portLine);
        const version = await (await fetch("http://127.0.0.1:" + port + "/json/version")).json();
        return { port, version };
      } catch {
        if (child.exitCode !== null) throw new Error("Browser exited before DevTools started.");
        return null;
      }
    }, Boolean, "restart-test DevTools endpoint", browserStartupTimeout);
    const client = await DevToolsClient.connect(endpoint.version.webSocketDebuggerUrl);
    const endpointUrl = "http://127.0.0.1:" + endpoint.port;
    const extensionId = await findExtensionId(profileDirectory, endpointUrl);
    return { child, exit, endpoint, endpointUrl, client, extensionId };
  }

  async function closeBrowser(browser, { abrupt = false } = {}) {
    if (!browser) return;
    const requestedSignal = abrupt ? "SIGKILL" : "SIGTERM";
    try {
      process.kill(-browser.child.pid, requestedSignal);
    } catch {
      browser.child.kill(requestedSignal);
    }
    if (abrupt) {
      await browser.exit;
    } else {
      await Promise.race([browser.exit, wait(3000)]);
    }
    if (browser.child.exitCode === null) {
      try {
        process.kill(-browser.child.pid, "SIGKILL");
      } catch {
        browser.child.kill("SIGKILL");
      }
      await browser.exit;
    }
    browser.client.close();
    if (abrupt && browser.child.signalCode !== "SIGKILL") {
      throw new Error("The disposable browser did not stop with SIGKILL for the crash-like restart check.");
    }
  }

  try {
    execFileSync("unzip", ["-q", archive, "-d", extensionDirectory], { stdio: "inherit" });
    currentBrowser = await launchBrowser();
    assert.match(currentBrowser.endpoint.version.Browser, /Chrom|Brave/i);
    const initialPopup = await openExtensionPage(
      currentBrowser.client,
      currentBrowser.endpointUrl,
      currentBrowser.extensionId,
      "popup.html",
    );
    popupClient = initialPopup.client;
    popupTargetId = initialPopup.target.id;
    const beforeRestart = await waitFor(
      () => readState(popupClient),
      (state) => state.groups?.some((group) => group.name === "Default"),
      "initial group state",
    );
    const defaultGroup = beforeRestart.groups.find((group) => group.name === "Default");
    const popupControllerTabId = await popupClient.evaluate("chrome.tabs.getCurrent().then((tab)=>tab.id)");
    await popupClient.evaluate("chrome.tabs.update(" + popupControllerTabId + ", {pinned:true})");
    await waitFor(
      () => readState(popupClient),
      (state) => !state.tabs.some((tab) => tab.browserTabId === popupControllerTabId)
        && state.windows.some((window) => window.pinnedTabIds.includes(popupControllerTabId)),
      "pin test controller tab before real popup switching",
    );
    const popupSwitchTabs = await popupClient.evaluate("(async()=>{const tabs=[];for(const title of ['Popup Switch One','Popup Switch Two','Manually Closed Before Switch'])tabs.push(await chrome.tabs.create({url:'data:text/html,<title>'+title+'</title>',active:false}));return tabs.map((tab)=>({id:tab.id,url:tab.url}));})()");
    const popupTabsBeforeSwitch = await waitFor(
      () => readState(popupClient),
      (state) => popupSwitchTabs.every((tab) => state.tabs.some((item) => item.browserTabId === tab.id
        && item.groupId === defaultGroup.id && item.status === "open")),
      "real-popup switch tabs adopted into Default",
    );
    const manuallyClosedPopupTab = popupSwitchTabs[2];
    await popupClient.evaluate("chrome.tabs.remove(" + manuallyClosedPopupTab.id + ")");
    await waitFor(
      () => readState(popupClient),
      (state) => !state.tabs.some((tab) => tab.browserTabId === manuallyClosedPopupTab.id),
      "manually closed popup-switch tab forgotten",
    );
    const expectedPopupRestoreIds = popupTabsBeforeSwitch.tabs
      .filter((tab) => tab.groupId === defaultGroup.id && tab.status === "open"
        && tab.browserTabId !== manuallyClosedPopupTab.id)
      .map((tab) => tab.id);
    const manuallyClosedPopupUrl = popupTabsBeforeSwitch.tabs
      .find((tab) => tab.browserTabId === manuallyClosedPopupTab.id)?.url ?? manuallyClosedPopupTab.url;
    const createResponse = await popupClient.evaluate(
      "chrome.runtime.sendMessage({type:'group:create',details:{name:'Persistent after restart'}})",
    );
    assert.equal(createResponse.ok, true, createResponse.error);
    const beforeClose = await waitFor(
      () => readState(popupClient),
      (state) => state.groups?.some((group) => group.name === "Persistent after restart"),
      "persisted test group",
    );
    const persistentGroup = beforeClose.groups.find((group) => group.name === "Persistent after restart");
    assert.equal(beforeClose.activeGroupId, defaultGroup.id, "Creating the test group must not switch the active group.");
    const storedBeforeClose = await popupClient.evaluate(
      "chrome.storage.local.get('hiddentabby.state').then((values)=>values['hiddentabby.state'])",
    );
    assert.ok(storedBeforeClose.groups.some((group) => group.id === persistentGroup.id));

    const actionPopupWorkerTarget = (await browserTargets(currentBrowser.endpointUrl))
      .find((target) => target.type === "service_worker"
        && target.url === "chrome-extension://" + currentBrowser.extensionId + "/src/service-worker.js");
    assert.ok(actionPopupWorkerTarget, "The action-popup check needs the extension service worker.");
    const actionPopupWorker = await DevToolsClient.connect(actionPopupWorkerTarget.webSocketDebuggerUrl);
    const actionPopupWindowId = await actionPopupWorker.evaluate(
      "(async()=>{const windows=await chrome.windows.getAll({populate:false,windowTypes:['normal']}); const window=windows.find((item)=>!item.incognito); if(!window)throw new Error('No normal window for action popup'); await chrome.action.openPopup({windowId:window.id}); return window.id;})()",
    );
    const actionPopupTarget = await waitFor(async () => (await browserTargets(currentBrowser.endpointUrl))
      .find((target) => target.id !== initialPopup.target.id
        && target.url === "chrome-extension://" + currentBrowser.extensionId + "/popup.html") ?? null,
    Boolean, "real action-popup page opened by chrome.action.openPopup");
    const actionPopupPage = await DevToolsClient.connect(actionPopupTarget.webSocketDebuggerUrl);
    await waitFor(() => actionPopupPage.evaluate("document.readyState"),
      (value) => value === "complete", "real action-popup page load");
    const actionPopupEvidence = await actionPopupPage.evaluate(
      "(() => { const rect=(selector)=>{const item=document.querySelector(selector);const box=item?.getBoundingClientRect();return box?{x:box.x,y:box.y,width:box.width,height:box.height,scrollWidth:item.scrollWidth,clientWidth:item.clientWidth}:null;};return {heading:document.querySelector('h1')?.textContent,width:window.outerWidth,height:window.outerHeight,viewportWidth:window.innerWidth,devicePixelRatio,bodyWidth:getComputedStyle(document.body).width,body:rect('body'),headerTitle:rect('.popup-header > div:last-child'),sectionHeading:rect('.section-heading'),groupChoice:rect('.group-choice'),createForm:rect('#create-form'),input:rect('#group-name'),addButton:rect('.add-button'),documentWidth:document.documentElement.scrollWidth,groups:[...document.querySelectorAll('.group-name')].map((item)=>item.textContent),hasCreateForm:Boolean(document.querySelector('#create-form')),windowId:" + actionPopupWindowId + "};})()",
    );
    t.diagnostic("Action popup layout: " + JSON.stringify(actionPopupEvidence));
    assert.match(actionPopupEvidence.heading, /HiddenTabby/);
    assert.ok(actionPopupEvidence.width >= 25 && actionPopupEvidence.width <= 800);
    assert.ok(actionPopupEvidence.height >= 25 && actionPopupEvidence.height <= 600);
    assert.ok(actionPopupEvidence.body.width >= 320,
      "The action popup should remain usable in a narrow browser window: " + JSON.stringify(actionPopupEvidence));
    assert.ok(actionPopupEvidence.groupChoice.x + actionPopupEvidence.groupChoice.width <= actionPopupEvidence.body.width,
      "Group rows should fit inside the action popup: " + JSON.stringify(actionPopupEvidence));
    assert.ok(actionPopupEvidence.hasCreateForm);
    assert.ok(actionPopupEvidence.groups.includes("Default"));
    const actionCreatePoint = await actionPopupPage.evaluate(
      "(() => { const form=document.querySelector('#create-form'); const input=form.querySelector('#group-name'); input.value='Action Popup Check'; const button=form.querySelector('button[type=submit]'); const rect=button.getBoundingClientRect(); return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}; })()",
    );
    await actionPopupPage.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: actionCreatePoint.x, y: actionCreatePoint.y,
    });
    await actionPopupPage.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: actionCreatePoint.x, y: actionCreatePoint.y, button: "left", clickCount: 1,
    });
    await actionPopupPage.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: actionCreatePoint.x, y: actionCreatePoint.y, button: "left", clickCount: 1,
    });
    const actionPopupGroupState = await waitFor(
      () => readState(popupClient),
      (state) => state.groups.some((group) => group.name === "Action Popup Check"),
      "group creation from the real action popup",
    );
    assert.equal(actionPopupGroupState.activeGroupId, defaultGroup.id,
      "Creating a group in the action popup must not activate it.");
    const actionPopupCheckGroup = actionPopupGroupState.groups.find((group) => group.name === "Action Popup Check");
    async function clickRealActionPopupGroup(client, groupName) {
      await waitFor(
        () => client.evaluate("[...document.querySelectorAll('.group-choice .group-name')].some((item)=>item.textContent==="
          + JSON.stringify(groupName)
          + ")"),
        Boolean,
        "action popup renders " + groupName,
      );
      const point = await client.evaluate("(() => { const button=[...document.querySelectorAll('.group-choice')].find((item)=>item.querySelector('.group-name')?.textContent==="
        + JSON.stringify(groupName)
        + "); if(!button)throw new Error('Action popup group missing: '+"
        + JSON.stringify(groupName)
        + "); const rect=button.getBoundingClientRect(); return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}; })()");
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      await client.send("Input.dispatchMouseEvent", {
        type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1,
      });
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1,
      });
    }
    await clickRealActionPopupGroup(actionPopupPage, "Action Popup Check");
    const switchedFromActionPopup = await waitFor(
      () => readState(popupClient),
      (state) => state.activeGroupId === actionPopupCheckGroup.id
        && expectedPopupRestoreIds.every((recordId) => state.tabs.find((tab) => tab.id === recordId)?.status === "closed"),
      "switch to the new empty group from the real action popup",
      25000,
    );
    assert.equal(switchedFromActionPopup.tabs.filter((tab) => tab.groupId === defaultGroup.id
      && tab.status === "closed").length, expectedPopupRestoreIds.length);
    actionPopupPage.close();
    await currentBrowser.client.send("Target.closeTarget", { targetId: actionPopupTarget.id }).catch(() => undefined);
    await waitFor(async () => !((await browserTargets(currentBrowser.endpointUrl))
      .some((target) => target.id === actionPopupTarget.id)), Boolean, "first action popup target closed");
    await actionPopupWorker.evaluate(
      "chrome.action.openPopup({windowId:" + actionPopupWindowId + "}).then(()=>true)",
    );
    const restorePopupTarget = await waitFor(async () => (await browserTargets(currentBrowser.endpointUrl))
      .find((target) => target.id !== initialPopup.target.id
        && target.url === "chrome-extension://" + currentBrowser.extensionId + "/popup.html") ?? null,
    Boolean, "real action popup reopened to restore Default");
    const restorePopupPage = await DevToolsClient.connect(restorePopupTarget.webSocketDebuggerUrl);
    await waitFor(() => restorePopupPage.evaluate("document.readyState"),
      (value) => value === "complete", "restore action popup page load");
    await clickRealActionPopupGroup(restorePopupPage, "Default");
    const restoredFromActionPopup = await waitFor(
      () => readState(popupClient),
      (state) => state.activeGroupId === defaultGroup.id
        && expectedPopupRestoreIds.every((recordId) => state.tabs.find((tab) => tab.id === recordId)?.status === "open"),
      "restore Default from the real action popup",
      25000,
    );
    const restoredPopupRecordIds = restoredFromActionPopup.tabs
      .filter((tab) => tab.groupId === defaultGroup.id && tab.status === "open")
      .map((tab) => tab.id)
      .sort();
    assert.deepEqual(restoredPopupRecordIds, [...expectedPopupRestoreIds].sort(),
      "A real action-popup round trip must not create duplicate Default snapshots.");
    const restoredPopupLiveTabs = await popupClient.evaluate("chrome.tabs.query({windowId:" + actionPopupWindowId
      + "}).then((tabs)=>tabs.filter((tab)=>!tab.pinned&&!tab.url?.includes('/placeholder.html')&&!tab.pendingUrl?.includes('/placeholder.html')).map((tab)=>({id:tab.id,url:tab.url})))");
    const restoredPopupSnapshotIds = restoredFromActionPopup.tabs
      .filter((tab) => tab.groupId === defaultGroup.id && tab.status === "open")
      .map((tab) => tab.browserTabId)
      .sort((a, b) => a - b);
    assert.deepEqual(restoredPopupLiveTabs.map((tab) => tab.id).sort((a, b) => a - b), restoredPopupSnapshotIds,
      "Every live unpinned tab in the action-popup window must match exactly one Default snapshot.");
    assert.equal(restoredPopupLiveTabs.some((tab) => tab.url === manuallyClosedPopupUrl), false,
      "A manually closed tab must remain gone after real action-popup switching.");
    restorePopupPage.close();
    await currentBrowser.client.send("Target.closeTarget", { targetId: restorePopupTarget.id }).catch(() => undefined);
    actionPopupWorker.close();

    const serviceWorkerTarget = (await browserTargets(currentBrowser.endpointUrl))
      .find((target) => target.type === "service_worker"
        && target.url === "chrome-extension://" + currentBrowser.extensionId + "/src/service-worker.js");
    assert.ok(serviceWorkerTarget, "The packaged extension service worker should be running.");
    const workerClose = await currentBrowser.client.send("Target.closeTarget", { targetId: serviceWorkerTarget.id });
    assert.equal(workerClose.success, true, "The test should stop the extension worker before waking it again.");
    await waitFor(
      async () => !(await browserTargets(currentBrowser.endpointUrl))
        .some((target) => target.id === serviceWorkerTarget.id),
      Boolean,
      "service worker termination",
    );
    const stateAfterWorkerWake = await waitFor(
      () => readState(popupClient),
      (state) => state.groups?.some((group) => group.id === persistentGroup.id),
      "state after service worker wake",
    );
    assert.equal(stateAfterWorkerWake.activeGroupId, defaultGroup.id);

    const finalWindowProbe = await popupClient.evaluate(
      "chrome.tabs.create({url:'data:text/html,<title>Final window snapshot probe</title>',active:false}).then((tab)=>({id:tab.id,url:tab.url}))",
    );
    const stateWithFinalWindowProbe = await waitFor(
      () => readState(popupClient),
      (state) => state.tabs.some((tab) => tab.browserTabId === finalWindowProbe.id),
      "final-window probe adoption",
    );
    const finalWindowProbeRecord = stateWithFinalWindowProbe.tabs
      .find((tab) => tab.browserTabId === finalWindowProbe.id);
    const originalNormalWindowIds = await popupClient.evaluate(
      "chrome.windows.getAll({populate:false,windowTypes:['normal']}).then((windows)=>windows.filter((window)=>!window.incognito).map((window)=>window.id))",
    );
    assert.ok(originalNormalWindowIds.length > 0, "The test must have at least one normal window to close.");
    const lifecycleWorkerTarget = await waitFor(
      async () => (await browserTargets(currentBrowser.endpointUrl)).find((target) => target.type === "service_worker"
        && target.url === "chrome-extension://" + currentBrowser.extensionId + "/src/service-worker.js") ?? null,
      Boolean,
      "service worker for final-window closure",
    );
    lifecycleWorkerClient = await DevToolsClient.connect(lifecycleWorkerTarget.webSocketDebuggerUrl);
    const finalWindowRemovalEvidence = await lifecycleWorkerClient.evaluate(
      "(async()=>{const before=await chrome.windows.getAll({populate:true,windowTypes:['normal']}); const normal=before.filter((window)=>!window.incognito); for(const window of normal){await new Promise((resolve,reject)=>chrome.windows.remove(window.id,()=>{const error=chrome.runtime.lastError; if(error)reject(new Error(error.message)); else resolve();}));} const after=await chrome.windows.getAll({populate:false,windowTypes:['normal']}); return {before:normal.map((window)=>window.id),after:after.filter((window)=>!window.incognito).map((window)=>window.id)};})()",
    );
    assert.deepEqual(finalWindowRemovalEvidence.before.sort(), originalNormalWindowIds.sort(),
      "The extension worker should see the same normal windows as its popup.");
    let expectedGroupIdsAfterFinalClose = stateWithFinalWindowProbe.groups.map((group) => group.id).sort();
    if (finalWindowRemovalEvidence.after.length === 0) {
      const dormantFinalWindowState = await waitFor(
        () => lifecycleWorkerClient.evaluate("chrome.storage.local.get('hiddentabby.state').then((values)=>values['hiddentabby.state'])"),
        (state) => state && originalNormalWindowIds.every((windowId) => state.windows
          .filter((window) => window.browserWindowId === windowId).every((window) => !window.isOpen))
          && state.tabs.find((tab) => tab.id === finalWindowProbeRecord.id)?.status === "closed",
        "final normal-window closure preserves saved tabs",
      );
      assert.equal(dormantFinalWindowState.tabs.find((tab) => tab.id === finalWindowProbeRecord.id)?.browserTabId, null);

      popupClient.close();
      popupClient = null;
      const reopenedController = await openExtensionPage(
        currentBrowser.client,
        currentBrowser.endpointUrl,
        currentBrowser.extensionId,
        "popup.html",
      );
      popupClient = reopenedController.client;
      popupTargetId = reopenedController.target.id;
      const controllerTab = await popupClient.evaluate("chrome.tabs.getCurrent().then((tab)=>({id:tab.id,windowId:tab.windowId}))");
      await popupClient.evaluate("chrome.tabs.update(" + controllerTab.id + ", {pinned:true})");
      await waitFor(
        () => readState(popupClient),
        (state) => state.windows.some((window) => window.browserWindowId === controllerTab.windowId
          && window.pinnedTabIds.includes(controllerTab.id)),
        "pinned external controller tab after final-window closure",
      );
      const emptyGroupResponse = await popupClient.evaluate(
        "chrome.runtime.sendMessage({type:'group:create',details:{name:'Empty after final-window close'}})",
      );
      assert.equal(emptyGroupResponse.ok, true, emptyGroupResponse.error);
      const emptyAfterFinalClose = emptyGroupResponse.value.groups
        .find((group) => group.name === "Empty after final-window close");
      expectedGroupIdsAfterFinalClose = [...expectedGroupIdsAfterFinalClose, emptyAfterFinalClose.id].sort();
      const switchAwayResponse = await popupClient.evaluate(
        "chrome.runtime.sendMessage({type:'group:switch',groupId:" + JSON.stringify(emptyAfterFinalClose.id) + "})",
      );
      assert.equal(switchAwayResponse.ok, true, switchAwayResponse.error);
      assert.equal(switchAwayResponse.value.state.activeGroupId, emptyAfterFinalClose.id);
      const switchBackResponse = await popupClient.evaluate(
        "chrome.runtime.sendMessage({type:'group:switch',groupId:" + JSON.stringify(defaultGroup.id) + "})",
      );
      assert.equal(switchBackResponse.ok, true, switchBackResponse.error);
      const restoredAfterFinalWindowClose = await waitFor(
        () => readState(popupClient),
        (state) => state.activeGroupId === defaultGroup.id && state.operations.length === 0
          && state.tabs.find((tab) => tab.id === finalWindowProbeRecord.id)?.status === "open"
          && state.windows.find((window) => window.id === finalWindowProbeRecord.windowId)?.isOpen,
        "restore saved tabs after final normal-window closure",
      );
      assert.notEqual(restoredAfterFinalWindowClose.windows.find((window) => window.id === finalWindowProbeRecord.windowId)?.browserWindowId,
        finalWindowProbeRecord.browserWindowId,
        "Closing the final normal window should recreate its saved logical window on restore.");
    } else {
      t.diagnostic("Final-window API close is unavailable in this headless browser run; retained windows: "
        + JSON.stringify(finalWindowRemovalEvidence.after));
    }

    popupClient.close();
    popupClient = null;
    lifecycleWorkerClient?.close();
    lifecycleWorkerClient = null;
    await currentBrowser.client.send("Target.closeTarget", { targetId: popupTargetId });
    await waitFor(
      async () => (await browserTargets(currentBrowser.endpointUrl))
        .find((target) => target.type === "service_worker"
          && target.url === "chrome-extension://" + currentBrowser.extensionId + "/src/service-worker.js") ?? null,
      (target) => target === null,
      "idle service-worker suspension without a debugger",
      50000,
    );
    const idleWakePage = await openExtensionPage(
      currentBrowser.client,
      currentBrowser.endpointUrl,
      currentBrowser.extensionId,
      "popup.html",
    );
    popupClient = idleWakePage.client;
    popupTargetId = idleWakePage.target.id;
    const stateAfterIdleWake = await waitFor(
      () => readState(popupClient),
      (state) => state.groups?.some((group) => group.id === persistentGroup.id),
      "state after idle worker wake",
    );
    assert.equal(stateAfterIdleWake.activeGroupId, defaultGroup.id);

    popupClient.close();
    popupClient = null;
    await currentBrowser.client.send("Target.closeTarget", { targetId: popupTargetId });
    await closeBrowser(currentBrowser, { abrupt: true });
    t.diagnostic("Stopped the disposable browser with SIGKILL to verify crash-like profile recovery.");
    currentBrowser = null;

    currentBrowser = await launchBrowser();
    assert.equal(currentBrowser.extensionId, initialPopup.target.url.match(/chrome-extension:\/\/([^/]+)/)?.[1],
      "The test profile should reload the same unpacked extension identity.");
    const restartedPopup = await openExtensionPage(
      currentBrowser.client,
      currentBrowser.endpointUrl,
      currentBrowser.extensionId,
      "popup.html",
    );
    popupClient = restartedPopup.client;
    const afterRestart = await waitFor(
      () => readState(popupClient),
      (state) => state.groups?.some((group) => group.id === persistentGroup.id),
      "state reconciliation after browser restart",
    );
    const storedAfterRestart = await popupClient.evaluate(
      "chrome.storage.local.get('hiddentabby.state').then((values)=>values['hiddentabby.state'])",
    );
    assert.deepEqual(afterRestart.groups.map((group) => group.id).sort(), expectedGroupIdsAfterFinalClose);
    assert.equal(afterRestart.activeGroupId, defaultGroup.id);
    assert.equal(afterRestart.groups.filter((group) => group.name === "Default").length, 1);
    assert.ok(afterRestart.tabs.some((tab) => tab.id === finalWindowProbeRecord.id),
      "Crash-like browser termination must preserve the final-window tab snapshot.");
    assert.ok(storedAfterRestart.groups.some((group) => group.id === persistentGroup.id));
    t.diagnostic("Restart test browser: " + currentBrowser.endpoint.version.Browser);
    t.diagnostic("Persisted group: " + persistentGroup.id);
    t.diagnostic("Extension id: " + currentBrowser.extensionId);
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    popupClient?.close();
    lifecycleWorkerClient?.close();
    await closeBrowser(currentBrowser);
    try {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (cleanupError) {
      if (!testError) throw cleanupError;
    }
  }
});

test("incognito-enabled HiddenTabby leaves private tabs outside its state", { timeout: 90000 }, async (t) => {
  assert.ok(process.platform === "linux", "The installed-browser E2E harness currently targets Linux.");

  const temporaryRoot = await mkdtemp(join(tmpdir(), "hiddentabby-incognito-e2e-"));
  const extensionDirectory = join(temporaryRoot, "extension");
  const profileDirectory = join(temporaryRoot, "profile");
  let currentBrowser;
  let popupClient;
  let testError;

  async function launchBrowser() {
    await rm(join(profileDirectory, "DevToolsActivePort"), { force: true });
    const child = spawn(browserPath, [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-crash-reporter",
      "--disable-breakpad",
      "--no-first-run",
      "--no-default-browser-check",
      "--user-data-dir=" + profileDirectory,
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      "--disable-extensions-except=" + extensionDirectory,
      "--load-extension=" + extensionDirectory,
      "about:blank",
    ], { detached: true, stdio: "ignore" });
    const exit = new Promise((resolveExit) => child.once("exit", resolveExit));
    const endpoint = await waitFor(async () => {
      try {
        const portLine = (await readFile(join(profileDirectory, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0];
        const port = Number(portLine);
        const version = await (await fetch("http://127.0.0.1:" + port + "/json/version")).json();
        return { port, version };
      } catch {
        if (child.exitCode !== null) throw new Error("Browser exited before DevTools started.");
        return null;
      }
    }, Boolean, "incognito-test DevTools endpoint", browserStartupTimeout);
    const client = await DevToolsClient.connect(endpoint.version.webSocketDebuggerUrl);
    const endpointUrl = "http://127.0.0.1:" + endpoint.port;
    const extensionId = await findExtensionId(profileDirectory, endpointUrl);
    return { child, exit, endpoint, endpointUrl, client, extensionId };
  }

  async function closeBrowser(browser) {
    if (!browser) return;
    try {
      await browser.client.send("Browser.close");
    } catch {
      // The browser may already be closing after an assertion failure.
    }
    await Promise.race([browser.exit, wait(3000)]);
    if (browser.child.exitCode === null) {
      try {
        process.kill(-browser.child.pid, "SIGTERM");
      } catch {
        browser.child.kill("SIGTERM");
      }
      await Promise.race([browser.exit, wait(3000)]);
    }
    if (browser.child.exitCode === null) {
      try {
        process.kill(-browser.child.pid, "SIGKILL");
      } catch {
        browser.child.kill("SIGKILL");
      }
      await browser.exit;
    }
    browser.client.close();
  }

  try {
    execFileSync("unzip", ["-q", archive, "-d", extensionDirectory], { stdio: "inherit" });
    currentBrowser = await launchBrowser();
    const extensionId = currentBrowser.extensionId;
    await closeBrowser(currentBrowser);
    currentBrowser = null;

    const preferencesPath = join(profileDirectory, "Default", "Preferences");
    const preferences = JSON.parse(await readFile(preferencesPath, "utf8"));
    const extensionSettings = preferences.extensions?.settings?.[extensionId];
    assert.ok(extensionSettings, "The extension should have persisted profile preferences.");
    extensionSettings.incognito = true;
    await writeFile(preferencesPath, JSON.stringify(preferences));

    currentBrowser = await launchBrowser();
    assert.equal(currentBrowser.extensionId, extensionId, "The same unpacked extension identity should survive restart.");
    const popup = await openExtensionPage(
      currentBrowser.client,
      currentBrowser.endpointUrl,
      extensionId,
      "popup.html",
    );
    popupClient = popup.client;
    const initialState = await waitFor(
      () => readState(popupClient),
      (state) => state.groups?.some((group) => group.name === "Default"),
      "Default before incognito window creation",
    );
    const privateWindow = await popupClient.evaluate(
      "chrome.windows.create({incognito:true,url:'data:text/html,<title>HiddenTabby Private Probe</title>',focused:false}).then((window)=>({id:window.id,incognito:window.incognito}))",
    );
    assert.equal(privateWindow.incognito, true, "The test profile must permit the extension to create an incognito window.");
    const privateTab = await popupClient.evaluate(
      "chrome.tabs.query({windowId:" + privateWindow.id + "}).then((tabs)=>{const tab=tabs[0];return{id:tab.id,url:tab.url,incognito:tab.incognito}})",
    );
    assert.equal(privateTab.incognito, true);
    const stateAfterPrivateTab = await waitFor(
      () => readState(popupClient),
      (state) => !state.windows.some((window) => window.browserWindowId === privateWindow.id)
        && !state.tabs.some((tab) => tab.browserTabId === privateTab.id),
      "incognito window and tab exclusion",
    );
    assert.equal(stateAfterPrivateTab.activeGroupId, initialState.activeGroupId);
    assert.ok(!stateAfterPrivateTab.tabs.some((tab) => tab.url === privateTab.url),
      "Private URLs must not be stored in HiddenTabby state.");
    t.diagnostic("Incognito access enabled in " + currentBrowser.endpoint.version.Browser);
    t.diagnostic("Private window and tab excluded from HiddenTabby state.");
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    popupClient?.close();
    await closeBrowser(currentBrowser);
    try {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (cleanupError) {
      if (!testError) throw cleanupError;
    }
  }
});

test("workspace manager pages track windows opened or detached after load", { timeout: 90000 }, async (t) => {
  assert.ok(process.platform === "linux", "The installed-browser E2E harness currently targets Linux.");

  const temporaryRoot = await mkdtemp(join(tmpdir(), "hiddentabby-window-sync-e2e-"));
  const extensionDirectory = join(temporaryRoot, "extension");
  const profileDirectory = join(temporaryRoot, "profile");
  const browserClients = [];
  let browserProcess;
  let browserExit;
  let fixtureServer;
  let testError;

  try {
    execFileSync("unzip", ["-q", archive, "-d", extensionDirectory], { stdio: "inherit" });
    browserProcess = spawn(browserPath, [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-crash-reporter",
      "--disable-breakpad",
      "--no-first-run",
      "--no-default-browser-check",
      "--user-data-dir=" + profileDirectory,
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      "--disable-extensions-except=" + extensionDirectory,
      "--load-extension=" + extensionDirectory,
      "about:blank",
    ], { detached: true, stdio: "ignore" });
    browserExit = new Promise((resolveExit) => browserProcess.once("exit", resolveExit));

    const endpoint = await waitFor(async () => {
      try {
        const portLine = (await readFile(join(profileDirectory, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0];
        const port = Number(portLine);
        const version = await (await fetch("http://127.0.0.1:" + port + "/json/version")).json();
        return { port, version };
      } catch {
        if (browserProcess.exitCode !== null) throw new Error("Browser exited before DevTools started.");
        return null;
      }
    }, Boolean, "browser DevTools endpoint", browserStartupTimeout);
    const endpointUrl = "http://127.0.0.1:" + endpoint.port;
    const browserClient = await DevToolsClient.connect(endpoint.version.webSocketDebuggerUrl);
    browserClients.push(browserClient);
    const extensionId = await findExtensionId(profileDirectory, endpointUrl);
    const firstManager = await openExtensionPage(browserClient, endpointUrl, extensionId, "manager.html");
    browserClients.push(firstManager.client);
    const firstWindowId = await firstManager.client.evaluate("chrome.tabs.getCurrent().then((tab) => tab.windowId)");
    await waitFor(() => readState(firstManager.client), (state) => state.groups?.length > 0,
      "first manager state");

    const secondManagerUrl = `chrome-extension://${extensionId}/manager.html?window-sync=${Date.now()}`;
    const secondManagerWindow = await firstManager.client.evaluate(
      "chrome.windows.create({url:" + JSON.stringify(secondManagerUrl) + ",focused:false})"
        + ".then((window)=>({windowId:window.id,tabId:window.tabs?.[0]?.id}))",
    );
    const secondManagerTarget = await waitFor(async () => (await browserTargets(endpointUrl))
      .find((target) => target.type === "page" && target.url === secondManagerUrl) ?? null,
    Boolean, "second manager in a separate browser window");
    const secondManagerClient = await DevToolsClient.connect(secondManagerTarget.webSocketDebuggerUrl);
    browserClients.push(secondManagerClient);
    await waitFor(() => secondManagerClient.evaluate("document.readyState"),
      (value) => value === "complete", "second manager load");
    await waitFor(() => readState(secondManagerClient),
      (state) => state.tabs.some((tab) => tab.browserTabId === secondManagerWindow.tabId),
      "second manager tab adoption");
    const soleManagerDeleteState = await secondManagerClient.evaluate(`(async () => {
      const state = (await chrome.runtime.sendMessage({type:'state:get'})).value;
      const record = state.tabs.find((tab) => tab.browserTabId === ${secondManagerWindow.tabId});
      const row = record && document.querySelector('.tab-row[data-tab-id="' + record.id + '"]');
      const button = row?.querySelector('.tab-delete-button');
      return { rowFound: Boolean(row), disabled: button?.disabled ?? false,
        label: button?.getAttribute('aria-label'), title: button?.getAttribute('title') };
    })()`);
    assert.equal(soleManagerDeleteState.rowFound, true,
      "The manager should render its own tab in the active group.");
    assert.equal(soleManagerDeleteState.disabled, true,
      "The only full-page Workspace Manager tab should not be deletable from itself.");
    assert.match(soleManagerDeleteState.label, /only tab in this window/i,
      "The disabled Delete button should explain why it cannot be used to assist screen-reader users.");
    assert.match(soleManagerDeleteState.title, /cannot be deleted/i,
      "The disabled Delete button should explain the restriction in its tooltip.");
    const refusedManagerDelete = await secondManagerClient.evaluate(
      "chrome.runtime.sendMessage({type:'tab:delete',tabId:" + secondManagerWindow.tabId + "})",
    );
    assert.equal(refusedManagerDelete.ok, false,
      "The service worker should reject stale delete requests for the manager's only tab.");
    assert.match(refusedManagerDelete.error, /only tab containing the Workspace Manager/i);
    assert.equal((await readState(secondManagerClient)).tabs.some((tab) => tab.browserTabId === secondManagerWindow.tabId), true,
      "The protected manager tab should remain in its workspace.");
    const finalTabWindow = await firstManager.client.evaluate(
      "chrome.windows.create({url:'data:text/html,<title>Final Tab Window</title>',focused:false})"
        + ".then((window)=>({windowId:window.id,tabId:window.tabs?.[0]?.id}))",
    );
    const finalWindowTabState = await waitFor(() => readState(firstManager.client),
      (state) => state.tabs.some((tab) => tab.browserTabId === finalTabWindow.tabId && tab.status === "open"),
      "single-tab window adoption");
    const finalWindowRecord = finalWindowTabState.tabs.find((tab) => tab.browserTabId === finalTabWindow.tabId);
    await waitFor(() => secondManagerClient.evaluate(`(() => {
      const row = document.querySelector('.tab-row[data-tab-id="${finalWindowRecord.id}"]');
      return Boolean(row && !row.querySelector('.tab-delete-button')?.disabled);
    })()`), Boolean, "manager delete control for another window's final tab");
    await secondManagerClient.evaluate(`(() => {
      const button = document.querySelector('.tab-row[data-tab-id="${finalWindowRecord.id}"] .tab-delete-button');
      if (!button) throw new Error('Final-window tab delete button not found');
      button.click();
      return true;
    })()`);
    await waitFor(async () => {
      const windows = await firstManager.client.evaluate("chrome.windows.getAll({windowTypes:['normal']}).then((items)=>items.map((item)=>item.id))");
      const state = await readState(firstManager.client);
      return { windowClosed: !windows.includes(finalTabWindow.windowId),
        tabForgotten: !state.tabs.some((tab) => tab.id === finalWindowRecord.id),
        operations: state.operations.length };
    }, (result) => result.windowClosed && result.tabForgotten && result.operations === 0,
    "Workspace Manager deletion closes a window's final browser tab");
    const popupPage = await openExtensionPage(browserClient, endpointUrl, extensionId, "popup.html");
    browserClients.push(popupPage.client);
    await waitFor(() => popupPage.client.evaluate("document.readyState"),
      (value) => value === "complete", "popup page load");

    // Ctrl+N opens a normal window with a browser New Tab page; navigating it
    // to real content should add that window and tab to the active group.
    const ctrlNWindow = await firstManager.client.evaluate(
      "chrome.windows.create({focused:false}).then((window)=>({windowId:window.id,tabId:window.tabs?.[0]?.id}))",
    );
    await waitFor(() => readState(firstManager.client),
      (state) => state.windows.some((window) => window.browserWindowId === ctrlNWindow.windowId && window.isOpen),
      "Ctrl+N window registration");
    const ctrlNUrl = "data:text/html,<title>Ctrl N Window Probe</title><h1>Ctrl N Window Probe</h1>";
    await firstManager.client.evaluate(
      "chrome.tabs.update(" + ctrlNWindow.tabId + ", {url:" + JSON.stringify(ctrlNUrl) + "})",
    );
    const ctrlNState = await waitFor(() => readState(firstManager.client),
      (state) => state.tabs.some((tab) => tab.browserTabId === ctrlNWindow.tabId
        && tab.groupId === state.activeGroupId && tab.status === "open"),
      "Ctrl+N tab assigned to active group");
    const ctrlNRecord = ctrlNState.tabs.find((tab) => tab.browserTabId === ctrlNWindow.tabId);

    // Moving a live tab across windows exercises the browser's detach/attach
    // sequence used when a tab is dragged out of its original window.
    const detachedDestination = await firstManager.client.evaluate(
      "chrome.windows.create({focused:false}).then((window)=>({windowId:window.id,tabId:window.tabs?.[0]?.id}))",
    );
    const detachedSource = await firstManager.client.evaluate(
      "chrome.tabs.create({windowId:" + firstWindowId
        + ",url:'data:text/html,<title>Detached Window Probe</title>',active:false})"
        + ".then((tab)=>({tabId:tab.id,windowId:tab.windowId}))",
    );
    await waitFor(() => readState(firstManager.client),
      (state) => state.tabs.some((tab) => tab.browserTabId === detachedSource.tabId),
      "tab before detach");
    await firstManager.client.evaluate(
      "chrome.tabs.move(" + detachedSource.tabId + ", {windowId:" + detachedDestination.windowId + ",index:-1})",
    );
    const detachedState = await waitFor(() => readState(firstManager.client),
      (state) => state.tabs.some((tab) => tab.browserTabId === detachedSource.tabId
        && tab.browserWindowId === detachedDestination.windowId),
      "tab association after detach/attach");
    const authoritativeViews = await Promise.all([firstManager.client, secondManagerClient].map(readState));
    assert.ok(authoritativeViews.every((state) => state.tabs.some((tab) => tab.id === ctrlNRecord.id)
      && state.tabs.some((tab) => tab.browserTabId === detachedSource.tabId
        && tab.browserWindowId === detachedDestination.windowId)),
    "Both manager pages should read the same persisted group/window assignments.");

    const viewEvidence = await Promise.all([firstManager.client, secondManagerClient].map((client) =>
      client.evaluate("({ctrlNRendered:Boolean(document.querySelector('[data-tab-id=\\\""
        + ctrlNRecord.id
        + "\\\"]')),detachedRendered:Boolean(document.querySelector('[data-tab-id=\\\""
        + detachedState.tabs.find((tab) => tab.browserTabId === detachedSource.tabId).id
        + "\\\"]'))})")));
    t.diagnostic("Window tracking state: " + JSON.stringify({
      ctrlNWindowId: ctrlNWindow.windowId,
      ctrlNRecord: { id: ctrlNRecord.id, browserWindowId: ctrlNRecord.browserWindowId, groupId: ctrlNRecord.groupId },
      detachedWindowId: detachedDestination.windowId,
      detachedRecord: detachedState.tabs.find((tab) => tab.browserTabId === detachedSource.tabId),
      managerViews: viewEvidence,
      popupWindowCount: await popupPage.client.evaluate("document.querySelector('#window-count')?.textContent"),
      expectedPopupWindowCount: `${detachedState.windows.filter((window) => window.isOpen).length} windows`,
    }));
    assert.ok(viewEvidence.every((view) => view.ctrlNRendered && view.detachedRendered),
      "Every open Workspace Manager should reflect new and detached group tabs without reloading.");
    assert.equal(
      await popupPage.client.evaluate("document.querySelector('#window-count')?.textContent"),
      `${detachedState.windows.filter((window) => window.isOpen).length} windows`,
      "The popup window count should track state changes while it remains open.",
    );
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    for (const client of browserClients) client.close();
    if (browserProcess && browserProcess.exitCode === null) {
      try {
        process.kill(-browserProcess.pid, "SIGTERM");
      } catch {
        browserProcess.kill("SIGTERM");
      }
      await Promise.race([browserExit, wait(3000)]);
      if (browserProcess.exitCode === null) {
        try {
          process.kill(-browserProcess.pid, "SIGKILL");
        } catch {
          browserProcess.kill("SIGKILL");
        }
        await browserExit;
      }
    }
    try {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (cleanupError) {
      if (!testError) throw cleanupError;
    }
  }
});

test("a window added to an inactive group returns on the next group switch", { timeout: 90000 }, async (t) => {
  assert.ok(process.platform === "linux", "The installed-browser E2E harness currently targets Linux.");

  const temporaryRoot = await mkdtemp(join(tmpdir(), "hiddentabby-group-window-e2e-"));
  const extensionDirectory = join(temporaryRoot, "extension");
  const profileDirectory = join(temporaryRoot, "profile");
  const browserClients = [];
  let browserProcess;
  let browserExit;
  let fixtureServer;
  let testError;

  try {
    execFileSync("unzip", ["-q", archive, "-d", extensionDirectory], { stdio: "inherit" });
    fixtureServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end("<!doctype html><title>Second Group Window Site</title><main>Second group</main>");
    });
    await new Promise((resolveListen, rejectListen) => {
      fixtureServer.once("error", rejectListen);
      fixtureServer.listen(0, "127.0.0.1", resolveListen);
    });
    fixtureServer.unref();
    const siteUrl = "http://127.0.0.1:" + fixtureServer.address().port + "/second-group-window";
    browserProcess = spawn(browserPath, [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-crash-reporter",
      "--disable-breakpad",
      "--no-first-run",
      "--no-default-browser-check",
      "--user-data-dir=" + profileDirectory,
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      "--disable-extensions-except=" + extensionDirectory,
      "--load-extension=" + extensionDirectory,
      "about:blank",
    ], { detached: true, stdio: "ignore" });
    browserExit = new Promise((resolveExit) => browserProcess.once("exit", resolveExit));

    const endpoint = await waitFor(async () => {
      try {
        const portLine = (await readFile(join(profileDirectory, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0];
        const port = Number(portLine);
        const version = await (await fetch("http://127.0.0.1:" + port + "/json/version")).json();
        return { port, version };
      } catch {
        if (browserProcess.exitCode !== null) throw new Error("Browser exited before DevTools started.");
        return null;
      }
    }, Boolean, "browser DevTools endpoint", browserStartupTimeout);
    const endpointUrl = "http://127.0.0.1:" + endpoint.port;
    const browserClient = await DevToolsClient.connect(endpoint.version.webSocketDebuggerUrl);
    browserClients.push(browserClient);
    const extensionId = await findExtensionId(profileDirectory, endpointUrl);
    const control = await openExtensionPage(browserClient, endpointUrl, extensionId, "popup.html");
    browserClients.push(control.client);
    const initialState = await waitFor(() => readState(control.client),
      (state) => state.groups?.length === 1, "first-run Default group");
    const defaultGroup = initialState.groups[0];
    const controllerTab = await control.client.evaluate(
      "chrome.tabs.getCurrent().then((tab)=>({id:tab.id,windowId:tab.windowId}))",
    );
    await control.client.evaluate("chrome.tabs.update(" + controllerTab.id + ", {pinned:true})");
    await waitFor(() => readState(control.client),
      (state) => state.windows.some((window) => window.pinnedTabIds.includes(controllerTab.id)),
      "pin the command page so it survives group switching");
    const defaultTab = await control.client.evaluate(
      "chrome.tabs.create({windowId:" + controllerTab.windowId
        + ",url:'data:text/html,<title>Default Group Anchor</title>',active:false})"
        + ".then((tab)=>({id:tab.id,url:tab.url}))",
    );
    await waitFor(() => readState(control.client),
      (state) => state.tabs.some((tab) => tab.browserTabId === defaultTab.id
        && tab.groupId === defaultGroup.id && tab.status === "open"),
      "Default group anchor tab");

    const createdGroup = await control.client.evaluate(
      "chrome.runtime.sendMessage({type:'group:create',details:{name:'Second'}})",
    );
    assert.equal(createdGroup.ok, true, createdGroup.error);
    const secondGroupId = createdGroup.value.groups.find((group) => group.name === "Second").id;
    const firstSwitch = await control.client.evaluate(
      "chrome.runtime.sendMessage({type:'group:switch',groupId:" + JSON.stringify(secondGroupId) + "})",
    );
    assert.equal(firstSwitch.ok, true, firstSwitch.error);
    assert.equal(firstSwitch.value.state.activeGroupId, secondGroupId);

    // Ctrl+N creates a normal window whose new-tab page is then navigated to a
    // real site, matching the user's scenario rather than an empty placeholder.
    const addedWindow = await control.client.evaluate(
      "chrome.windows.create({focused:false}).then((window)=>({windowId:window.id,tabId:window.tabs?.[0]?.id}))",
    );
    assert.ok(Number.isInteger(addedWindow.tabId),
      "Chrome should return the new-tab ID for the Ctrl+N-style window: " + JSON.stringify(addedWindow));
    const navigationResult = await control.client.evaluate(
      "chrome.tabs.update(" + addedWindow.tabId + ", {url:" + JSON.stringify(siteUrl) + "})",
    );
    const liveNewTab = await control.client.evaluate(
      "chrome.tabs.get(" + addedWindow.tabId + ").then((tab)=>({id:tab.id,windowId:tab.windowId,url:tab.url,pendingUrl:tab.pendingUrl}))",
    );
    t.diagnostic("Ctrl+N navigation: " + JSON.stringify({ addedWindow, navigationResult, liveNewTab, siteUrl }));
    await waitFor(() => control.client.evaluate("chrome.tabs.get(" + addedWindow.tabId
      + ").then((tab)=>tab.url)") , (url) => url === siteUrl, "Ctrl+N site navigation commit");
    const beforeSwitch = await waitFor(() => readState(control.client),
      (state) => state.tabs.some((tab) => tab.browserTabId === addedWindow.tabId
        && tab.groupId === secondGroupId && tab.status === "open" && tab.url === siteUrl),
      "new site recorded in the active second group");
    const addedRecord = beforeSwitch.tabs.find((tab) => tab.browserTabId === addedWindow.tabId);
    const originalLogicalWindowId = addedRecord.windowId;
    const originalWindow = beforeSwitch.windows.find((window) => window.id === originalLogicalWindowId);
    assert.equal(addedRecord.browserWindowId, addedWindow.windowId,
      "The new tab must initially point to its real browser window.");
    assert.equal(originalWindow?.browserWindowId, addedWindow.windowId,
      "The new tab's logical window record must point to its browser window.");

    await control.client.evaluate(`(() => {
      window.__groupWindowSwitchTrace = [];
      chrome.tabs.onRemoved.addListener((tabId, info) => window.__groupWindowSwitchTrace.push({
        event: "tab-removed", tabId, windowId: info.windowId, isWindowClosing: info.isWindowClosing,
      }));
      chrome.windows.onRemoved.addListener((windowId) => window.__groupWindowSwitchTrace.push({
        event: "window-removed", windowId,
      }));
      chrome.storage.onChanged.addListener((changes, area) => {
        const state = area === "local" ? changes["hiddentabby.state"]?.newValue : null;
        if (!state) return;
        const operation = state.operations?.find((item) => item.type === "switch-group");
        const record = state.tabs?.find((tab) => tab.id === ${JSON.stringify(addedRecord.id)});
        const logicalWindow = state.windows?.find((item) => item.id === ${JSON.stringify(originalLogicalWindowId)});
        window.__groupWindowSwitchTrace.push({
          event: "state", activeGroupId: state.activeGroupId, status: record?.status ?? "missing",
          logicalWindowOpen: logicalWindow?.isOpen,
          closeWindowIds: operation?.payload.closeWindowIds,
          windowCloseStartedIds: operation?.payload.windowCloseStartedIds,
        });
      });
    })()`);

    const switchToDefault = await control.client.evaluate(
      "chrome.runtime.sendMessage({type:'group:switch',groupId:" + JSON.stringify(defaultGroup.id) + "})",
    );
    assert.equal(switchToDefault.ok, true, switchToDefault.error);
    const immediateState = await readState(control.client);
    const switchTrace = await control.client.evaluate("window.__groupWindowSwitchTrace");
    t.diagnostic("Switch-away evidence: " + JSON.stringify({
      activeGroupId: immediateState.activeGroupId,
      tabRecord: immediateState.tabs.find((tab) => tab.id === addedRecord.id),
      logicalWindow: immediateState.windows.find((window) => window.id === originalLogicalWindowId),
      browserWindowExists: await control.client.evaluate("chrome.windows.get(" + addedWindow.windowId
        + ").then(()=>true,()=>false)"),
      switchTrace,
    }));
    const intentionalCloseCheckpointIndex = switchTrace.findIndex((event) => event.event === "state"
      && event.windowCloseStartedIds?.includes(addedWindow.windowId));
    const windowRemovedEventIndex = switchTrace.findIndex((event) => event.event === "window-removed"
      && event.windowId === addedWindow.windowId);
    assert.ok(intentionalCloseCheckpointIndex >= 0 && windowRemovedEventIndex > intentionalCloseCheckpointIndex,
      "Chrome must not close the group window until HiddenTabby has checkpointed the intentional close.");
    const afterSwitchAway = await waitFor(() => readState(control.client),
      (state) => state.activeGroupId === defaultGroup.id
        && state.tabs.some((tab) => tab.id === addedRecord.id && tab.status === "closed"),
      "new group tab saved when switching to Default");
    const dormantWindow = afterSwitchAway.windows.find((window) => window.id === originalLogicalWindowId);
    t.diagnostic("After switching away: " + JSON.stringify({
      record: afterSwitchAway.tabs.find((tab) => tab.id === addedRecord.id),
      logicalWindow: dormantWindow,
      operation: afterSwitchAway.operations.at(-1),
      browserWindowIds: (await control.client.evaluate(
        "chrome.windows.getAll({windowTypes:['normal']}).then((windows)=>windows.map((window)=>window.id))",
      )),
    }));
    assert.equal(dormantWindow?.isOpen, false,
      "The second group's additional window should close while Default is active.");

    const switchBack = await control.client.evaluate(
      "chrome.runtime.sendMessage({type:'group:switch',groupId:" + JSON.stringify(secondGroupId) + "})",
    );
    assert.equal(switchBack.ok, true, switchBack.error);
    const afterSwitchBack = await waitFor(async () => {
      const [state, liveTabs] = await Promise.all([
        readState(control.client),
        control.client.evaluate(
          "chrome.tabs.query({}).then((tabs)=>tabs.map((tab)=>({id:tab.id,windowId:tab.windowId,url:tab.url})))",
        ),
      ]);
      return { state, liveTabs };
    }, ({ state, liveTabs }) => {
      const record = state.tabs.find((tab) => tab.id === addedRecord.id);
      const logicalWindow = state.windows.find((window) => window.id === originalLogicalWindowId);
      return state.activeGroupId === secondGroupId
        && record?.status === "open"
        && record.windowId === originalLogicalWindowId
        && logicalWindow?.isOpen
        && record.browserWindowId === logicalWindow.browserWindowId
        && liveTabs.some((tab) => tab.id === record.browserTabId
          && tab.windowId === logicalWindow.browserWindowId && tab.url === siteUrl);
    }, "second group tab and logical window restored consistently", 30000);
    const restoredRecord = afterSwitchBack.state.tabs.find((tab) => tab.id === addedRecord.id);
    const restoredWindow = afterSwitchBack.state.windows.find((window) => window.id === originalLogicalWindowId);
    const visibleSiteTabs = afterSwitchBack.liveTabs.filter((tab) => tab.url === siteUrl);
    t.diagnostic("After switching back: " + JSON.stringify({
      record: restoredRecord,
      logicalWindow: restoredWindow,
      visibleSiteTabs,
      switchFailures: switchBack.value.failures,
    }));
    assert.ok(restoredWindow?.isOpen, "The logical window must be open again for its group.");
    assert.equal(restoredRecord.browserWindowId, restoredWindow.browserWindowId,
      "The restored tab and logical window should have the same current browser window ID.");
    assert.equal(visibleSiteTabs.length, 1, "The group site should be restored exactly once.");
    assert.equal(visibleSiteTabs[0].windowId, restoredWindow.browserWindowId,
      "The site should be restored into its original logical window.");
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    for (const client of browserClients) client.close();
    if (browserProcess && browserProcess.exitCode === null) {
      try {
        process.kill(-browserProcess.pid, "SIGTERM");
      } catch {
        browserProcess.kill("SIGTERM");
      }
      await Promise.race([browserExit, wait(3000)]);
      if (browserProcess.exitCode === null) {
        try {
          process.kill(-browserProcess.pid, "SIGKILL");
        } catch {
          browserProcess.kill("SIGKILL");
        }
        await browserExit;
      }
    }
    if (fixtureServer) await new Promise((resolveClose) => fixtureServer.close(resolveClose));
    try {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (cleanupError) {
      if (!testError) throw cleanupError;
    }
  }
});
