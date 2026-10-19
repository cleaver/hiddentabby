import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
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
      // Browser startup and extension initialization can briefly make reads unavailable.
    }
    await wait(100);
  }
  throw new Error(label + " timed out. Last value: " + JSON.stringify(lastValue));
}

async function browserTargets(endpoint) {
  return (await (await fetch(endpoint + "/json/list")).json());
}

test("popup group rows truncate long names without horizontal overflow", { timeout: 120000 }, async () => {
  assert.equal(process.platform, "linux", "This focused browser test currently targets Linux.");
  const profileDirectory = await mkdtemp(join(tmpdir(), "hiddentabby-popup-layout-"));
  let browserProcess;
  let browserExit;
  let browserClient;
  let popupClient;

  try {
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
      "--disable-extensions-except=" + root,
      "--load-extension=" + root,
      "about:blank",
    ], { detached: true, stdio: "ignore" });
    browserExit = new Promise((resolveExit) => browserProcess.once("exit", resolveExit));

    const port = await waitFor(async () => {
      const value = Number((await readFile(join(profileDirectory, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]);
      return Number.isInteger(value) && value > 0 ? value : null;
    }, Boolean, "browser DevTools port", browserStartupTimeout);
    const endpoint = "http://127.0.0.1:" + port;
    const version = await waitFor(async () => {
      try {
        return await (await fetch(endpoint + "/json/version")).json();
      } catch {
        return null;
      }
    }, Boolean, "browser DevTools endpoint", browserStartupTimeout);
    browserClient = await DevToolsClient.connect(version.webSocketDebuggerUrl);
    const extensionWorker = await waitFor(async () => (await browserTargets(endpoint))
      .find((target) => target.type === "service_worker" && target.url.includes("/src/service-worker.js")),
    Boolean, "HiddenTabby service worker");
    const extensionId = extensionWorker.url.match(/chrome-extension:\/\/([^/]+)/)?.[1];
    assert.ok(extensionId, "The loaded HiddenTabby extension should have an ID.");

    const created = await browserClient.send("Target.createTarget", {
      url: "chrome-extension://" + extensionId + "/popup.html",
    });
    const popupTarget = await waitFor(async () => (await browserTargets(endpoint))
      .find((target) => target.id === created.targetId), Boolean, "HiddenTabby popup page");
    popupClient = await DevToolsClient.connect(popupTarget.webSocketDebuggerUrl);
    await waitFor(() => popupClient.evaluate("document.readyState"),
      (value) => value === "complete", "popup load");
    await waitFor(() => popupClient.evaluate("chrome.runtime.sendMessage({type:'state:get'})"),
      (response) => response?.ok && response.value?.groups?.some((group) => group.name === "Default"),
      "initial HiddenTabby state");

    const longName = "This is a very long workspace name 1234";
    for (const groupName of ["Ice", longName, "Yet another group", "Catstagram"]) {
      const response = await popupClient.evaluate(
        "chrome.runtime.sendMessage({type:'group:create',details:{name:" + JSON.stringify(groupName) + "}})",
      );
      assert.ok(response?.ok, "Popup regression group should be created: " + groupName);
    }
    const fixtureTab = await popupClient.evaluate(
      "chrome.tabs.create({url:'data:text/html,<title>Popup layout fixture</title>',active:false})"
        + ".then((tab)=>({id:tab.id,windowId:tab.windowId}))",
    );
    const stateWithFixtureTab = await waitFor(
      () => popupClient.evaluate("chrome.runtime.sendMessage({type:'state:get'})"),
      (stateResponse) => stateResponse?.ok && stateResponse.value.tabs
        .some((tab) => tab.browserTabId === fixtureTab.id && tab.status === "open"),
      "popup fixture tab assignment",
    );
    const longGroup = stateWithFixtureTab.value.groups.find((group) => group.name === longName);
    assert.ok(longGroup, "The long-name group should remain in the extension state.");
    const moveResponse = await popupClient.evaluate(
      "chrome.runtime.sendMessage({type:'tab:move',tabId:" + fixtureTab.id
        + ",groupId:" + JSON.stringify(longGroup.id) + "})",
    );
    assert.ok(moveResponse?.ok, "The fixture tab should become a saved tab in the long-name group.");
    const layoutExpression = "(() => { const list=document.querySelector('#groups'); "
      + "const row=[...document.querySelectorAll('.group-choice')].find((button)=>"
      + "button.querySelector('.group-name')?.textContent===" + JSON.stringify(longName) + "); "
      + "if(!row)return null; const name=row.querySelector('.group-name'); return {"
      + "listClientWidth:list.clientWidth,listScrollWidth:list.scrollWidth,"
      + "rowClientWidth:row.clientWidth,rowScrollWidth:row.scrollWidth,"
      + "groupMeta:row.querySelector('.group-meta').textContent,"
      + "nameClientWidth:name.clientWidth,nameScrollWidth:name.scrollWidth,"
      + "nameTextOverflow:getComputedStyle(name).textOverflow}; })()";
    const layout = await waitFor(() => popupClient.evaluate(layoutExpression),
      (value) => value?.groupMeta === "0 open · 1 saved", "long-name popup layout");

    assert.equal(layout.nameTextOverflow, "ellipsis", "Long group names should remain ellipsized.");
    assert.ok(layout.nameScrollWidth > layout.nameClientWidth,
      "The long group name should be visibly truncated.");
    assert.ok(layout.rowClientWidth <= layout.listClientWidth,
      "Group rows should fit inside their list: " + JSON.stringify(layout));
    assert.ok(layout.listScrollWidth <= layout.listClientWidth,
      "The group list should not scroll horizontally: " + JSON.stringify(layout));
  } finally {
    popupClient?.close();
    browserClient?.close();
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
    await rm(profileDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
