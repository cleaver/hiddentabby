export const PIN_ONBOARDING_STORAGE_KEY = "hiddentabby.pinOnboarding";

export function reconcilePinOnboardingPreference(preference, isOnToolbar) {
  if (typeof isOnToolbar !== "boolean") return null;

  const hasValidPreference = preference
    && typeof preference === "object"
    && typeof preference.dismissed === "boolean"
    && typeof preference.isOnToolbar === "boolean";

  if (!hasValidPreference) {
    return { dismissed: false, isOnToolbar };
  }

  return {
    dismissed: preference.isOnToolbar === isOnToolbar ? preference.dismissed : false,
    isOnToolbar,
  };
}

export function shouldShowPinOnboarding(preference, isOnToolbar) {
  return isOnToolbar === false
    && preference?.isOnToolbar === false
    && preference.dismissed !== true;
}
