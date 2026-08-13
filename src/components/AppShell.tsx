import { useEffect, useRef, useState } from "react";
import { createRecordingState, type RecordingState } from "../domain/recording";
import { DEFAULT_SETTINGS, type AppSettings } from "../domain/settings";
import {
  nativeBridge,
  type DictationResult,
  type ChamuBridge,
} from "../native/commands";
import { PrivacyBadge } from "./PrivacyBadge";
import { normalizeShortcutForPlatform } from "./ShortcutField";
import { StatusBubble } from "./StatusBubble";
import { DictationTester, type DictationTesterHandle } from "./DictationTester";

interface AppShellProps {
  recordingState?: RecordingState;
  settings?: AppSettings;
  bridge?: ChamuBridge;
  onRestartOnboarding?: () => void;
}

export function AppShell({
  recordingState,
  settings = DEFAULT_SETTINGS,
  bridge,
  onRestartOnboarding,
}: AppShellProps) {
  const activeBridge = bridge ?? nativeBridge;
  const [currentRecordingState, setCurrentRecordingState] = useState<RecordingState>(
    () => recordingState ?? createRecordingState(),
  );
  const [currentSettings, setCurrentSettings] = useState<AppSettings>(settings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftSettings, setDraftSettings] = useState<AppSettings>(settings);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(null);
  const [dictationActionPending, setDictationActionPending] = useState(false);
  const [dictationStarting, setDictationStarting] = useState(false);
  const [microphoneName, setMicrophoneName] = useState<string>();
  const [shortcutCaptureActive, setShortcutCaptureActive] = useState(false);
  const [dictationResult, setDictationResult] = useState<{
    text?: DictationResult["text"];
    id: string | number;
  }>();
  const [shortcutRegistrationError, setShortcutRegistrationError] = useState<string | null>(null);
  const shortcutHandlerRef = useRef<(state: "Pressed" | "Released") => void>(() => undefined);
  const testerRef = useRef<DictationTesterHandle>(null);
  const dictationResultCounterRef = useRef(0);

  useEffect(() => {
    if (recordingState) setCurrentRecordingState(recordingState);
  }, [recordingState]);

  useEffect(() => {
    setCurrentSettings(settings);
    setDraftSettings(settings);
  }, [settings]);

  useEffect(() => {
    let cancelled = false;
    const loadMicrophoneInfo = activeBridge.getMicrophoneInfo;
    if (!loadMicrophoneInfo) return;

    void loadMicrophoneInfo().then((info) => {
      if (!cancelled) setMicrophoneName(info.name);
    }).catch(() => {
      // The tester renders the safe system fallback when the native probe is unavailable.
    });

    return () => {
      cancelled = true;
    };
  }, [activeBridge]);

  function openSettings() {
    setDraftSettings(currentSettings);
    setSettingsError(null);
    setSettingsOpen(true);
  }

  async function saveSettings() {
    setSavingSettings(true);
    setSettingsError(null);
    try {
      await activeBridge.saveSettings(draftSettings);
      setCurrentSettings(draftSettings);
      setSettingsOpen(false);
    } catch (error: unknown) {
      setSettingsError(error instanceof Error ? error.message : "No se pudo guardar la configuración");
    } finally {
      setSavingSettings(false);
    }
  }

  function handleTesterSettingsChange(nextSettings: AppSettings) {
    setCurrentSettings(nextSettings);
    setDraftSettings(nextSettings);
    setSettingsSaveError(null);
    void activeBridge.saveSettings(nextSettings).catch((error: unknown) => {
      setSettingsSaveError(getErrorMessage(error, "No se pudo guardar la configuración"));
    });
  }

  function restartOnboarding() {
    setSettingsOpen(false);
    onRestartOnboarding?.();
  }

  async function handleDictation() {
    if (dictationActionPending || dictationStarting || currentRecordingState.status === "transcribing") return;

    if (currentRecordingState.status === "recording") {
      await stopDictation();
      return;
    }

    testerRef.current?.prepareForDictation();
    await startDictation();
  }

  shortcutHandlerRef.current = (state) => {
    if (state === "Pressed") {
      if (currentSettings.mode === "toggle" || currentRecordingState.status !== "recording") {
        void handleDictation();
      }
      return;
    }
    if (currentSettings.mode === "hold" && currentRecordingState.status === "recording") {
      void stopDictation();
    }
  };

  useEffect(() => {
    if (
      shortcutCaptureActive
      || typeof window === "undefined"
      || !("__TAURI_INTERNALS__" in window)
    ) return;

    let disposed = false;
    const shortcut = normalizeShortcutForPlatform(currentSettings.shortcut);
    let registered = false;
    let unregisterStarted = false;
    let unregisterShortcut: ((shortcut: string) => Promise<void>) | undefined;

    async function unregisterIfRegistered() {
      if (!registered || unregisterStarted || !unregisterShortcut) return;
      unregisterStarted = true;
      try {
        await unregisterShortcut(shortcut);
      } catch {
        // The shortcut is already outside this component's lifecycle.
      }
    }

    const registration = import("@tauri-apps/plugin-global-shortcut").then(async ({ register, unregister }) => {
      unregisterShortcut = unregister;
      if (disposed) return;

      try {
        await register(shortcut, (event) => shortcutHandlerRef.current(event.state));
        registered = true;
        if (disposed) {
          await unregisterIfRegistered();
        } else {
          setShortcutRegistrationError(null);
        }
      } catch (error: unknown) {
        if (!disposed) setShortcutRegistrationError(getErrorMessage(error, "No se pudo registrar el atajo global"));
      }
    }).catch((error: unknown) => {
      if (!disposed) setShortcutRegistrationError(getErrorMessage(error, "No se pudo registrar el atajo global"));
    });

    return () => {
      disposed = true;
      void registration.then(() => unregisterIfRegistered()).catch(() => undefined);
    };
  }, [currentSettings.shortcut, shortcutCaptureActive]);

  async function startDictation() {
    setDictationStarting(true);
    setDictationActionPending(true);
    try {
      if (!activeBridge.startDictation) {
        throw new Error("El dictado nativo no está disponible");
      }
      const result = await activeBridge.startDictation();
      applyDictationResult(result, "recording");
    } catch (error: unknown) {
      setCurrentRecordingState({ status: "error", message: getErrorMessage(error, "No se pudo iniciar el dictado") });
    } finally {
      setDictationStarting(false);
      setDictationActionPending(false);
    }
  }

  async function stopDictation() {
    setCurrentRecordingState({ status: "transcribing" });
    setDictationActionPending(true);
    try {
      if (!activeBridge.stopDictation) {
        throw new Error("El dictado nativo no está disponible");
      }
      const result = await activeBridge.stopDictation();
      applyDictationResult(result, "transcribing");
    } catch (error: unknown) {
      setCurrentRecordingState({ status: "error", message: getErrorMessage(error, "No se pudo transcribir el dictado") });
    } finally {
      setDictationActionPending(false);
    }
  }

  function applyDictationResult(result: DictationResult | void, fallbackStatus: "recording" | "transcribing") {
    if (!result) {
      setCurrentRecordingState({ status: fallbackStatus });
      return;
    }

    switch (result.status) {
      case "ready":
        setCurrentRecordingState({ status: "ready" });
        return;
      case "recording":
        setCurrentRecordingState({ status: "recording" });
        return;
      case "transcribing":
        setCurrentRecordingState({ status: "transcribing" });
        return;
      case "copied":
        setCurrentRecordingState({ status: "copied" });
        const resultId = result.historyEntry?.id ?? ++dictationResultCounterRef.current;
        setDictationResult({ text: result.text, id: resultId });
        return;
      case "error":
        setCurrentRecordingState({
          status: "error",
          message: result.message ?? "No se pudo completar el dictado",
        });
        return;
    }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span aria-hidden="true" className="brand-mark">◌</span>
          <div>
            <h1>Chamu</h1>
            <p>Tu voz, en tus manos</p>
          </div>
        </div>
        <div className="header-actions">
          <button className="settings-button" onClick={openSettings} type="button" aria-label="Abrir configuración">
            <SettingsIcon />
            <span>Configuración</span>
          </button>
        </div>
      </header>

      <div className="app-content">
        <PrivacyBadge />
        <section className="welcome-card" aria-labelledby="welcome-title">
          <p className="eyebrow">DICTADO LOCAL</p>
          <h2 id="welcome-title">Habla. Chamu escribe.</h2>
          <p className="welcome-copy">
            Tu audio se procesa en este equipo y nunca se guarda. Empieza cuando quieras.
          </p>
          <StatusBubble state={currentRecordingState} />
        </section>
        <DictationTester
          ref={testerRef}
          settings={currentSettings}
          onSettingsChange={handleTesterSettingsChange}
          state={currentRecordingState}
          pending={dictationActionPending}
          starting={dictationStarting}
          microphoneName={microphoneName}
          onDictationClick={() => void handleDictation()}
          resultText={dictationResult?.text}
          resultId={dictationResult?.id}
          shortcutRegistrationError={shortcutRegistrationError}
          onShortcutRegistrationError={(message) => setShortcutRegistrationError(message ?? null)}
          onCapturingChange={setShortcutCaptureActive}
        />
        {settingsSaveError && <p className="error-message" role="alert">{settingsSaveError}</p>}
      </div>

      {settingsOpen && (
        <section className="settings-panel" role="dialog" aria-label="Configuración">
          <div className="settings-panel__header">
            <div>
              <p className="eyebrow">PREFERENCIAS</p>
              <h2>Configuración</h2>
            </div>
            <button className="icon-button" onClick={() => setSettingsOpen(false)} type="button" aria-label="Cerrar configuración"><CloseIcon /></button>
          </div>
          <fieldset className="choice-list">
            <legend>Idioma</legend>
            <label className="choice-card">
              <input checked={draftSettings.language === "es"} name="settings-language" onChange={() => setDraftSettings((current) => ({ ...current, language: "es" }))} type="radio" value="es" />
              <span><strong>Español</strong><small>Interfaz y dictado en español</small></span>
            </label>
            <label className="choice-card">
              <input checked={draftSettings.language === "en"} name="settings-language" onChange={() => setDraftSettings((current) => ({ ...current, language: "en" }))} type="radio" value="en" />
              <span><strong>English</strong><small>Interfaz y dictado en inglés</small></span>
            </label>
          </fieldset>
          {settingsError && <p className="error-message">{settingsError}</p>}
          <div className="settings-panel__actions">
            <button className="secondary-button" onClick={() => setSettingsOpen(false)} type="button">Cancelar</button>
            <button className="primary-button" disabled={savingSettings} onClick={() => void saveSettings()} type="button">{savingSettings ? "Guardando…" : "Guardar configuración"}</button>
            <button className="secondary-button" onClick={restartOnboarding} type="button">Reiniciar onboarding</button>
          </div>
        </section>
      )}

      <footer className="app-footer">
        <span>Sin cuentas · Sin telemetría · Sin nube</span>
        <span>v0.1.5</span>
      </footer>
    </main>
  );
}

function SettingsIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="square" strokeWidth="2" viewBox="0 0 24 24" width="16" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.64 5.64l1.41 1.41M16.95 16.95l1.41 1.41M18.36 5.64l-1.41 1.41M7.05 16.95l-1.41 1.41" stroke="currentColor" strokeLinecap="square" strokeWidth="2" />
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeLinecap="square" strokeWidth="2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="square" strokeWidth="2" viewBox="0 0 24 24" width="16" xmlns="http://www.w3.org/2000/svg">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeLinecap="square" strokeWidth="2" />
    </svg>
  );
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
