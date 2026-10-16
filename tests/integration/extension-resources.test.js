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
    "tabs", "tabGroups", "sessions", "contextMenus", "storage", "sidePanel",
  ]));

  const resources = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    manifest.options_ui.page,
    manifest.side_panel.default_path,
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
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)];
    assert.equal(scripts.length, page === "placeholder.html" ? 0 : 1, `${page} should load only its intended script`);
    assert.equal(scripts.every((script) => !script[1].startsWith("http")), true, `${page} must not load remote executable code`);
    assert.equal(/\son[a-z]+\s*=/i.test(html), false, `${page} must not use inline event handlers`);
    const stylesheets = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+\.css)"[^>]*>/g)];
    for (const [, stylesheet] of stylesheets) {
      await assert.doesNotReject(readFile(resolve(root, stylesheet)), `missing stylesheet: ${stylesheet}`);
    }
  }

  for (const script of ["popup.js", "manager.js"]) {
    const source = await readFile(resolve(root, script), "utf8");
    assert.equal(/\.innerHTML\s*=|insertAdjacentHTML\s*\(/.test(source), false, `${script} must not inject page-derived HTML`);
  }
});
