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
  const [modelLoading, setModelLoading] = useState(true);
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

  useEffect(() => {
    const preload = bridge.preloadModel;
    if (!preload) {
      setModelLoading(false);
      return;
    }
    let cancelled = false;
    void preload()
      .catch(() => {
        // A missing model during onboarding is expected; the selector
        // handles installation and the first dictation falls back to it.
      })
      .finally(() => {
        if (!cancelled) setModelLoading(false);
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

  if (!settingsReady || modelLoading) {
    return <p role="status">Cargando modelo de voz…</p>;
  }

  if (!onboardingComplete) {
    return <OnboardingFlow bridge={bridge} initialSettings={settings} onComplete={completeOnboarding} />;
  }

  return <AppShell bridge={bridge} settings={settings} settingsReady={settingsReady} onRestartOnboarding={restartOnboarding} />;
}
