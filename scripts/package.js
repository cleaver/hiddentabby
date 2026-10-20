import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(root, "dist");
const archive = resolve(outputDirectory, "HiddenTabby.zip");
const extensionFiles = [
  "LICENSE",
  "manifest.json",
  "popup.html",
  "popup.css",
  "popup.js",
  "manager.html",
  "manager.css",
  "manager.js",
  "placeholder.html",
  "placeholder.css",
  "icons/manager-logo.png",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "assets/cat-paw-pointer.png",
  "src/service-worker.js",
  "src/chrome-browser.js",
  "src/group-state.js",
  "src/pin-onboarding-state.js",
  "src/state-store.js",
  "src/workspace-controller.js",
];

await mkdir(outputDirectory, { recursive: true });
await rm(archive, { force: true });
execFileSync("zip", ["-q", "-r", archive, ...extensionFiles], { cwd: root, stdio: "inherit" });
process.stdout.write(`Created dist/HiddenTabby.zip with ${extensionFiles.length} files.\n`);
