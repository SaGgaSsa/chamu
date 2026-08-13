import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_SETTINGS,
  type AppLanguage,
  type AppSettings,
  type RecordingMode,
} from "../domain/settings";
import {
  nativeBridge,
  type ChamuBridge,
  type ModelStatus,
} from "../native/commands";

type OnboardingStep =
  | "privacy"
  | "language"
  | "model"
  | "microphone"
  | "shortcut"
  | "clipboard"
  | "mode";

const MODEL_ID = "base";
const PROPOSED_SHORTCUT = "Ctrl+Super";
const ALTERNATIVE_SHORTCUTS = ["Ctrl+Space", "Ctrl"] as const;

export interface OnboardingFlowProps {
  bridge?: ChamuBridge;
  initialSettings?: AppSettings;
  onComplete: (settings: AppSettings) => void;
}

function getModelDescription(model: ModelStatus | null): string {
  if (!model) return "Comprobando si ya está instalado…";
  if (model.installed && model.checksumValid) return "Modelo listo en este equipo";
  if (model.installed && !model.checksumValid) return "El checksum no coincide; tendrás que descargarlo otra vez";
  return "No se encontró un modelo local";
}

export function OnboardingFlow({
  bridge = nativeBridge,
  initialSettings = DEFAULT_SETTINGS,
  onComplete,
}: OnboardingFlowProps) {
  const [step, setStep] = useState<OnboardingStep>("privacy");
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [downloadConsent, setDownloadConsent] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [microphoneChecked, setMicrophoneChecked] = useState(false);
  const [microphoneError, setMicrophoneError] = useState<string | null>(null);
  const [shortcutChecked, setShortcutChecked] = useState(false);
  const [shortcutNeedsAlternative, setShortcutNeedsAlternative] = useState(false);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [clipboardChecked, setClipboardChecked] = useState(false);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (step !== "model") return;

    let cancelled = false;
    setModel(null);
    setModelError(null);
    void bridge.inspectModel(MODEL_ID).then((status) => {
      if (!cancelled) setModel(status);
    }).catch((error: unknown) => {
      if (!cancelled) {
        setModelError(error instanceof Error ? error.message : "No se pudo comprobar el modelo");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [bridge, step]);

  const modelReady = Boolean(model?.installed && model.checksumValid);
  const currentStepNumber = [
    "privacy",
    "language",
    "model",
    "microphone",
    "shortcut",
    "clipboard",
    "mode",
  ].indexOf(step) + 1;

  const canContinue = useMemo(() => {
    switch (step) {
      case "privacy":
      case "language":
        return true;
      case "model":
        return modelReady && !downloading;
      case "microphone":
        return microphoneChecked;
      case "shortcut":
        return shortcutChecked && !shortcutNeedsAlternative;
      case "clipboard":
        return clipboardChecked;
      case "mode":
        return !saving;
    }
  }, [clipboardChecked, downloading, microphoneChecked, modelReady, saving, shortcutChecked, shortcutNeedsAlternative, step]);

  function goForward() {
    const next: Record<OnboardingStep, OnboardingStep | null> = {
      privacy: "language",
      language: "model",
      model: "microphone",
      microphone: "shortcut",
      shortcut: "clipboard",
      clipboard: "mode",
      mode: null,
    };
    const nextStep = next[step];
    if (nextStep) {
      setStep(nextStep);
      return;
    }

    setSaving(true);
    setSaveError(null);
    void bridge.saveSettings(settings).then(() => {
      onComplete(settings);
    }).catch((error: unknown) => {
      setSaveError(error instanceof Error ? error.message : "No se pudo guardar la configuración");
    }).finally(() => {
      setSaving(false);
    });
  }

  async function confirmDownload() {
    if (!downloadConsent) return;
    setDownloading(true);
    setModelError(null);
    try {
      const result = await bridge.downloadModel(MODEL_ID);
      setModel(result);
      setDownloadConsent(false);
    } catch (error: unknown) {
      setModelError(error instanceof Error ? error.message : "No se pudo descargar el modelo");
    } finally {
      setDownloading(false);
    }
  }

  async function inspectExistingModel() {
    setModelError(null);
    try {
      const result = await bridge.inspectModel();
      setModel(result);
    } catch (error: unknown) {
      setModelError(error instanceof Error ? error.message : "No se pudo buscar un modelo existente");
    }
  }

  async function cancelDownload() {
    try {
      await bridge.cancelModelDownload(MODEL_ID);
    } catch (error: unknown) {
      setModelError(error instanceof Error ? error.message : "No se pudo cancelar la descarga");
    } finally {
      setDownloading(false);
    }
  }

  async function checkMicrophone() {
    setMicrophoneError(null);
    try {
      const result = await bridge.testMicrophone();
      setMicrophoneChecked(result.ok);
      if (!result.ok) setMicrophoneError(result.message);
    } catch (error: unknown) {
      setMicrophoneChecked(false);
      setMicrophoneError(error instanceof Error ? error.message : "No se pudo probar el micrófono");
    }
  }

  async function checkShortcut(shortcut: string) {
    setShortcutError(null);
    try {
      const result = await bridge.testShortcut(shortcut);
      setSettings((current) => ({ ...current, shortcut }));
      setShortcutChecked(result.ok);
      setShortcutNeedsAlternative(!result.ok && shortcut === PROPOSED_SHORTCUT);
      if (!result.ok) setShortcutError(result.message ?? "No se pudo capturar el atajo");
    } catch (error: unknown) {
      setShortcutChecked(false);
      setShortcutNeedsAlternative(shortcut === PROPOSED_SHORTCUT);
      setShortcutError(error instanceof Error ? error.message : "No se pudo probar el atajo");
    }
  }

  async function checkClipboardAndPaste() {
    setClipboardError(null);
    try {
      const [clipboard, paste] = await Promise.all([
        bridge.testClipboard(),
        bridge.testPaste(),
      ]);
      const ok = clipboard.ok && paste.ok;
      setClipboardChecked(ok);
      if (!ok) setClipboardError(clipboard.ok ? paste.message : clipboard.message);
    } catch (error: unknown) {
      setClipboardChecked(false);
      setClipboardError(error instanceof Error ? error.message : "No se pudo probar el portapapeles");
    }
  }

  return (
    <main className="app-shell onboarding-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span aria-hidden="true" className="brand-mark">◌</span>
          <div>
            <h1>Chamu</h1>
            <p>Tu voz, en tus manos</p>
          </div>
        </div>
        <span className="onboarding-progress">{currentStepNumber} de 7</span>
      </header>

      <div className="app-content onboarding-content">
        <section className="welcome-card onboarding-card" aria-labelledby="onboarding-title">
          <p className="eyebrow">PRIMERA VEZ</p>
          {step === "privacy" && (
            <>
              <h2 id="onboarding-title">Configura Chamu</h2>
              <p className="welcome-copy">Unos pasos y podrás dictar en cualquier aplicación desde tu escritorio.</p>
              <div className="onboarding-points">
                <p><strong>Privacidad local.</strong> El audio se procesa en este equipo y se descarta al terminar.</p>
                <p><strong>Sin cuentas.</strong> No enviamos texto, audio ni diagnósticos a ningún servidor.</p>
                <p><strong>Sin servicios de transcripción.</strong> Chamu usa Whisper local y sólo descarga el modelo si tú lo autorizas.</p>
              </div>
            </>
          )}

          {step === "language" && (
            <>
              <h2 id="onboarding-title">Elige tu idioma</h2>
              <p className="welcome-copy">El idioma del modelo queda fijo para que el dictado sea predecible.</p>
              <fieldset className="choice-list">
                <legend className="sr-only">Idioma de Chamu</legend>
                <label className="choice-card">
                  <input
                    checked={settings.language === "es"}
                    name="language"
                    onChange={() => setSettings((current) => ({ ...current, language: "es" as AppLanguage }))}
                    type="radio"
                    value="es"
                  />
                  <span><strong>Español</strong><small>Interfaz y dictado en español</small></span>
                </label>
                <label className="choice-card">
                  <input
                    checked={settings.language === "en"}
                    name="language"
                    onChange={() => setSettings((current) => ({ ...current, language: "en" as AppLanguage }))}
                    type="radio"
                    value="en"
                  />
                  <span><strong>English</strong><small>Interfaz y dictado en inglés</small></span>
                </label>
              </fieldset>
            </>
          )}

          {step === "model" && (
            <>
              <h2 id="onboarding-title">Prepara el modelo</h2>
              <p className="welcome-copy">Whisper base multilingüe funciona sin conexión y ocupa unos 142 MiB.</p>
              <div className={`check-panel ${modelReady ? "check-panel--ok" : ""}`}>
                <strong>{model?.name ?? "Whisper base multilingüe"}</strong>
                <span>{modelError ?? getModelDescription(model)}</span>
                {model?.checksumValid === false && model.installed && <small>La validación SHA-256 falló. El archivo local no se usará.</small>}
              </div>
              <button className="secondary-button" onClick={() => void inspectExistingModel()} type="button">Buscar un modelo existente</button>
              {model && !modelReady && !downloading && (
                <button className="primary-button" onClick={() => setDownloadConsent(true)} type="button">
                  Descargar modelo (142 MiB)
                </button>
              )}
              {downloadConsent && !downloading && (
                <div className="consent-panel" role="dialog" aria-label="Confirmar descarga del modelo">
                  <p><strong>¿Confirmas descargar el modelo?</strong></p>
                  <p>La descarga sólo comienza con tu confirmación. No se conecta a ningún servicio de transcripción: es un archivo oficial para procesamiento local.</p>
                  <div className="button-row">
                    <button className="secondary-button" onClick={() => setDownloadConsent(false)} type="button">Ahora no</button>
                    <button className="primary-button" onClick={() => void confirmDownload()} type="button">Confirmar descarga</button>
                  </div>
                </div>
              )}
              {downloading && (
                <div className="download-panel" role="status">
                  <span>Descargando y validando checksum…</span>
                  <button className="secondary-button" onClick={() => void cancelDownload()} type="button">Cancelar descarga</button>
                </div>
              )}
            </>
          )}

          {step === "microphone" && (
            <>
              <h2 id="onboarding-title">Prueba el micrófono</h2>
              <p className="welcome-copy">Sólo comprobamos el permiso y que exista un dispositivo. Chamu no guarda audio.</p>
              <button className="primary-button" onClick={() => void checkMicrophone()} type="button">Probar micrófono</button>
              {microphoneChecked && <p className="success-message">Micrófono listo para dictar.</p>}
              {microphoneError && <p className="error-message">{microphoneError}</p>}
            </>
          )}

          {step === "shortcut" && (
            <>
              <h2 id="onboarding-title">Configura el atajo</h2>
              <p className="welcome-copy">Proponemos <kbd>Ctrl + Super</kbd>. Pruébalo y, si tu escritorio no lo captura, elige una alternativa.</p>
              <button className="primary-button" onClick={() => void checkShortcut(PROPOSED_SHORTCUT)} type="button">Probar atajo Ctrl + Super</button>
              {shortcutNeedsAlternative && <p className="error-message">No se pudo capturar. Elige y prueba una alternativa antes de continuar.</p>}
              {shortcutError && !shortcutNeedsAlternative && <p className="error-message">{shortcutError}</p>}
              {shortcutChecked && !shortcutNeedsAlternative && <p className="success-message">Atajo listo: {settings.shortcut}.</p>}
              <div className="alternative-list" aria-label="Alternativas de atajo">
                {ALTERNATIVE_SHORTCUTS.map((alternative) => (
                  <button className="secondary-button" key={alternative} onClick={() => void checkShortcut(alternative)} type="button">
                    Probar {alternative.replace("+", " + ")}
                  </button>
                ))}
              </div>
            </>
          )}

          {step === "clipboard" && (
            <>
              <h2 id="onboarding-title">Comprueba el portapapeles</h2>
              <p className="welcome-copy">Pegaremos una prueba y la retiraremos. El texto dictado nunca pasa por diagnósticos.</p>
              <button className="primary-button" onClick={() => void checkClipboardAndPaste()} type="button">Probar portapapeles y pegado</button>
              {clipboardChecked && <p className="success-message">Portapapeles y pegado listos.</p>}
              {clipboardError && <p className="error-message">{clipboardError}</p>}
            </>
          )}

          {step === "mode" && (
            <>
              <h2 id="onboarding-title">Elige el modo de dictado</h2>
              <p className="welcome-copy">Puedes mantener el atajo mientras hablas o pulsarlo una vez para alternar.</p>
              <fieldset className="choice-list">
                <legend className="sr-only">Modo de grabación</legend>
                <label className="choice-card">
                  <input checked={settings.mode === "hold"} name="mode" onChange={() => setSettings((current) => ({ ...current, mode: "hold" as RecordingMode }))} type="radio" value="hold" />
                  <span><strong>Mantener pulsado</strong><small>Graba mientras mantienes el atajo</small></span>
                </label>
                <label className="choice-card">
                  <input checked={settings.mode === "toggle"} name="mode" onChange={() => setSettings((current) => ({ ...current, mode: "toggle" as RecordingMode }))} type="radio" value="toggle" />
                  <span><strong>Pulsar para alternar</strong><small>Una pulsación empieza y otra termina</small></span>
                </label>
              </fieldset>
              {saveError && <p className="error-message">{saveError}</p>}
            </>
          )}

          <div className="onboarding-actions">
            <button className="primary-button" disabled={!canContinue || saving} onClick={goForward} type="button">
              {saving ? "Guardando…" : step === "mode" ? "Terminar configuración" : "Continuar"}
            </button>
          </div>
        </section>
      </div>

      <footer className="app-footer">
        <span>Sin cuentas · Sin telemetría · Sin nube</span>
        <span>v0.1.3</span>
      </footer>
    </main>
  );
}
