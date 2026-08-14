import { useEffect, useRef, useState } from "react";
import { createRecordingState, type RecordingState } from "../domain/recording";
import { DEFAULT_SETTINGS, type AppSettings } from "../domain/settings";
import {
  nativeBridge,
  type DictationResult,
  type ChamuBridge,
  type PlatformDiagnosis,
  type WaylandHoldShortcutEvent,
  shouldRequestWaylandShortcutConfiguration,
} from "../native/commands";
import { PrivacyBadge } from "./PrivacyBadge";
import { normalizeShortcutForPlatform } from "./ShortcutField";
import { StatusBubble } from "./StatusBubble";
import { DictationTester, type DictationTesterHandle } from "./DictationTester";

interface AppShellProps {
  recordingState?: RecordingState;
  settings?: AppSettings;
  bridge?: ChamuBridge;
  settingsReady?: boolean;
  onRestartOnboarding?: () => void;
}

export function AppShell({
  recordingState,
  settings = DEFAULT_SETTINGS,
  bridge,
  settingsReady = true,
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
    pasted?: boolean;
    id: string | number;
  }>();
  const [shortcutRegistrationError, setShortcutRegistrationError] = useState<string | null>(null);
  const [platformDiagnosis, setPlatformDiagnosis] = useState<PlatformDiagnosis>();
  const [platformDiagnosisReady, setPlatformDiagnosisReady] = useState(false);
  const [waylandShortcutStatus, setWaylandShortcutStatus] = useState<WaylandHoldShortcutEvent>();
  const shortcutHandlerRef = useRef<(state: "Pressed" | "Released") => void>(() => undefined);
  const waylandShortcutHandlerRef = useRef<(event: WaylandHoldShortcutEvent) => void>(() => undefined);
  const testerRef = useRef<DictationTesterHandle>(null);
  const dictationResultCounterRef = useRef(0);
  const currentRecordingStateRef = useRef(currentRecordingState);
  const dictationActionPendingRef = useRef(dictationActionPending);
  const dictationStartingRef = useRef(dictationStarting);
  const waylandReleasePendingRef = useRef(false);
  const waylandDictationOwnedRef = useRef(false);
  const waylandStopStartedRef = useRef(false);
  const waylandRegisteredShortcutRef = useRef<string | undefined>(undefined);
  const waylandTriggerDescriptionRef = useRef<string | undefined>(undefined);
  const waylandConfigurationRequestedRef = useRef(false);
  const globalShortcutCleanupRef = useRef<Promise<void>>(Promise.resolve());
  const shortcutGenerationRef = useRef(0);

  function createShortcutGeneration(): number {
    shortcutGenerationRef.current += 1;
    return shortcutGenerationRef.current;
  }

  function invalidateShortcutGeneration(generation?: number) {
    if (generation === undefined || shortcutGenerationRef.current === generation) {
      shortcutGenerationRef.current += 1;
    }
  }

  function isCurrentShortcutGeneration(generation: number): boolean {
    return shortcutGenerationRef.current === generation;
  }

  function updateRecordingState(nextState: RecordingState) {
    currentRecordingStateRef.current = nextState;
    setCurrentRecordingState(nextState);
  }

  function updateDictationActionPending(pending: boolean) {
    dictationActionPendingRef.current = pending;
    setDictationActionPending(pending);
  }

  function updateDictationStarting(starting: boolean) {
    dictationStartingRef.current = starting;
    setDictationStarting(starting);
  }

  useEffect(() => {
    if (recordingState) updateRecordingState(recordingState);
  }, [recordingState]);

  useEffect(() => {
    setCurrentSettings(settings);
    setDraftSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (!settingsReady) {
      setPlatformDiagnosis(undefined);
      setPlatformDiagnosisReady(false);
      return;
    }
    const diagnosisGeneration = createShortcutGeneration();
    let cancelled = false;
    setPlatformDiagnosis(undefined);
    setPlatformDiagnosisReady(false);
    const diagnose = activeBridge.diagnosePlatform;
    const nativeRuntimeUnavailable =
      activeBridge === nativeBridge
      && (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window));
    if (!diagnose || nativeRuntimeUnavailable) {
      setPlatformDiagnosisReady(true);
      return () => {
        cancelled = true;
        invalidateShortcutGeneration(diagnosisGeneration);
      };
    }

    void diagnose().then((diagnosis) => {
      if (cancelled) return;
      setPlatformDiagnosis(diagnosis);
      setPlatformDiagnosisReady(true);
    }).catch(() => {
      if (cancelled) return;
      setPlatformDiagnosis(undefined);
      setPlatformDiagnosisReady(true);
    });

    return () => {
      cancelled = true;
      invalidateShortcutGeneration(diagnosisGeneration);
    };
  }, [activeBridge, settingsReady]);

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

  function handleShortcutCaptured() {
    if (currentSettings.mode === "hold") {
      waylandConfigurationRequestedRef.current = true;
    }
  }

  function restartOnboarding() {
    setSettingsOpen(false);
    onRestartOnboarding?.();
  }

  async function handleDictation() {
    if (
      dictationActionPendingRef.current
      || dictationStartingRef.current
      || currentRecordingStateRef.current.status === "transcribing"
    ) return;

    if (currentRecordingStateRef.current.status === "recording") {
      await stopDictation();
      return;
    }

    testerRef.current?.prepareForDictation();
    await startDictation();
  }

  function startWaylandDictation() {
    if (
      waylandDictationOwnedRef.current
      || dictationActionPendingRef.current
      || dictationStartingRef.current
      || currentRecordingStateRef.current.status === "recording"
      || currentRecordingStateRef.current.status === "transcribing"
    ) return;

    waylandDictationOwnedRef.current = true;
    waylandStopStartedRef.current = false;
    waylandReleasePendingRef.current = false;
    testerRef.current?.prepareForDictation();
    void startDictation();
  }

  function stopWaylandDictationIfOwned() {
    if (!waylandDictationOwnedRef.current || waylandStopStartedRef.current) return;
    if (dictationStartingRef.current) {
      waylandReleasePendingRef.current = true;
      return;
    }
    if (
      currentRecordingStateRef.current.status !== "recording"
      || dictationActionPendingRef.current
    ) return;

    waylandStopStartedRef.current = true;
    waylandDictationOwnedRef.current = false;
    void stopDictation();
  }

  shortcutHandlerRef.current = (state) => {
    if (state === "Pressed") {
      if (currentSettings.mode === "toggle" || currentRecordingStateRef.current.status !== "recording") {
        void handleDictation();
      }
      return;
    }
    if (currentSettings.mode === "hold" && currentRecordingStateRef.current.status === "recording") {
      void stopDictation();
    }
  };

  function handleWaylandShortcutEvent(event: WaylandHoldShortcutEvent) {
    setWaylandShortcutStatus(event);
    if (event.status === "pressed") {
      startWaylandDictation();
      return;
    }
    if (event.status === "released") {
      stopWaylandDictationIfOwned();
      return;
    }
    if (event.status === "error") {
      stopWaylandDictationIfOwned();
    }
  }

  waylandShortcutHandlerRef.current = handleWaylandShortcutEvent;

  const useWaylandHoldPortal =
    platformDiagnosisReady
    && platformDiagnosis?.session === "wayland"
    && currentSettings.mode === "hold";

  useEffect(() => {
    const onWaylandHoldShortcut = activeBridge.onWaylandHoldShortcut;
    const configureWaylandHoldShortcut = activeBridge.configureWaylandHoldShortcut;
    const clearWaylandHoldShortcut = activeBridge.clearWaylandHoldShortcut;
    if (!settingsReady || !platformDiagnosisReady || !useWaylandHoldPortal || shortcutCaptureActive) {
      if (!useWaylandHoldPortal || shortcutCaptureActive) setWaylandShortcutStatus(undefined);
      return;
    }
    if (!onWaylandHoldShortcut || !configureWaylandHoldShortcut || !clearWaylandHoldShortcut) {
      setWaylandShortcutStatus({
        status: "error",
        message: "El portal de atajos Wayland no está disponible",
      });
      return;
    }
    const subscribeToWaylandShortcut = onWaylandHoldShortcut;
    const configurePortalShortcut = configureWaylandHoldShortcut;
    const clearPortalShortcut = clearWaylandHoldShortcut;
    const generation = createShortcutGeneration();

    let disposed = false;
    let listenerRemoved = false;
    let unlisten: (() => void) | undefined;
    let cleanupRetryCount = 0;
    let cleanupRetryTimer: ReturnType<typeof setTimeout> | undefined;
    const shortcut = currentSettings.shortcut;
    const explicitConfigurationRequest = waylandConfigurationRequestedRef.current;
    waylandConfigurationRequestedRef.current = false;
    const requestConfiguration = explicitConfigurationRequest || shouldRequestWaylandShortcutConfiguration(
      waylandRegisteredShortcutRef.current,
      shortcut,
      waylandTriggerDescriptionRef.current !== undefined,
    );

    function removeListener() {
      if (listenerRemoved || !unlisten) return;
      listenerRemoved = true;
      unlisten();
    }

    function isCleanupPendingMessage(message: string | undefined): boolean {
      const normalized = message?.toLocaleLowerCase() ?? "";
      return normalized.includes("limpieza") && normalized.includes("pendiente");
    }

    function schedulePendingCleanupRetry(message: string | undefined) {
      if (disposed || !isCleanupPendingMessage(message) || cleanupRetryCount >= 2) return;

      cleanupRetryCount += 1;
      cleanupRetryTimer = setTimeout(() => {
        cleanupRetryTimer = undefined;
        if (disposed || !isCurrentShortcutGeneration(generation)) return;
        const retry = requestConfiguration
          ? configurePortalShortcut(shortcut, { requestConfiguration: true })
          : configurePortalShortcut(shortcut);
        void retry.catch(() => undefined);
      }, cleanupRetryCount * 600);
    }

    function retryPendingCleanup(event: WaylandHoldShortcutEvent) {
      if (event.status !== "error") return;
      schedulePendingCleanupRetry(event.message);
    }

    async function configurePortal() {
      try {
        unlisten = await subscribeToWaylandShortcut((event) => {
          if (!isCurrentShortcutGeneration(generation)) return;
          if (event.status === "registered") {
            cleanupRetryCount = 0;
            waylandRegisteredShortcutRef.current = shortcut;
            waylandTriggerDescriptionRef.current = event.triggerDescription;
          }
          retryPendingCleanup(event);
          waylandShortcutHandlerRef.current(event);
        });
        if (disposed) {
          removeListener();
          return;
        }
        if (requestConfiguration) {
          await configurePortalShortcut(shortcut, { requestConfiguration: true });
        } else {
          await configurePortalShortcut(shortcut);
        }
      } catch (error: unknown) {
        if (!disposed && isCurrentShortcutGeneration(generation)) {
          const message = getErrorMessage(error, "No se pudo registrar el atajo Wayland");
          setWaylandShortcutStatus({
            status: "error",
            message,
          });
          schedulePendingCleanupRetry(message);
          stopWaylandDictationIfOwned();
        }
      }
    }

    setWaylandShortcutStatus(undefined);
    const configuration = configurePortal();
    return () => {
      disposed = true;
      invalidateShortcutGeneration(generation);
      stopWaylandDictationIfOwned();
      if (cleanupRetryTimer !== undefined) clearTimeout(cleanupRetryTimer);
      removeListener();
      void configuration.then(removeListener).catch(() => undefined);
      void clearPortalShortcut().catch(() => undefined);
    };
  }, [
    activeBridge,
    currentSettings.mode,
    currentSettings.shortcut,
    platformDiagnosisReady,
    settingsReady,
    shortcutCaptureActive,
    useWaylandHoldPortal,
  ]);

  useEffect(() => {
    if (
      !platformDiagnosisReady
      || useWaylandHoldPortal
      || shortcutCaptureActive
      || typeof window === "undefined"
      || !("__TAURI_INTERNALS__" in window)
    ) return;

    let disposed = false;
    const generation = createShortcutGeneration();
    const shortcut = normalizeShortcutForPlatform(currentSettings.shortcut);
    let registered = false;
    let unregisterStarted = false;
    let unregisterShortcut: ((shortcut: string) => Promise<void>) | undefined;
    const previousCleanup = globalShortcutCleanupRef.current;
    let resolveCleanup: () => void = () => undefined;
    const cleanupComplete = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });

    async function unregisterIfRegistered() {
      if (!registered || unregisterStarted || !unregisterShortcut) return;
      unregisterStarted = true;
      try {
        await unregisterShortcut(shortcut);
      } catch {
        // The shortcut is already outside this component's lifecycle.
      }
    }

    const registration = previousCleanup.then(() => import("@tauri-apps/plugin-global-shortcut")).then(async ({ register, unregister }) => {
      unregisterShortcut = unregister;
      if (disposed) return;

      try {
        await register(shortcut, (event) => {
          if (!isCurrentShortcutGeneration(generation)) return;
          shortcutHandlerRef.current(event.state);
        });
        registered = true;
        if (!disposed && isCurrentShortcutGeneration(generation)) {
          setShortcutRegistrationError(null);
        }
      } catch (error: unknown) {
        if (!disposed && isCurrentShortcutGeneration(generation)) {
          setShortcutRegistrationError(getErrorMessage(error, "No se pudo registrar el atajo global"));
        }
      }
    }).catch((error: unknown) => {
      if (!disposed && isCurrentShortcutGeneration(generation)) {
        setShortcutRegistrationError(getErrorMessage(error, "No se pudo registrar el atajo global"));
      }
    });

    globalShortcutCleanupRef.current = cleanupComplete;

    return () => {
      disposed = true;
      invalidateShortcutGeneration(generation);
      void registration
        .then(() => unregisterIfRegistered())
        .catch(() => undefined)
        .finally(resolveCleanup);
    };
  }, [currentSettings.shortcut, platformDiagnosisReady, shortcutCaptureActive, useWaylandHoldPortal]);

  async function startDictation() {
    updateDictationStarting(true);
    updateDictationActionPending(true);
    let started = false;
    try {
      if (!activeBridge.startDictation) {
        throw new Error("El dictado nativo no está disponible");
      }
      const result = await activeBridge.startDictation();
      applyDictationResult(result, "recording");
      started = !result || result.status === "recording";
      if (!started) waylandDictationOwnedRef.current = false;
    } catch (error: unknown) {
      updateRecordingState({ status: "error", message: getErrorMessage(error, "No se pudo iniciar el dictado") });
      waylandDictationOwnedRef.current = false;
    } finally {
      const releasePending = waylandReleasePendingRef.current;
      waylandReleasePendingRef.current = false;
      updateDictationStarting(false);
      updateDictationActionPending(false);
      if (releasePending && started && waylandDictationOwnedRef.current) {
        waylandStopStartedRef.current = true;
        waylandDictationOwnedRef.current = false;
        void stopDictation();
      }
    }
  }

  async function stopDictation() {
    waylandDictationOwnedRef.current = false;
    updateRecordingState({ status: "transcribing" });
    updateDictationActionPending(true);
    try {
      if (!activeBridge.stopDictation) {
        throw new Error("El dictado nativo no está disponible");
      }
      const result = await activeBridge.stopDictation();
      applyDictationResult(result, "transcribing");
    } catch (error: unknown) {
      updateRecordingState({ status: "error", message: getErrorMessage(error, "No se pudo transcribir el dictado") });
    } finally {
      updateDictationActionPending(false);
    }
  }

  function applyDictationResult(result: DictationResult | void, fallbackStatus: "recording" | "transcribing") {
    if (!result) {
      updateRecordingState({ status: fallbackStatus });
      return;
    }

    switch (result.status) {
      case "ready":
        updateRecordingState({ status: "ready" });
        return;
      case "recording":
        updateRecordingState({ status: "recording" });
        return;
      case "transcribing":
        updateRecordingState({ status: "transcribing" });
        return;
      case "copied":
        updateRecordingState({ status: "copied" });
        const resultId = result.historyEntry?.id ?? ++dictationResultCounterRef.current;
        setDictationResult({ text: result.text, pasted: result.pasted, id: resultId });
        return;
      case "error":
        updateRecordingState({
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
          onShortcutCaptured={handleShortcutCaptured}
          resultText={dictationResult?.text}
          resultId={dictationResult?.id}
          resultPasted={dictationResult?.pasted}
          shortcutRegistrationError={shortcutRegistrationError}
          waylandShortcutStatus={waylandShortcutStatus}
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
