import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { AppSettings } from "../domain/settings";
import type { RecordingState } from "../domain/recording";
import type { DictationResult, WaylandHoldShortcutEvent } from "../native/commands";
import { DictationControl } from "./DictationControl";
import { ShortcutField } from "./ShortcutField";

export interface DictationTesterProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  state: RecordingState;
  pending: boolean;
  starting?: boolean;
  microphoneName?: string;
  onDictationClick: () => void | Promise<void>;
  onShortcutCaptured?: (shortcut: string) => void;
  onCapturingChange?: (capturing: boolean) => void;
  resultText?: DictationResult["text"];
  resultId?: string | number;
  shortcutRegistrationError?: string | null;
  onShortcutRegistrationError?: (message?: string) => void;
  waylandShortcutStatus?: WaylandHoldShortcutEvent;
}

export interface DictationTesterHandle {
  prepareForDictation: () => void;
}

export const DictationTester = forwardRef<DictationTesterHandle, DictationTesterProps>(function DictationTester({
  settings,
  onSettingsChange,
  state,
  pending,
  starting = false,
  microphoneName = "Micrófono predeterminado del sistema",
  onDictationClick,
  onShortcutCaptured,
  onCapturingChange,
  resultText,
  resultId,
  shortcutRegistrationError,
  onShortcutRegistrationError,
  waylandShortcutStatus,
}, ref) {
  const [text, setText] = useState("");
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const textAreaFocusedRef = useRef(false);
  const dictationInputRef = useRef<{ start: number; end: number } | null>(null);
  const consumedResultRef = useRef<string | number | undefined>(undefined);
  const [copiedOnlyMessage, setCopiedOnlyMessage] = useState<string>();

  useEffect(() => {
    if (resultText === undefined || resultText === "") {
      consumedResultRef.current = undefined;
      dictationInputRef.current = null;
      return;
    }
    if (resultId !== undefined && consumedResultRef.current === resultId) return;

    if (resultId !== undefined) consumedResultRef.current = resultId;
    const textArea = textAreaRef.current;
    const selection = dictationInputRef.current;
    if (textArea && selection) {
      const currentText = textArea.value;
      const before = currentText.slice(0, selection.start);
      const after = currentText.slice(selection.end);
      const nextText = `${before}${resultText}${after}`;
      setText(nextText);
      setCopiedOnlyMessage(undefined);
      const cursor = selection.start + resultText.length;
      requestAnimationFrame(() => {
        textArea.focus();
        textArea.setSelectionRange(cursor, cursor);
      });
      dictationInputRef.current = null;
      return;
    }

    setCopiedOnlyMessage("Texto dictado copiado al portapapeles. Haz foco en el área para escribir una prueba.");
  }, [resultId, resultText]);

  function updateMode(mode: AppSettings["mode"]) {
    onSettingsChange({ ...settings, mode });
  }

  function updateTextAreaSelection() {
    const textArea = textAreaRef.current;
    if (!textArea) return;
    textAreaFocusedRef.current = true;
  }

  function handleTextAreaBlur() {
    textAreaFocusedRef.current = false;
  }

  function captureDictationInput() {
    const textArea = textAreaRef.current;
    if (state.status === "recording") return;
    if (textArea && (textAreaFocusedRef.current || document.activeElement === textArea)) {
      dictationInputRef.current = {
        start: textArea.selectionStart,
        end: textArea.selectionEnd,
      };
      return;
    }
  }

  useImperativeHandle(ref, () => ({ prepareForDictation: captureDictationInput }), [state.status]);

  function handleDictationClick() {
    captureDictationInput();
    void onDictationClick();
  }

  return (
    <section className="dictation-tester" aria-label="Probador de dictado">
      <div className="dictation-tester__header">
        <div>
          <p className="eyebrow">PRUEBA LOCAL</p>
          <h2>Prueba el dictado</h2>
        </div>
        <div onMouseDown={captureDictationInput}>
          <DictationControl
            disabled={pending || starting || state.status === "transcribing"}
            onClick={handleDictationClick}
            pending={pending}
            state={state}
          />
        </div>
      </div>
      {starting && <p className="dictation-tester__preparing" role="status">Preparando micrófono…</p>}
      <p className="dictation-tester__microphone">Micrófono activo: {microphoneName || "Micrófono predeterminado del sistema"}</p>

      <label className="dictation-tester__label" htmlFor="dictation-tester-text">Texto de prueba</label>
      <textarea
        ref={textAreaRef}
        id="dictation-tester-text"
        aria-label="Texto de prueba"
        className="dictation-tester__text"
        onChange={(event) => setText(event.target.value)}
        onFocus={updateTextAreaSelection}
        onBlur={handleTextAreaBlur}
        onClick={updateTextAreaSelection}
        onSelect={updateTextAreaSelection}
        onKeyUp={updateTextAreaSelection}
        value={text}
      />
      {copiedOnlyMessage && <p className="dictation-tester__result" role="status">{copiedOnlyMessage}</p>}
      {shortcutRegistrationError && <p className="error-message" role="alert">Atajo global: {shortcutRegistrationError}</p>}
      {waylandShortcutStatus && (
        <p className={waylandShortcutStatus.status === "error" ? "error-message" : "dictation-tester__shortcut-status"} role={waylandShortcutStatus.status === "error" ? "alert" : "status"}>
          {formatWaylandShortcutStatus(waylandShortcutStatus)}
        </p>
      )}

      <fieldset className="choice-list">
        <legend>Modo de grabación</legend>
        <label className="choice-card">
          <input
            checked={settings.mode === "hold"}
            name="dictation-tester-mode"
            onChange={() => updateMode("hold")}
            type="radio"
            value="hold"
          />
          <span><strong>Mantener pulsado</strong><small>Graba mientras mantienes el atajo</small></span>
        </label>
        <label className="choice-card">
          <input
            checked={settings.mode === "toggle"}
            name="dictation-tester-mode"
            onChange={() => updateMode("toggle")}
            type="radio"
            value="toggle"
          />
          <span><strong>Pulsar para alternar</strong><small>Una pulsación empieza y otra termina</small></span>
        </label>
      </fieldset>

      <ShortcutField
        value={settings.shortcut}
        onChange={(shortcut) => {
          onSettingsChange({ ...settings, shortcut });
          onShortcutCaptured?.(shortcut);
        }}
        onError={onShortcutRegistrationError}
        onCapturingChange={onCapturingChange}
      />
    </section>
  );
});

function formatWaylandShortcutStatus(event: WaylandHoldShortcutEvent): string {
  if (event.status === "error") {
    return `Atajo Wayland: ${event.message ?? "error"}`;
  }

  const labels: Record<Exclude<WaylandHoldShortcutEvent["status"], "error">, string> = {
    registered: "registrado",
    pressed: "presionado",
    released: "soltado",
  };
  const trigger = event.triggerDescription ? ` (${event.triggerDescription})` : "";
  const message = event.message ? ` — ${event.message}` : "";
  return `Atajo Wayland: ${labels[event.status]}${trigger}${message}`;
}
