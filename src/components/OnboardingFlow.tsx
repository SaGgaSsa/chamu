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
  type ModelMetadata,
  type ModelStatus,
} from "../native/commands";
import { DictationTester, type DictationTesterHandle } from "./DictationTester";
import { MODEL_PROFILES } from "./ModelSelector";
import { normalizeShortcutForPlatform } from "./ShortcutField";
import { StatusBubble } from "./StatusBubble";

type OnboardingStep = "model" | "setup";

interface ProgressListener {
  token: symbol;
  unlisten?: () => void;
}

export interface OnboardingFlowProps {
  bridge?: ChamuBridge;
  initialSettings?: AppSettings;
  onComplete: (settings: AppSettings) => void;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function missingProfileLabels(catalog: readonly ModelMetadata[]): string[] {
  return MODEL_PROFILES
    .filter((profile) => !catalog.some((metadata) => metadata.id === profile.id))
    .map((profile) => profile.label);
}

export function OnboardingFlow({
  bridge = nativeBridge,
  initialSettings = DEFAULT_SETTINGS,
  onComplete,
}: OnboardingFlowProps) {
  const [step, setStep] = useState<OnboardingStep>("model");
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [selectedModelId, setSelectedModelId] = useState(() => (
    MODEL_PROFILES.some((profile) => profile.id === initialSettings.modelId)
      ? initialSettings.modelId
      : "small"
  ));
  const [modelStatuses, setModelStatuses] = useState<Record<string, ModelStatus>>({});
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({});
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogValidationError, setCatalogValidationError] = useState<string | null>(null);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [downloadConsentId, setDownloadConsentId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<ModelDownloadProgress | null>(null);
  const [downloadingModelId, setDownloadingModelId] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
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
  const bridgeRef = useRef(bridge);
  const bridgeGenerationRef = useRef(0);

  const selectedProfile = MODEL_PROFILES.find((profile) => profile.id === selectedModelId) ?? MODEL_PROFILES[1];
  const selectedModel = modelStatuses[selectedModelId];
  const modelReady = Boolean(selectedModel?.installed && selectedModel.checksumValid);
  const downloadProgressText = downloadProgress
    ? `${downloadProgress.message}${downloadProgress.percent === undefined ? "" : ` · ${downloadProgress.percent}%`}`
    : undefined;
  function modelStatusLabel(modelId: string): string {
    if (downloadingModelId === modelId) {
      const percent = downloadProgress?.percent === undefined ? "" : ` · ${downloadProgress.percent}%`;
      return `Descarga en curso${percent}`;
    }
    const error = modelErrors[modelId];
    if (error) return `Error: ${error}`;
    const model = modelStatuses[modelId];
    if (!model) return "Comprobando estado…";
    if (model.error) {
      return model.installed && !model.checksumValid
        ? `Checksum inválido · Error: ${model.error}`
        : `Error: ${model.error}`;
    }
    if (model.installed && !model.checksumValid) return "Checksum inválido";
    if (model.installed && model.checksumValid) {
      return model.active ? "Activo · instalado y validado" : "Instalado y validado";
    }
    if (model.installed) return "Checksum inválido";
    return "Descargable";
  }

  function modelDescription(): string {
    if (catalogError) return catalogError;
    if (catalogValidationError) return catalogValidationError;
    if (modelErrors[selectedModelId]) return modelErrors[selectedModelId];
    if (!selectedModel) return "Comprobando estado…";
    if (selectedModel.installed && !selectedModel.checksumValid) return "Checksum inválido; descarga el perfil otra vez";
    if (selectedModel.error) return selectedModel.error;
    if (selectedModel.installed && selectedModel.checksumValid) return "Modelo listo en este equipo · instalado y validado";
    if (selectedModel.installed) return "Checksum inválido; descarga el perfil otra vez";
    return "Perfil descargable; todavía no está instalado";
  }

  function isCurrentBridge(expectedBridge: ChamuBridge, generation: number): boolean {
    return !disposedRef.current
      && bridgeRef.current === expectedBridge
      && bridgeGenerationRef.current === generation;
  }

  async function inspectProfile(
    modelId: string,
    expectedBridge = bridgeRef.current,
    generation = bridgeGenerationRef.current,
  ) {
    try {
      const status = await expectedBridge.inspectModel(modelId);
      if (!isCurrentBridge(expectedBridge, generation)) return;
      setModelStatuses((current) => ({ ...current, [modelId]: status }));
      setModelErrors((current) => {
        if (!(modelId in current)) return current;
        const next = { ...current };
        delete next[modelId];
        return next;
      });
    } catch (error: unknown) {
      if (!isCurrentBridge(expectedBridge, generation)) return;
      setModelErrors((current) => ({
        ...current,
        [modelId]: getErrorMessage(error, "No se pudo comprobar el modelo"),
      }));
    }
  }

  useEffect(() => {
    const expectedBridge = bridge;
    const generation = bridgeGenerationRef.current + 1;
    bridgeGenerationRef.current = generation;
    bridgeRef.current = expectedBridge;
    let cancelled = false;
    setCatalogLoaded(false);
    setCatalogError(null);
    setCatalogValidationError(null);
    setModelStatuses({});
    setModelErrors({});
    setDownloadProgress(null);
    setDownloadConsentId(null);
    setDownloadingModelId(null);
    setActivating(false);

    function isCurrent(): boolean {
      return !cancelled && isCurrentBridge(expectedBridge, generation);
    }

    void expectedBridge.getModelCatalog().then(async (loadedCatalog) => {
      if (!isCurrent()) return;
      setCatalogLoaded(true);
      const missing = missingProfileLabels(loadedCatalog);
      setCatalogValidationError(
        missing.length > 0
          ? `El catálogo de modelos está incompleto. Falta: ${missing.join(", ")}.`
          : null,
      );
      await Promise.all(MODEL_PROFILES.map((profile) => inspectProfile(profile.id, expectedBridge, generation)));
    }).catch((error: unknown) => {
      if (!isCurrent()) return;
      setCatalogLoaded(true);
      setCatalogError(getErrorMessage(error, "No se pudo cargar el catálogo de modelos"));
    });
    return () => {
      cancelled = true;
      releaseProgressListener();
      if (bridgeGenerationRef.current === generation) bridgeGenerationRef.current += 1;
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

  const canContinue = useMemo(() => {
    if (step === "model") return modelReady && !downloadingModelId && !activating;
    return !saving;
  }, [activating, downloadingModelId, modelReady, saving, step]);

  async function refreshModel(
    modelId = selectedModelId,
    expectedBridge = bridgeRef.current,
    generation = bridgeGenerationRef.current,
  ) {
    setModelErrors((current) => {
      if (!(modelId in current)) return current;
      const next = { ...current };
      delete next[modelId];
      return next;
    });
    await inspectProfile(modelId, expectedBridge, generation);
  }

  async function handleDownloadProgress(
    progress: ModelDownloadProgress,
    token: symbol,
    modelId: string,
    expectedBridge: ChamuBridge,
    generation: number,
  ) {
    if (!isCurrentBridge(expectedBridge, generation)) return;
    if (unlistenRef.current?.token !== token) return;
    if (progress.modelId !== modelId) return;
    setDownloadProgress(progress);
    if (progress.phase === "failed") {
      releaseProgressListener(token);
      setDownloadingModelId(null);
      setDownloadConsentId(null);
      setModelErrors((current) => ({ ...current, [modelId]: progress.message }));
      return;
    }
    if (progress.phase === "cancelled") {
      releaseProgressListener(token);
      setDownloadingModelId(null);
      setModelErrors((current) => ({ ...current, [modelId]: progress.message }));
      return;
    }
    if (progress.phase === "completed") {
      releaseProgressListener(token);
      setDownloadingModelId(null);
      setDownloadConsentId(null);
      await refreshModel(progress.modelId, expectedBridge, generation);
    }
  }

  async function confirmDownload() {
    const modelId = downloadConsentId;
    if (!modelId || downloadingModelId || activating) return;
    const expectedBridge = bridgeRef.current;
    const generation = bridgeGenerationRef.current;
    setModelErrors((current) => {
      if (!(modelId in current)) return current;
      const next = { ...current };
      delete next[modelId];
      return next;
    });
    setDownloadProgress(null);
    releaseProgressListener();
    const listenerToken = Symbol("model-download-progress");
    unlistenRef.current = { token: listenerToken };
    setDownloadingModelId(modelId);
    try {
      const unlisten = await expectedBridge.onModelDownloadProgress((progress) => {
        void handleDownloadProgress(progress, listenerToken, modelId, expectedBridge, generation);
      });
      if (!isCurrentBridge(expectedBridge, generation) || unlistenRef.current?.token !== listenerToken) {
        unlisten();
        return;
      }
      unlistenRef.current.unlisten = unlisten;
      await expectedBridge.startModelDownload(modelId);
    } catch (error: unknown) {
      if (!isCurrentBridge(expectedBridge, generation) || unlistenRef.current?.token !== listenerToken) return;
      releaseProgressListener(listenerToken);
      setDownloadingModelId(null);
      setDownloadConsentId(null);
      setModelErrors((current) => ({
        ...current,
        [modelId]: getErrorMessage(error, "No se pudo iniciar la descarga"),
      }));
    }
  }

  async function cancelDownload() {
    if (!downloadingModelId) return;
    const expectedBridge = bridgeRef.current;
    const generation = bridgeGenerationRef.current;
    const modelId = downloadingModelId;
    try {
      await expectedBridge.cancelModelDownload(modelId);
    } catch (error: unknown) {
      if (!isCurrentBridge(expectedBridge, generation) || downloadingModelId !== modelId) return;
      setModelErrors((current) => ({
        ...current,
        [modelId]: getErrorMessage(error, "No se pudo cancelar la descarga"),
      }));
    }
  }

  async function activateSelectedModel() {
    if (!modelReady || downloadingModelId || activating) return;
    const expectedBridge = bridgeRef.current;
    const generation = bridgeGenerationRef.current;
    setActivating(true);
    setModelErrors((current) => {
      if (!(selectedModelId in current)) return current;
      const next = { ...current };
      delete next[selectedModelId];
      return next;
    });
    try {
      await expectedBridge.activateModel(selectedModelId);
      if (!isCurrentBridge(expectedBridge, generation)) return;
      setSettings((current) => ({ ...current, modelId: selectedModelId }));
      setModelStatuses((current) => Object.fromEntries(
        Object.entries(current).map(([modelId, status]) => [
          modelId,
          { ...status, active: modelId === selectedModelId },
        ]),
      ));
      setStep("setup");
    } catch (error: unknown) {
      if (!isCurrentBridge(expectedBridge, generation)) return;
      setModelErrors((current) => ({
        ...current,
        [selectedModelId]: getErrorMessage(error, "No se pudo activar el modelo"),
      }));
    } finally {
      if (isCurrentBridge(expectedBridge, generation)) setActivating(false);
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
              <fieldset className="choice-list model-selector__choices" disabled={Boolean(downloadingModelId) || activating}>
                <legend>Perfil de Whisper</legend>
                {MODEL_PROFILES.map((profile) => (
                  <label className="choice-card model-selector__choice" key={profile.id}>
                    <input
                      checked={selectedModelId === profile.id}
                      name="onboarding-model-profile"
                      onChange={() => {
                        setSelectedModelId(profile.id);
                        setDownloadConsentId(null);
                        setDownloadProgress(null);
                      }}
                      type="radio"
                      value={profile.id}
                    />
                    <span>
                      <strong>{profile.label} · {profile.displaySizeMiB} MiB</strong>
                      <small>{profile.id}</small>
                      <small data-model-status={profile.id}>{modelStatusLabel(profile.id)}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              {catalogError && <p className="error-message" role="alert">{catalogError}</p>}
              {catalogValidationError && <p className="error-message" role="alert">{catalogValidationError}</p>}
              {!catalogLoaded && <p className="model-selector__loading" role="status">Cargando catálogo de modelos…</p>}
              <div className={`check-panel ${modelReady ? "check-panel--ok" : ""}`}>
                <strong>{selectedModel?.name ?? `Whisper ${selectedModelId}`}</strong>
                <span>{modelDescription()}</span>
                {downloadProgressText && <small>{downloadProgressText}</small>}
              </div>
              <button className="secondary-button" disabled={Boolean(downloadingModelId) || activating} onClick={() => void refreshModel()} type="button">Buscar un modelo existente</button>
              {selectedModel && !modelReady && !downloadingModelId && !activating && <button className="primary-button" onClick={() => setDownloadConsentId(selectedModelId)} type="button">Descargar modelo {selectedProfile.label} ({selectedProfile.displaySizeMiB} MiB)</button>}
              {downloadConsentId && !downloadingModelId && (
                <div className="consent-panel" role="dialog" aria-label="Confirmar descarga del modelo">
                  <p><strong>¿Confirmas descargar {MODEL_PROFILES.find((profile) => profile.id === downloadConsentId)?.label ?? "el perfil"}?</strong></p>
                  <p>Perfil elegido: {MODEL_PROFILES.find((profile) => profile.id === downloadConsentId)?.label}. Tamaño: {MODEL_PROFILES.find((profile) => profile.id === downloadConsentId)?.displaySizeMiB} MiB.</p>
                  <div className="button-row"><button className="secondary-button" onClick={() => setDownloadConsentId(null)} type="button">Ahora no</button><button className="primary-button" onClick={() => void confirmDownload()} type="button">Confirmar descarga</button></div>
                </div>
              )}
              {downloadingModelId && <div className="download-panel" role="status"><span>{downloadProgressText ?? "Conectando con el servidor…"}</span><button className="secondary-button" onClick={() => void cancelDownload()} type="button">Cancelar descarga</button></div>}
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
            <button className="primary-button" disabled={!canContinue} onClick={() => step === "model" ? void activateSelectedModel() : void finish()} type="button">
              {saving ? "Guardando…" : activating ? "Activando…" : step === "model" ? "Continuar" : "Terminar configuración"}
            </button>
          </div>
        </section>
      </div>
      <footer className="app-footer"><span>Sin cuentas · Sin telemetría · Sin nube</span><span>v0.1.5</span></footer>
    </main>
  );
}
