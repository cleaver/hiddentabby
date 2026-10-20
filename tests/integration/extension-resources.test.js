import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("Manifest V3 permissions and declared extension pages are present", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description.length <= 132, "Chrome Web Store description must be at most 132 characters.");
  assert.deepEqual(new Set(manifest.permissions), new Set([
    "tabs", "tabGroups", "sessions", "contextMenus", "storage",
  ]));
  assert.equal(manifest.side_panel, undefined, "The extension should not declare a side panel.");

  const resources = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    manifest.options_ui.page,
    "placeholder.html",
    "placeholder.css",
  ];
  for (const resource of resources) {
    await assert.doesNotReject(readFile(resolve(root, resource)), `missing manifest resource: ${resource}`);
  }
});

test("extension pages use local scripts and safe DOM text APIs", async () => {
  for (const page of ["popup.html", "manager.html", "placeholder.html"]) {
    const html = await readFile(resolve(root, page), "utf8");
    if (page !== "placeholder.html") {
      const logoMarkup = page === "manager.html"
        ? /<img src="icons\/manager-logo\.png" alt="">/
        : /<img src="icons\/icon48\.png" alt="">/;
      assert.match(html, logoMarkup, `${page} should show the project logo`);
    }
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)];
    assert.equal(scripts.length, page === "placeholder.html" ? 0 : 1, `${page} should load only its intended script`);
    assert.equal(scripts.every((script) => !script[1].startsWith("http")), true, `${page} must not load remote executable code`);
    assert.equal(/\son[a-z]+\s*=/i.test(html), false, `${page} must not use inline event handlers`);
    const stylesheets = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+\.css)"[^>]*>/g)];
    for (const [, stylesheet] of stylesheets) {
      await assert.doesNotReject(readFile(resolve(root, stylesheet)), `missing stylesheet: ${stylesheet}`);
    }
  }

  const managerLogo = await readFile(resolve(root, "icons/manager-logo.png"));
  assert.equal(managerLogo.readUInt32BE(16), 256, "The manager logo should have enough pixels for high-DPI displays.");
  assert.equal(managerLogo.readUInt32BE(20), 256, "The manager logo should remain square.");

  for (const script of ["popup.js", "manager.js"]) {
    const source = await readFile(resolve(root, script), "utf8");
    assert.equal(/\.innerHTML\s*=|insertAdjacentHTML\s*\(/.test(source), false, `${script} must not inject page-derived HTML`);
  }

  const manager = await readFile(resolve(root, "manager.html"), "utf8");
  assert.match(manager, /id="pin-guide"[^>]*hidden/, "The pin tip should not interrupt manager startup.");
  assert.match(manager, /id="pin-guide-dismiss"[^>]*type="checkbox"/);
  assert.match(manager, /id="pin-animation"[^>]*role="img"/);
  assert.match(manager, /class="pin-demo-paw"/, "The guide should use an orange cat paw to demonstrate the click.");
  assert.match(manager, /src="assets\/cat-paw-pointer\.png"/);
  assert.match(manager, /class="pin-demo-sparkles"/, "The pointer click should have visual feedback.");
  const pointerImage = await readFile(resolve(root, "assets/cat-paw-pointer.png"));
  assert.equal(pointerImage.readUInt32BE(16), 1024, "The pointer artwork should retain its source resolution.");
  assert.equal(pointerImage.readUInt32BE(20), 1536, "The pointer artwork should retain its source proportions.");
  assert.equal(pointerImage[25], 6, "The pointer artwork should retain its transparent background.");

  const managerScript = await readFile(resolve(root, "manager.js"), "utf8");
  assert.match(managerScript, /getUserSettings\(\)/, "The guide should use the browser's toolbar visibility setting.");
  assert.match(managerScript, /onUserSettingsChanged/, "The guide should update immediately when toolbar visibility changes.");
  const onboardingModule = await readFile(resolve(root, "src/pin-onboarding-state.js"), "utf8");
  assert.match(managerScript, /pin-onboarding-state\.js/);
  assert.match(onboardingModule, /dismissed/);

  const styles = await readFile(resolve(root, "manager.css"), "utf8");
  assert.match(styles, /@keyframes pin-paw-journey/);
  assert.match(styles, /@keyframes pin-sparkle-burst/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
});
