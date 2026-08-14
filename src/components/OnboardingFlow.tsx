import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  type AppLanguage,
  type AppSettings,
} from "../domain/settings";
import { createRecordingState, type RecordingState } from "../domain/recording";
import {
  nativeBridge,
  type ChamuBridge,
  type DictationResult,
  type ModelDownloadProgress,
  type ModelStatus,
} from "../native/commands";
import { DictationTester, type DictationTesterHandle } from "./DictationTester";
import { normalizeShortcutForPlatform } from "./ShortcutField";
import { StatusBubble } from "./StatusBubble";

type OnboardingStep = "model" | "setup";

const MODEL_ID = "base";

interface ProgressListener {
  token: symbol;
  unlisten?: () => void;
}

export interface OnboardingFlowProps {
  bridge?: ChamuBridge;
  initialSettings?: AppSettings;
  onComplete: (settings: AppSettings) => void;
}

function getModelDescription(model: ModelStatus | null): string {
  if (!model) return "Comprobando si ya está instalado…";
  if (model.installed && model.checksumValid) return "Modelo listo en este equipo";
  if (model.installed) return "El checksum no coincide; descarga el modelo otra vez";
  return "No se encontró un modelo local";
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function OnboardingFlow({
  bridge = nativeBridge,
  initialSettings = DEFAULT_SETTINGS,
  onComplete,
}: OnboardingFlowProps) {
  const [step, setStep] = useState<OnboardingStep>("model");
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [downloadConsent, setDownloadConsent] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<ModelDownloadProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dictationState, setDictationState] = useState<RecordingState>(createRecordingState);
  const [dictationPending, setDictationPending] = useState(false);
  const [dictationStarting, setDictationStarting] = useState(false);
  const [microphoneName, setMicrophoneName] = useState<string>();
  const [shortcutCaptureActive, setShortcutCaptureActive] = useState(false);
  const [dictationResult, setDictationResult] = useState<{
    text?: DictationResult["text"];
    pasted?: boolean;
    id: string | number;
  }>();
  const unlistenRef = useRef<ProgressListener | null>(null);
  const disposedRef = useRef(false);
  const testerRef = useRef<DictationTesterHandle>(null);
  const dictationResultCounterRef = useRef(0);
  const shortcutHandlerRef = useRef<(state: "Pressed" | "Released") => void>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    void bridge.inspectModel(MODEL_ID).then((status) => {
      if (!cancelled) setModel(status);
    }).catch((error: unknown) => {
      if (!cancelled) setModelError(getErrorMessage(error, "No se pudo comprobar el modelo"));
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  useEffect(() => {
    let cancelled = false;
    const loadMicrophoneInfo = bridge.getMicrophoneInfo;
    if (!loadMicrophoneInfo) return;

    void loadMicrophoneInfo().then((info) => {
      if (!cancelled) setMicrophoneName(info.name);
    }).catch(() => {
      // The tester renders the safe system fallback when the native probe is unavailable.
    });

    return () => {
      cancelled = true;
    };
  }, [bridge]);

  function releaseProgressListener(token?: symbol) {
    const listener = unlistenRef.current;
    if (!listener || (token && listener.token !== token)) return;
    unlistenRef.current = null;
    try {
      listener.unlisten?.();
    } catch {
      // The listener is detached from the component lifecycle.
    }
  }

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      releaseProgressListener();
    };
  }, []);

  const modelReady = Boolean(model?.installed && model.checksumValid);
  const canContinue = useMemo(() => {
    if (step === "model") return modelReady && !downloading;
    return !saving;
  }, [downloading, modelReady, saving, step]);

  async function refreshModel() {
    setModelError(null);
    try {
      setModel(await bridge.inspectModel(MODEL_ID));
    } catch (error: unknown) {
      setModelError(getErrorMessage(error, "No se pudo buscar un modelo existente"));
    }
  }

  async function handleDownloadProgress(progress: ModelDownloadProgress, token: symbol) {
    if (unlistenRef.current?.token !== token) return;
    if (progress.modelId !== MODEL_ID) return;
    setDownloadProgress(progress);
    if (progress.phase === "failed") {
      releaseProgressListener(token);
      setDownloading(false);
      setModelError(progress.message);
      return;
    }
    if (progress.phase === "cancelled") {
      releaseProgressListener(token);
      setDownloading(false);
      setModelError(progress.message);
      return;
    }
    if (progress.phase === "completed") {
      releaseProgressListener(token);
      setDownloading(false);
      setDownloadConsent(false);
      await refreshModel();
    }
  }

  async function confirmDownload() {
    if (!downloadConsent || downloading) return;
    setModelError(null);
    setDownloadProgress(null);
    releaseProgressListener();
    const listenerToken = Symbol("model-download-progress");
    unlistenRef.current = { token: listenerToken };
    try {
      const unlisten = await bridge.onModelDownloadProgress((progress) => {
        void handleDownloadProgress(progress, listenerToken);
      });
      if (disposedRef.current || unlistenRef.current?.token !== listenerToken) {
        unlisten();
        return;
      }
      unlistenRef.current.unlisten = unlisten;
      setDownloading(true);
      await bridge.startModelDownload(MODEL_ID);
    } catch (error: unknown) {
      releaseProgressListener(listenerToken);
      setDownloading(false);
      setModelError(getErrorMessage(error, "No se pudo iniciar la descarga"));
    }
  }

  async function cancelDownload() {
    try {
      await bridge.cancelModelDownload(MODEL_ID);
    } catch (error: unknown) {
      setModelError(getErrorMessage(error, "No se pudo cancelar la descarga"));
    }
  }

  async function handleDictation() {
    if (dictationPending || dictationStarting || dictationState.status === "transcribing") return;
    if (dictationState.status === "recording") {
      await stopDictation();
      return;
    }

    testerRef.current?.prepareForDictation();
    await startDictation();
  }

  async function startDictation() {
    setDictationStarting(true);
    setDictationPending(true);
    try {
      if (!bridge.startDictation) throw new Error("El dictado nativo no está disponible");
      const result = await bridge.startDictation();
      applyDictationResult(result, "recording");
    } catch (error: unknown) {
      setDictationState({ status: "error", message: getErrorMessage(error, "No se pudo iniciar el dictado") });
    } finally {
      setDictationStarting(false);
      setDictationPending(false);
    }
  }

  shortcutHandlerRef.current = (state) => {
    if (state === "Pressed") {
      if (settings.mode === "toggle" || dictationState.status !== "recording") {
        void handleDictation();
      }
      return;
    }
    if (settings.mode === "hold" && dictationState.status === "recording") {
      void stopDictation();
    }
  };

  useEffect(() => {
    if (
      step !== "setup"
      || shortcutCaptureActive
      || typeof window === "undefined"
      || !("__TAURI_INTERNALS__" in window)
    ) return;

    let disposed = false;
    const shortcut = normalizeShortcutForPlatform(settings.shortcut);
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
        if (disposed) await unregisterIfRegistered();
      } catch (error: unknown) {
        if (!disposed) throw error;
      }
    }).catch((error: unknown) => {
      if (!disposed) setSaveError(getErrorMessage(error, "No se pudo registrar el atajo global"));
    });

    return () => {
      disposed = true;
      void registration.then(() => unregisterIfRegistered()).catch(() => undefined);
    };
  }, [settings.shortcut, shortcutCaptureActive, step]);

  async function stopDictation() {
    setDictationState({ status: "transcribing" });
    setDictationPending(true);
    try {
      if (!bridge.stopDictation) throw new Error("El dictado nativo no está disponible");
      const result = await bridge.stopDictation();
      applyDictationResult(result, "transcribing");
    } catch (error: unknown) {
      setDictationState({ status: "error", message: getErrorMessage(error, "No se pudo transcribir el dictado") });
    } finally {
      setDictationPending(false);
    }
  }

  function applyDictationResult(result: DictationResult | void, fallbackStatus: "recording" | "transcribing") {
    if (!result) {
      setDictationState({ status: fallbackStatus });
      return;
    }

    switch (result.status) {
      case "ready":
        setDictationState({ status: "ready" });
        return;
      case "recording":
        setDictationState({ status: "recording" });
        return;
      case "transcribing":
        setDictationState({ status: "transcribing" });
        return;
      case "copied":
        setDictationState({ status: "copied" });
        setDictationResult({
          text: result.text,
          pasted: result.pasted,
          id: result.historyEntry?.id ?? ++dictationResultCounterRef.current,
        });
        return;
      case "error":
        setDictationState({ status: "error", message: result.message ?? "No se pudo completar el dictado" });
        return;
    }
  }

  async function finish() {
    setSaving(true);
    setSaveError(null);
    try {
      await bridge.saveSettings(settings);
      onComplete(settings);
    } catch (error: unknown) {
      setSaveError(getErrorMessage(error, "No se pudo guardar la configuración"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="app-shell onboarding-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span aria-hidden="true" className="brand-mark">◌</span>
          <div><h1>Chamu</h1><p>Tu voz, en tus manos</p></div>
        </div>
        <span className="onboarding-progress">{step === "model" ? "1" : "2"} de 2</span>
      </header>

      <div className="app-content onboarding-content">
        <section className="welcome-card onboarding-card" aria-labelledby="onboarding-title">
          <p className="eyebrow">PRIMERA VEZ</p>
          {step === "model" ? (
            <>
              <h2 id="onboarding-title">Prepara el modelo</h2>
              <p className="welcome-copy">Chamu procesa el dictado en este equipo. Sin cuentas, sin telemetría y sin nube.</p>
              <fieldset className="choice-list">
                <legend className="sr-only">Idioma de Chamu</legend>
                <label className="choice-card">
                  <input checked={settings.language === "es"} name="language" onChange={() => setSettings((current) => ({ ...current, language: "es" as AppLanguage }))} type="radio" value="es" />
                  <span><strong>Español</strong><small>Interfaz y dictado en español</small></span>
                </label>
                <label className="choice-card">
                  <input checked={settings.language === "en"} name="language" onChange={() => setSettings((current) => ({ ...current, language: "en" as AppLanguage }))} type="radio" value="en" />
                  <span><strong>English</strong><small>Interfaz y dictado en inglés</small></span>
                </label>
              </fieldset>
              <div className={`check-panel ${modelReady ? "check-panel--ok" : ""}`}>
                <strong>{model?.name ?? "Whisper base multilingüe"}</strong>
                <span>{modelError ?? getModelDescription(model)}</span>
                {downloadProgress && !downloading && <small>{downloadProgress.message}{downloadProgress.percent === undefined ? "" : ` · ${downloadProgress.percent}%`}</small>}
              </div>
              <button className="secondary-button" onClick={() => void refreshModel()} type="button">Buscar un modelo existente</button>
              {model && !modelReady && !downloading && <button className="primary-button" onClick={() => setDownloadConsent(true)} type="button">Descargar modelo (142 MiB)</button>}
              {downloadConsent && !downloading && (
                <div className="consent-panel" role="dialog" aria-label="Confirmar descarga del modelo">
                  <p><strong>¿Confirmas descargar el modelo?</strong></p>
                  <p>La descarga sólo empieza con tu confirmación. El archivo permite el procesamiento local.</p>
                  <div className="button-row"><button className="secondary-button" onClick={() => setDownloadConsent(false)} type="button">Ahora no</button><button className="primary-button" onClick={() => void confirmDownload()} type="button">Confirmar descarga</button></div>
                </div>
              )}
              {downloading && <div className="download-panel" role="status"><span>{downloadProgress?.message ?? "Conectando con el servidor…"}{downloadProgress?.percent === undefined ? "" : ` · ${downloadProgress.percent}%`}</span><button className="secondary-button" onClick={() => void cancelDownload()} type="button">Cancelar descarga</button></div>}
            </>
          ) : (
            <>
              <h2 id="onboarding-title">Configura el dictado</h2>
              <p className="welcome-copy">Prueba el dictado local y elige cómo iniciar la grabación.</p>
              <StatusBubble state={dictationState} />
              <DictationTester
                ref={testerRef}
                settings={settings}
                onSettingsChange={setSettings}
                state={dictationState}
                pending={dictationPending}
                starting={dictationStarting}
                microphoneName={microphoneName}
                onDictationClick={() => void handleDictation()}
                resultText={dictationResult?.text}
                resultId={dictationResult?.id}
                resultPasted={dictationResult?.pasted}
                onCapturingChange={setShortcutCaptureActive}
              />
              {saveError && <p className="error-message">{saveError}</p>}
            </>
          )}
          <div className="onboarding-actions">
            <button className="primary-button" disabled={!canContinue} onClick={() => step === "model" ? setStep("setup") : void finish()} type="button">
              {saving ? "Guardando…" : step === "model" ? "Continuar" : "Terminar configuración"}
            </button>
          </div>
        </section>
      </div>
      <footer className="app-footer"><span>Sin cuentas · Sin telemetría · Sin nube</span><span>v0.1.5</span></footer>
    </main>
  );
}
