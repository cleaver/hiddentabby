import test from "node:test";
import assert from "node:assert/strict";
import {
  PIN_ONBOARDING_STORAGE_KEY,
  reconcilePinOnboardingPreference,
  shouldShowPinOnboarding,
} from "../../src/pin-onboarding-state.js";

test("pin onboarding is visible only when the extension is unpinned and not dismissed", () => {
  const unpinned = reconcilePinOnboardingPreference(undefined, false);

  assert.equal(PIN_ONBOARDING_STORAGE_KEY, "hiddentabby.pinOnboarding");
  assert.deepEqual(unpinned, { dismissed: false, isOnToolbar: false });
  assert.equal(shouldShowPinOnboarding(unpinned, false), true);
  assert.equal(shouldShowPinOnboarding({ dismissed: false, isOnToolbar: true }, true), false);
  assert.equal(shouldShowPinOnboarding({ dismissed: false, isOnToolbar: false }, true), false);
});

test("dismissal persists until the pin state changes", () => {
  const dismissed = { dismissed: true, isOnToolbar: false };

  assert.equal(shouldShowPinOnboarding(dismissed, false), false);
  assert.deepEqual(reconcilePinOnboardingPreference(dismissed, false), dismissed);
  assert.deepEqual(reconcilePinOnboardingPreference(dismissed, true), {
    dismissed: false,
    isOnToolbar: true,
  });
  assert.deepEqual(reconcilePinOnboardingPreference({ dismissed: true, isOnToolbar: true }, false), {
    dismissed: false,
    isOnToolbar: false,
  });
});

test("invalid or unavailable settings fail closed", () => {
  assert.equal(reconcilePinOnboardingPreference({}, undefined), null);
  assert.deepEqual(reconcilePinOnboardingPreference({ dismissed: "yes", isOnToolbar: false }, false), {
    dismissed: false,
    isOnToolbar: false,
  });
  assert.equal(shouldShowPinOnboarding(undefined, false), false);
});
