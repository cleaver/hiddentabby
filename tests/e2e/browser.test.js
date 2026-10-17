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
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("<!doctype html><title>Placeholder Joined</title><main>Local HiddenTabby fixture</main>");
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
    const stateBeforeDormantClose = await waitFor(
      () => readState(popup.client),
      (state) => state.tabs.some((tab) => tab.browserTabId === dormantWindow.tabId
        && tab.status === "open")
        && state.windows.some((window) => window.browserWindowId === dormantWindow.windowId && window.isOpen),
      "new window tab adoption",
    );
    const dormantRecordBeforeClose = stateBeforeDormantClose.tabs
      .find((tab) => tab.browserTabId === dormantWindow.tabId);
    await popup.client.evaluate("chrome.windows.remove(" + dormantWindow.windowId + ")");
    const dormantState = await waitFor(
      () => readState(popup.client),
      (state) => {
        const record = state.tabs.find((tab) => tab.id === dormantRecordBeforeClose.id);
        const window = state.windows.find((item) => item.id === dormantRecordBeforeClose.windowId);
        return record?.status === "closed" && record.browserTabId === null && window?.isOpen === false;
      },
      "window closure preserves dormant tab snapshots",
    );
    assert.ok(dormantState.tabs.some((tab) => tab.id === dormantRecordBeforeClose.id
      && tab.groupId === defaultGroup.id && tab.status === "closed"));
    const originalDefaultRecordIds = dormantState.tabs
      .filter((tab) => tab.groupId === defaultGroup.id)
      .map((tab) => tab.id);
    await clickGroup(popup.client, "Group B");
    const switchedState = await waitFor(async () => {
      const state = await readState(popup.client);
      const tabs = await popup.client.evaluate("chrome.tabs.query({}).then((items) => items.map((tab) => ({id:tab.id,url:tab.url,pinned:tab.pinned,groupId:tab.groupId,windowId:tab.windowId})))");
      return { state, tabs };
    }, ({ state, tabs }) => state.activeGroupId === destinationGroup.id
      && state.windows.filter((window) => window.isOpen).length === 2
      && state.windows.filter((window) => window.isOpen).every((window) => Number.isInteger(window.placeholderTabId))
      && originalDefaultRecordIds.every((recordId) => state.tabs.find((tab) => tab.id === recordId)?.status === "closed")
      && !tabs.some((tab) => tab.id === firstWindowTabs.tabId || tab.id === secondWindow.tabId),
    "global switch and empty-window placeholders");
    assert.ok(switchedState.tabs.some((tab) => tab.id === firstWindowTabs.pinnedTabId && tab.pinned));
    assert.ok(switchedState.tabs.some((tab) => tab.id === secondWindow.pinnedTabId && tab.pinned));
    assert.equal(switchedState.state.windows.filter((window) => window.isOpen).length, 2);
    for (const window of switchedState.state.windows.filter((item) => item.isOpen)) {
      const placeholder = switchedState.tabs.find((tab) => tab.id === window.placeholderTabId);
      assert.ok(placeholder, "Each empty window should retain one placeholder tab.");
      assert.equal(placeholder.groupId, -1, "The New Tab placeholder must stay outside all groups.");
      assert.match(placeholder.url, /placeholder\.html/);
    }
    const closedDuplicateRecords = switchedState.state.tabs
      .filter((tab) => duplicateRecordIds.includes(tab.id))
      .map((tab) => ({ id: tab.id, index: tab.index, sessionId: tab.sessionId, status: tab.status }));
    const recentDuplicateSessions = await popup.client.evaluate("chrome.sessions.getRecentlyClosed({maxResults:25}).then((items)=>items.filter((item)=>item.tab?.url==="
      + JSON.stringify(fixtureUrl)
      + ").map((item)=>({sessionId:item.tab.sessionId,index:item.tab.index,windowId:item.tab.windowId,url:item.tab.url,lastModified:item.lastModified})))");

    const firstLogicalWindow = switchedState.state.windows.find((window) => window.browserWindowId === firstWindowId);
    const navigatedPlaceholder = await popup.client.evaluate("chrome.tabs.update("
      + firstLogicalWindow.placeholderTabId
      + ", {url:" + JSON.stringify(fixtureUrl)
      + ",active:false}).then((tab)=>({id:tab.id,url:tab.url,pendingUrl:tab.pendingUrl,groupId:tab.groupId}))");
    let promotedState;
    try {
      promotedState = await waitFor(
        () => readState(popup.client),
        (state) => state.tabs.some((tab) => tab.browserTabId === firstLogicalWindow.placeholderTabId
          && tab.groupId === destinationGroup.id && tab.status === "open")
          && state.windows.find((window) => window.id === firstLogicalWindow.id)?.placeholderTabId === null,
        "placeholder navigation promotion",
      );
    } catch (error) {
      const currentTab = await popup.client.evaluate("chrome.tabs.get("
        + firstLogicalWindow.placeholderTabId
        + ").then((tab)=>({id:tab.id,url:tab.url,pendingUrl:tab.pendingUrl,status:tab.status,groupId:tab.groupId}))");
      throw new Error(error.message + " Navigation response: " + JSON.stringify(navigatedPlaceholder)
        + "; live tab: " + JSON.stringify(currentTab));
    }
    assert.ok(promotedState.tabs.some((tab) => tab.url === fixtureUrl));

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
    const restoredDormantWindow = restoredDefaultState.windows.find(
      (window) => window.id === dormantRecordBeforeClose.windowId,
    );
    const dormantWindowPlaceholders = await popup.client.evaluate("chrome.tabs.query({windowId:"
      + restoredDormantWindow.browserWindowId
      + "}).then((tabs)=>tabs.filter((tab)=>tab.url?.includes('/placeholder.html')||tab.pendingUrl?.includes('/placeholder.html')).map((tab)=>({id:tab.id,url:tab.url,pendingUrl:tab.pendingUrl})))");
    const creationTrace = await popup.client.evaluate(
      "window.__secondWindowTrace.filter((event)=>event.event==='created')",
    );
    assert.equal(dormantWindowPlaceholders.length, 0,
      "Restoring the real group tab should remove the one placeholder created for the dormant window. Tabs: "
        + JSON.stringify(dormantWindowPlaceholders) + "; creation trace: " + JSON.stringify(creationTrace));
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
    const managerWorkspaceLayout = await managerClient.evaluate(`(() => {
      const cards = [...document.querySelectorAll(".group-card")];
      const rows = [...document.querySelectorAll(".tab-row")];
      return {
        hasSeparateTabsPanel: Boolean(document.querySelector("#tabs")),
        groupCount: cards.length,
        groupsWithTabLists: cards.filter((card) => card.querySelector(".tab-list")).length,
        tabRows: rows.length,
        tabRowsInsideGroups: rows.filter((row) => row.closest(".group-card")).length,
        rowsMatchTheirGroup: rows.every((row) => {
          const groupCard = row.closest(".group-card");
          const groupName = groupCard?.querySelector(".group-title")?.textContent;
          const meta = row.querySelector(".tab-meta")?.textContent;
          return Boolean(groupName && meta?.startsWith(groupName + " · "));
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
    assert.equal(managerWorkspaceLayout.rowsMatchTheirGroup, true,
      "Each saved tab should appear under the group named in its membership details.");
    await managerClient.send("Emulation.setDeviceMetricsOverride", {
      width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    const wideGroupLayout = await managerClient.evaluate(`(() => {
      const grid = document.querySelector("#groups");
      const cards = [...grid.querySelectorAll(":scope > .group-card")];
      const clones = [];
      while (cards.length + clones.length < 4) {
        const clone = cards[clones.length % cards.length].cloneNode(true);
        clone.dataset.layoutProbe = "true";
        clones.push(clone);
      }
      grid.append(...clones);
      const columns = new Set([...grid.querySelectorAll(":scope > .group-card")]
        .map((card) => Math.round(card.getBoundingClientRect().left)));
      clones.forEach((clone) => clone.remove());
      return {columns: columns.size, pageWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth};
    })()`);
    assert.equal(wideGroupLayout.columns, 4,
      "A wide manager should use four masonry columns when four cards are present.");
    assert.ok(wideGroupLayout.pageWidth <= wideGroupLayout.viewportWidth,
      "Four-column manager layout should not overflow horizontally: " + JSON.stringify(wideGroupLayout));
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
        + "&&item.querySelector('.tab-meta')?.textContent.startsWith('Default · Open')); const toggle=row?.querySelector('.tab-move-toggle'); const panel=row?.querySelector('.tab-move-panel'); return record&&row?{recordId:record.id,browserTabId:record.browserTabId,rowMeta:row.querySelector('.tab-meta').textContent,moveControl:{label:toggle?.getAttribute('aria-label')??null,title:toggle?.getAttribute('title')??null,tooltip:toggle?.getAttribute('data-tooltip')??null,expanded:toggle?.getAttribute('aria-expanded')??null,panelHidden:panel?.hidden??null}}:null; })()"),
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
      + "&&item.querySelector('.tab-meta')?.textContent.startsWith('Default · Open')); const toggle=row?.querySelector('.tab-move-toggle'); const panel=row?.querySelector('.tab-move-panel'); const rowHeightBefore=row?.getBoundingClientRect().height; toggle?.click(); const panelRect=panel?.getBoundingClientRect(); const toggleRect=toggle?.getBoundingClientRect(); return {expanded:toggle?.getAttribute('aria-expanded'),panelHidden:panel?.hidden,selectFocused:document.activeElement===panel?.querySelector('select'),hasMoveButton:Boolean(panel?.querySelector('button')),position:getComputedStyle(panel).position,rowHeightUnchanged:rowHeightBefore===row?.getBoundingClientRect().height,panelBeforeIcon:panelRect?.right<=toggleRect?.left}; })()");
    assert.deepEqual(exposedMoveControls, {
      expanded: "true",
      panelHidden: false,
      selectFocused: true,
      hasMoveButton: true,
      position: "absolute",
      rowHeightUnchanged: true,
      panelBeforeIcon: true,
    }, "Activating the move icon should reveal and focus the existing move controls.");
    await managerClient.evaluate("(() => { const row=[...document.querySelectorAll('.tab-row')].find((item)=>item.querySelector('.tab-url')?.textContent==="
      + JSON.stringify(qaTabUrl)
      + "&&item.querySelector('.tab-meta')?.textContent.startsWith('Default · Open')); if(!row) throw new Error('QA tab row not found'); const panel=row.querySelector('.tab-move-panel'); const select=panel.querySelector('select'); select.value="
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

    await clickGroup(popup.client, "Group B");
    const restoredMovedState = await waitFor(
      () => readState(popup.client),
      (state) => state.activeGroupId === destinationGroup.id
        && state.tabs.find((tab) => tab.id === movedRecord.id)?.status === "open",
      "restore moved tab in destination group",
      25000,
    );
    assert.ok(restoredMovedState.tabs.find((tab) => tab.id === movedRecord.id)?.browserTabId);

    await clickGroup(popup.client, "Default");
    await waitFor(() => readState(popup.client), (state) => state.activeGroupId === defaultGroup.id, "return to Default");
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
        return { complete: image.complete, naturalWidth: image.naturalWidth,
          cssWidth: rect.width, devicePixelRatio: window.devicePixelRatio };
      })()`),
      (image) => image.complete && image.naturalWidth > 0,
      "high-resolution manager logo image",
    );
    assert.equal(retinaLogo.complete, true, "The high-resolution manager logo should load.");
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
    const liveAfterOtherDelete = await popup.client.evaluate("chrome.tabs.query({}).then((tabs)=>tabs.map((tab)=>({id:tab.id,url:tab.url,pinned:tab.pinned,windowId:tab.windowId})))");
    assert.equal(finalState.tabs.length, 0,
      "Deleting the final non-Default group should not reassign its tabs. State: "
        + JSON.stringify(finalState) + "; live tabs: " + JSON.stringify(liveAfterOtherDelete)
        + "; browser events: " + JSON.stringify(await popup.client.evaluate("window.__secondWindowTrace")));
    assert.ok(finalState.windows.filter((window) => window.isOpen).every((window) => Number.isInteger(window.placeholderTabId)));

    const finalBrowserEvidence = await popup.client.evaluate("(async () => { const state=(await chrome.runtime.sendMessage({type:'state:get'})).value; const tabs=await chrome.tabs.query({}); const recent=await chrome.sessions.getRecentlyClosed({maxResults:25}); return {groups:state.groups,tabs:state.tabs,windowCount:state.windows.filter((item)=>item.isOpen).length,placeholders:state.windows.filter((item)=>item.isOpen).map((item)=>item.placeholderTabId),pinned:tabs.filter((tab)=>tab.pinned).length,recentTabSessions:recent.filter((session)=>session.tab).length,sidePanelSupported:Boolean(chrome.sidePanel?.open)}; })()");
    assert.equal(finalBrowserEvidence.groups[0].name, "Default");
    assert.equal(finalBrowserEvidence.tabs.length, 0);
    assert.equal(finalBrowserEvidence.windowCount, 3,
      "The closed test window should be recreated when its Default tab is restored.");
    assert.equal(finalBrowserEvidence.placeholders.length, 3);
    const finalLiveWindows = await popup.client.evaluate(
      "chrome.windows.getAll({populate:true,windowTypes:['normal']}).then((windows)=>windows.filter((window)=>!window.incognito).map((window)=>({id:window.id,placeholderIds:(window.tabs??[]).filter((tab)=>tab.url?.includes('/placeholder.html')||tab.pendingUrl?.includes('/placeholder.html')).map((tab)=>tab.id)})))",
    );
    assert.equal(finalLiveWindows.length, 3);
    const openStateWindows = finalState.windows.filter((window) => window.isOpen);
    assert.equal(openStateWindows.length, 3);
    for (const stateWindow of openStateWindows) {
      const actualWindow = finalLiveWindows.find((window) => window.id === stateWindow.browserWindowId);
      assert.deepEqual(actualWindow?.placeholderIds, [stateWindow.placeholderTabId],
        "Each open window should have exactly its one recorded placeholder.");
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

  async function closeBrowser(browser) {
    if (!browser) return;
    try {
      process.kill(-browser.child.pid, "SIGTERM");
    } catch {
      browser.child.kill("SIGTERM");
    }
    await Promise.race([browser.exit, wait(3000)]);
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
    await closeBrowser(currentBrowser);
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
