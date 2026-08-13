import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS, type AppSettings } from "./domain/settings";
import { nativeBridge, type ChamuBridge } from "./native/commands";
import { AppShell } from "./components/AppShell";
import { OnboardingFlow } from "./components/OnboardingFlow";

const ONBOARDING_STORAGE_KEY = "chamu:onboarding-complete";

export interface AppProps {
  bridge?: ChamuBridge;
  forceOnboarding?: boolean;
}

export default function App({ bridge = nativeBridge, forceOnboarding = false }: AppProps) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [onboardingComplete, setOnboardingComplete] = useState(() => {
    if (forceOnboarding || typeof window === "undefined") return false;
    return window.localStorage.getItem(ONBOARDING_STORAGE_KEY) === "true";
  });

  useEffect(() => {
    let cancelled = false;
    setSettingsReady(false);
    void bridge.loadSettings().then((loadedSettings) => {
      if (!cancelled) {
        setSettings(loadedSettings);
        setSettingsReady(true);
      }
    }).catch(() => {
      // The UI keeps safe local defaults when the native store is unavailable.
      // This path is also used by the browser preview; no telemetry is sent.
      if (!cancelled) setSettingsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  function completeOnboarding(nextSettings: AppSettings) {
    setSettings(nextSettings);
    setOnboardingComplete(true);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
    }
  }

  function restartOnboarding() {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    }
    setOnboardingComplete(false);
  }

  if (!settingsReady) {
    return <p role="status">Cargando configuración…</p>;
  }

  if (!onboardingComplete) {
    return <OnboardingFlow bridge={bridge} initialSettings={settings} onComplete={completeOnboarding} />;
  }

  return <AppShell bridge={bridge} settings={settings} settingsReady={settingsReady} onRestartOnboarding={restartOnboarding} />;
}
