import assert from "node:assert/strict";
import test from "node:test";
import {
  createUnloadRestoredTabsSetting,
  UNLOAD_RESTORED_TABS_STORAGE_KEY,
} from "../../src/settings.js";

test("unloading restored background tabs is enabled when no preference is saved", async () => {
  const setting = createUnloadRestoredTabsSetting({ get: async () => ({}) });

  assert.equal(await setting(), true);
});

test("a saved keep-loaded preference opts out of unloading", async () => {
  const setting = createUnloadRestoredTabsSetting({
    get: async () => ({ [UNLOAD_RESTORED_TABS_STORAGE_KEY]: false }),
  });

  assert.equal(await setting(), false);
});

test("a saved enabled preference keeps unloading enabled", async () => {
  const setting = createUnloadRestoredTabsSetting({
    get: async () => ({ [UNLOAD_RESTORED_TABS_STORAGE_KEY]: true }),
  });

  assert.equal(await setting(), true);
});

test("unloading stays enabled when the saved preference cannot be read", async () => {
  const setting = createUnloadRestoredTabsSetting({ get: async () => { throw new Error("storage unavailable"); } });

  assert.equal(await setting(), true);
});
