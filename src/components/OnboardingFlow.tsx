import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  type AppLanguage,
  type AppSettings,
  type RecordingMode,
} from "../domain/settings";
import {
  nativeBridge,
  type ChamuBridge,
  type ModelDownloadProgress,
  type ModelStatus,
} from "../native/commands";
import { ShortcutField, probeGlobalShortcut } from "./ShortcutField";

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

function formatShortcut(shortcut: string): string {
  return shortcut.replace("CommandOrControl", "Ctrl").replaceAll("+", " + ");
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
  const [microphoneResult, setMicrophoneResult] = useState<string | null>(null);
  const [shortcutResult, setShortcutResult] = useState<string | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [pasteResult, setPasteResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const unlistenRef = useRef<ProgressListener | null>(null);
  const disposedRef = useRef(false);

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

  async function testMicrophone() {
    try {
      const result = await bridge.testMicrophone();
      setMicrophoneResult(result.message);
    } catch (error: unknown) {
      setMicrophoneResult(getErrorMessage(error, "No se pudo probar el micrófono"));
    }
  }

  async function testShortcut() {
    setShortcutError(null);
    try {
      await probeGlobalShortcut(settings.shortcut);
      setShortcutResult(`Atajo disponible: ${formatShortcut(settings.shortcut)}.`);
    } catch (error: unknown) {
      setShortcutResult(null);
      setShortcutError(getErrorMessage(error, "El sistema rechazó el atajo"));
    }
  }

  async function testPaste() {
    try {
      const [clipboard, paste] = await Promise.all([bridge.testClipboard(), bridge.testPaste()]);
      setPasteResult(clipboard.ok && paste.ok ? "Portapapeles y pegado listos." : clipboard.ok ? paste.message : clipboard.message);
    } catch (error: unknown) {
      setPasteResult(getErrorMessage(error, "No se pudo probar el pegado"));
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
              <h2 id="onboarding-title">Atajo y modo</h2>
              <p className="welcome-copy">Elige cómo iniciar el dictado. Las pruebas son opcionales.</p>
              <ShortcutField value={settings.shortcut} onChange={(shortcut) => setSettings((current) => ({ ...current, shortcut }))} onError={(message) => setShortcutError(message ?? null)} />
              <button className="secondary-button" onClick={() => void testShortcut()} type="button">Probar atajo</button>
              {shortcutResult && <p className="success-message">{shortcutResult}</p>}
              {shortcutError && <p className="error-message">{shortcutError}</p>}
              <fieldset className="choice-list">
                <legend>Modo de grabación</legend>
                <label className="choice-card"><input checked={settings.mode === "hold"} name="mode" onChange={() => setSettings((current) => ({ ...current, mode: "hold" as RecordingMode }))} type="radio" value="hold" /><span><strong>Mantener pulsado</strong><small>Graba mientras mantienes el atajo</small></span></label>
                <label className="choice-card"><input checked={settings.mode === "toggle"} name="mode" onChange={() => setSettings((current) => ({ ...current, mode: "toggle" as RecordingMode }))} type="radio" value="toggle" /><span><strong>Pulsar para alternar</strong><small>Una pulsación empieza y otra termina</small></span></label>
              </fieldset>
              <div className="alternative-list"><button className="secondary-button" onClick={() => void testMicrophone()} type="button">Probar micrófono</button><button className="secondary-button" onClick={() => void testPaste()} type="button">Probar pegado</button></div>
              {microphoneResult && <p className="success-message">{microphoneResult}</p>}
              {pasteResult && <p className="success-message">{pasteResult}</p>}
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
      <footer className="app-footer"><span>Sin cuentas · Sin telemetría · Sin nube</span><span>v0.1.2</span></footer>
    </main>
  );
}
