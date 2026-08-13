import { useEffect, useRef, useState } from "react";
import { createRecordingState, type RecordingState } from "../domain/recording";
import { DEFAULT_SETTINGS, type AppSettings } from "../domain/settings";
import {
  nativeBridge,
  type ClipboardCheck,
  type DictationResult,
  type ChamuBridge,
  type HistoryEntry,
  type MicrophoneCheck,
  type ModelStatus,
} from "../native/commands";
import { PrivacyBadge } from "./PrivacyBadge";
import { ShortcutField } from "./ShortcutField";
import { StatusBubble } from "./StatusBubble";

interface AppShellProps {
  recordingState?: RecordingState;
  settings?: AppSettings;
  bridge?: ChamuBridge;
  initialHistory?: HistoryEntry[];
}

export function AppShell({
  recordingState,
  settings = DEFAULT_SETTINGS,
  bridge,
  initialHistory,
}: AppShellProps) {
  const activeBridge = bridge ?? nativeBridge;
  const [currentRecordingState, setCurrentRecordingState] = useState<RecordingState>(
    () => recordingState ?? createRecordingState(),
  );
  const [currentSettings, setCurrentSettings] = useState<AppSettings>(settings);
  const [history, setHistory] = useState<HistoryEntry[]>(initialHistory ?? []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftSettings, setDraftSettings] = useState<AppSettings>(settings);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [copiedEntryId, setCopiedEntryId] = useState<string | number | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [dictationActionPending, setDictationActionPending] = useState(false);
  const [systemCheckOpen, setSystemCheckOpen] = useState(false);
  const [checkingSystem, setCheckingSystem] = useState(false);
  const [systemCheck, setSystemCheck] = useState<{
    model?: ModelStatus;
    microphone?: MicrophoneCheck;
    clipboard?: ClipboardCheck;
    paste?: ClipboardCheck;
    error?: string;
  }>({});
  const [shortcutRegistrationError, setShortcutRegistrationError] = useState<string | null>(null);
  const shortcutHandlerRef = useRef<(state: "Pressed" | "Released") => void>(() => undefined);

  useEffect(() => {
    if (recordingState) setCurrentRecordingState(recordingState);
  }, [recordingState]);

  useEffect(() => {
    setCurrentSettings(settings);
    setDraftSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (!bridge || initialHistory) return;

    let cancelled = false;
    void bridge.loadHistory().then((entries) => {
      if (!cancelled) setHistory(entries);
    }).catch((error: unknown) => {
      if (!cancelled) setHistoryError(error instanceof Error ? error.message : "No se pudo cargar el historial");
    });

    return () => {
      cancelled = true;
    };
  }, [bridge, initialHistory]);

  const modeLabel = currentSettings.mode === "hold" ? "Mantener pulsado" : "Pulsar para alternar";

  function openSettings() {
    setDraftSettings(currentSettings);
    setSettingsError(null);
    setSettingsOpen(true);
  }

  function openSystemCheck() {
    setSystemCheck({});
    setSystemCheckOpen(true);
  }

  async function runSystemCheck() {
    setCheckingSystem(true);
    setSystemCheck({});
    try {
      const [model, microphone, clipboard, paste] = await Promise.all([
        activeBridge.inspectModel("base"),
        activeBridge.testMicrophone(),
        activeBridge.testClipboard(),
        activeBridge.testPaste(),
      ]);
      setSystemCheck({ model, microphone, clipboard, paste });
    } catch (error: unknown) {
      setSystemCheck({ error: getErrorMessage(error, "No se pudo completar la comprobación local") });
    } finally {
      setCheckingSystem(false);
    }
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

  async function copyEntry(entry: HistoryEntry) {
    setHistoryError(null);
    try {
      await activeBridge.copyHistory(entry.id);
      setCopiedEntryId(entry.id);
      window.setTimeout(() => setCopiedEntryId((current) => current === entry.id ? null : current), 1800);
    } catch (error: unknown) {
      setHistoryError(error instanceof Error ? error.message : "No se pudo copiar la entrada");
    }
  }

  async function deleteEntry(entry: HistoryEntry) {
    setHistoryError(null);
    try {
      await activeBridge.deleteHistory(entry.id);
      setHistory((current) => current.filter((candidate) => candidate.id !== entry.id));
    } catch (error: unknown) {
      setHistoryError(error instanceof Error ? error.message : "No se pudo borrar la entrada");
    }
  }

  async function handleDictation() {
    if (dictationActionPending || currentRecordingState.status === "transcribing") return;

    if (currentRecordingState.status === "recording") {
      await stopDictation();
      return;
    }

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
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;

    let disposed = false;
    const shortcut = currentSettings.shortcut;
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
  }, [currentSettings.shortcut]);

  async function startDictation() {
    setDictationActionPending(true);
    setHistoryError(null);
    try {
      if (!activeBridge.startDictation) {
        throw new Error("El dictado nativo no está disponible");
      }
      const result = await activeBridge.startDictation();
      applyDictationResult(result, "recording");
    } catch (error: unknown) {
      setCurrentRecordingState({ status: "error", message: getErrorMessage(error, "No se pudo iniciar el dictado") });
    } finally {
      setDictationActionPending(false);
    }
  }

  async function stopDictation() {
    setCurrentRecordingState({ status: "transcribing" });
    setDictationActionPending(true);
    setHistoryError(null);
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
        void refreshHistoryAfterDictation(result);
        return;
      case "error":
        setCurrentRecordingState({
          status: "error",
          message: result.message ?? "No se pudo completar el dictado",
        });
        return;
    }
  }

  async function refreshHistoryAfterDictation(result: DictationResult) {
    if (result.historyEntry) {
      setHistory((current) => [
        result.historyEntry!,
        ...current.filter((entry) => entry.id !== result.historyEntry!.id),
      ]);
      return;
    }

    try {
      const entries = await activeBridge.loadHistory();
      setHistory(entries);
    } catch {
      // The dictation already completed. A history refresh failure is local UI
      // feedback and must not turn a successful transcription into an error.
    }
  }

  const dictationButtonLabel = getDictationButtonLabel(currentRecordingState, dictationActionPending);
  const dictationButtonDisabled = dictationActionPending || currentRecordingState.status === "transcribing";

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
          <button className="settings-button" onClick={openSystemCheck} type="button" aria-label="Abrir prueba del sistema">
            <span aria-hidden="true">✓</span>
            <span>Prueba del sistema</span>
          </button>
          <button className="settings-button" onClick={openSettings} type="button" aria-label="Abrir configuración">
            <span aria-hidden="true">⚙</span>
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
          <div className="dictation-action-row">
            <button
              aria-busy={dictationActionPending}
              className="primary-button dictation-action"
              data-status={currentRecordingState.status}
              disabled={dictationButtonDisabled}
              onClick={() => void handleDictation()}
              type="button"
            >
              {dictationButtonLabel}
            </button>
          </div>
          <div className="shortcut-row">
            <span>Atajo global</span>
            <kbd>{currentSettings.shortcut.replace("CommandOrControl", "⌘/Ctrl").replaceAll("+", " + ")}</kbd>
          </div>
          {shortcutRegistrationError && <p className="error-message shortcut-error">Atajo global: {shortcutRegistrationError}</p>}
        </section>
        <p className="mode-note">Modo: {modeLabel}</p>

        <section className="history-panel" aria-labelledby="history-title">
          <div className="history-heading">
            <div>
              <p className="eyebrow">SÓLO TEXTO</p>
              <h2 id="history-title">Historial</h2>
            </div>
            <span className="history-retention">Se conserva en este equipo</span>
          </div>
          {historyError && <p className="error-message">{historyError}</p>}
          {history.length === 0 ? (
            <p className="history-empty">Todavía no hay dictados guardados.</p>
          ) : (
            <ul className="history-list">
              {history.map((entry) => (
                <li className="history-entry" key={String(entry.id)}>
                  <div className="history-entry__body">
                    <p>{entry.text}</p>
                    <time dateTime={getHistoryTimestamp(entry)}>{formatHistoryDate(getHistoryTimestamp(entry))}</time>
                  </div>
                  <div className="history-entry__actions">
                    <button className="text-button" onClick={() => void copyEntry(entry)} type="button">
                      {copiedEntryId === entry.id ? "Copiado" : "Copiar"}
                    </button>
                    <button className="text-button text-button--danger" onClick={() => void deleteEntry(entry)} type="button">Borrar</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {settingsOpen && (
        <section className="settings-panel" role="dialog" aria-label="Configuración">
          <div className="settings-panel__header">
            <div>
              <p className="eyebrow">PREFERENCIAS</p>
              <h2>Configuración</h2>
            </div>
            <button className="icon-button" onClick={() => setSettingsOpen(false)} type="button" aria-label="Cerrar configuración">×</button>
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
          <fieldset className="choice-list">
            <legend>Modo de grabación</legend>
            <label className="choice-card">
              <input checked={draftSettings.mode === "hold"} name="settings-mode" onChange={() => setDraftSettings((current) => ({ ...current, mode: "hold" }))} type="radio" value="hold" />
              <span><strong>Mantener pulsado</strong><small>Graba mientras mantienes el atajo</small></span>
            </label>
            <label className="choice-card">
              <input checked={draftSettings.mode === "toggle"} name="settings-mode" onChange={() => setDraftSettings((current) => ({ ...current, mode: "toggle" }))} type="radio" value="toggle" />
              <span><strong>Pulsar para alternar</strong><small>Una pulsación empieza y otra termina</small></span>
            </label>
          </fieldset>
          <ShortcutField
            value={draftSettings.shortcut}
            onChange={(shortcut) => setDraftSettings((current) => ({ ...current, shortcut }))}
            onError={(message) => setSettingsError(message ?? null)}
          />
          {settingsError && <p className="error-message">{settingsError}</p>}
          <div className="settings-panel__actions">
            <button className="secondary-button" onClick={() => setSettingsOpen(false)} type="button">Cancelar</button>
            <button className="primary-button" disabled={savingSettings} onClick={() => void saveSettings()} type="button">{savingSettings ? "Guardando…" : "Guardar configuración"}</button>
          </div>
        </section>
      )}

      {systemCheckOpen && (
        <section className="settings-panel system-check-panel" role="dialog" aria-label="Prueba del sistema">
          <div className="settings-panel__header">
            <div>
              <p className="eyebrow">PRUEBA LOCAL</p>
              <h2>Prueba del sistema</h2>
            </div>
            <button className="icon-button" onClick={() => setSystemCheckOpen(false)} type="button" aria-label="Cerrar prueba del sistema">×</button>
          </div>
          <p className="system-check-intro">Comprueba modelo, micrófono, portapapeles y pegado sin enviar ni conservar audio o texto.</p>
          <button className="primary-button" disabled={checkingSystem} onClick={() => void runSystemCheck()} type="button">
            {checkingSystem ? "Comprobando…" : "Ejecutar comprobaciones"}
          </button>
          {systemCheck.error && <p className="error-message">{systemCheck.error}</p>}
          {systemCheck.model && <SystemCheckRow label="Modelo Whisper" ok={systemCheck.model.installed && systemCheck.model.checksumValid} detail={systemCheck.model.installed && systemCheck.model.checksumValid ? "Modelo validado y listo para dictar." : "Falta el modelo o no pasó la validación; vuelve a ejecutar el onboarding."} />}
          {systemCheck.microphone && <SystemCheckRow label="Micrófono" ok={systemCheck.microphone.ok} detail={systemCheck.microphone.message} />}
          {systemCheck.clipboard && <SystemCheckRow label="Portapapeles" ok={systemCheck.clipboard.ok} detail={systemCheck.clipboard.message} />}
          {systemCheck.paste && <SystemCheckRow label="Pegado en app activa" ok={systemCheck.paste.ok} detail={systemCheck.paste.message} />}
          <p className="system-check-note">El botón principal sirve para comprobar el dictado en esta ventana. Para el atajo global, prueba la tecla configurada desde otra aplicación una vez que esté disponible en tu sesión.</p>
        </section>
      )}

      <footer className="app-footer">
        <span>Sin cuentas · Sin telemetría · Sin nube</span>
        <span>v0.1.2</span>
      </footer>
    </main>
  );
}

function SystemCheckRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return <div className={`system-check-row ${ok ? "system-check-row--ok" : "system-check-row--error"}`}>
    <strong>{ok ? "Listo" : "Requiere atención"} · {label}</strong>
    <span>{detail}</span>
  </div>;
}

function getDictationButtonLabel(state: RecordingState, pending: boolean): string {
  if (pending && state.status === "recording") return "Iniciando…";
  if (pending && state.status === "transcribing") return "Transcribiendo…";
  switch (state.status) {
    case "ready":
      return "Comenzar dictado";
    case "recording":
      return "Terminar dictado";
    case "transcribing":
      return "Transcribiendo…";
    case "copied":
      return "Nuevo dictado";
    case "error":
      return "Reintentar dictado";
  }
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatHistoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function getHistoryTimestamp(entry: HistoryEntry): string {
  if (entry.createdAt) return entry.createdAt;
  if (entry.timestamp === undefined || entry.timestamp === null) return "";
  const numericTimestamp = typeof entry.timestamp === "number" ? entry.timestamp : Number(entry.timestamp);
  if (Number.isFinite(numericTimestamp)) return new Date(numericTimestamp).toISOString();
  return String(entry.timestamp);
}
