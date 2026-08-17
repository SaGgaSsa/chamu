import { useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export const DEFAULT_SHORTCUT = "CommandOrControl+Shift+Space";

type ShortcutResult = { shortcut?: string; error?: string };

const MODIFIER_CODES = new Set([
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
  "ShiftLeft",
  "ShiftRight",
]);

const MODIFIER_KEYS = new Set([
  "Alt",
  "Control",
  "Ctrl",
  "Meta",
  "OS",
  "Shift",
  "Super",
  "Win",
  "Windows",
]);

const KEY_ALIASES: Record<string, string> = {
  " ": "Space",
  "!": "Digit1",
  "\"": "Quote",
  "#": "Digit3",
  "$": "Digit4",
  "%": "Digit5",
  "&": "Digit7",
  "'": "Quote",
  "(": "Digit9",
  ")": "Digit0",
  "*": "NumpadMultiply",
  "+": "NumpadAdd",
  ",": "Comma",
  "-": "Minus",
  ".": "Period",
  "/": "Slash",
  ":": "Semicolon",
  ";": "Semicolon",
  "<": "Comma",
  "=": "Equal",
  ">": "Period",
  "?": "Slash",
  "@": "Digit2",
  "[": "BracketLeft",
  "\\": "Backslash",
  "]": "BracketRight",
  "^": "Digit6",
  "_": "Minus",
  "`": "Backquote",
  "{": "BracketLeft",
  "|": "Backslash",
  "}": "BracketRight",
  Add: "NumpadAdd",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  ArrowUp: "ArrowUp",
  Backquote: "Backquote",
  Backslash: "Backslash",
  Backspace: "Backspace",
  BracketLeft: "BracketLeft",
  BracketRight: "BracketRight",
  CapsLock: "CapsLock",
  Comma: "Comma",
  Delete: "Delete",
  Down: "ArrowDown",
  End: "End",
  Enter: "Enter",
  Esc: "Escape",
  Escape: "Escape",
  Equal: "Equal",
  Home: "Home",
  Insert: "Insert",
  Left: "ArrowLeft",
  Minus: "Minus",
  NumpadAdd: "NumpadAdd",
  NumpadDecimal: "NumpadDecimal",
  NumpadDivide: "NumpadDivide",
  NumpadEnter: "NumpadEnter",
  NumpadEqual: "NumpadEqual",
  NumpadMultiply: "NumpadMultiply",
  NumpadSubtract: "NumpadSubtract",
  PageDown: "PageDown",
  PageUp: "PageUp",
  Pause: "Pause",
  Period: "Period",
  Right: "ArrowRight",
  ScrollLock: "ScrollLock",
  Semicolon: "Semicolon",
  Slash: "Slash",
  Space: "Space",
  Tab: "Tab",
  Up: "ArrowUp",
};

function isModifierKey(code: string, key: string): boolean {
  return MODIFIER_CODES.has(code) || MODIFIER_KEYS.has(key);
}

const META_CODES = new Set(["MetaLeft", "MetaRight", "OSLeft", "OSRight"]);

/**
 * WebKitGTK reports the Super/Windows key as `key: "Super"` with
 * `code: "OSLeft"` and without setting `metaKey`. Detect it from the code or
 * key name too so the modifier is not lost during capture.
 */
function isMetaModifier(event: KeyboardEvent): boolean {
  const code = event.code ?? "";
  const key = event.key ?? "";
  return (
    event.metaKey
    || META_CODES.has(code)
    || key === "Meta"
    || key === "OS"
    || key === "Super"
  );
}

function isMetaCodePressed(codes: ReadonlySet<string>): boolean {
  return [...META_CODES].some((code) => codes.has(code));
}

function normalizeMainKey(event: KeyboardEvent): string {
  const code = event.code?.trim() ?? "";
  const rawKey = event.key ?? "";
  const key = rawKey === " " ? rawKey : rawKey.trim();
  const source = code && code !== "Unidentified" ? code : key;

  if (!source || isModifierKey(code, key)) return "";

  if (/^Key[A-Za-z]$/.test(source)) return source.slice(3).toUpperCase();
  if (/^Digit[0-9]$/.test(source)) return source.slice(5);
  if (/^F[0-9]{1,2}$/i.test(source)) return source.toUpperCase();
  if (/^[A-Za-z]$/.test(source)) return source.toUpperCase();
  if (/^[0-9]$/.test(source)) return source;

  return KEY_ALIASES[source] ?? KEY_ALIASES[key] ?? source;
}

/**
 * Converts a browser key event to the format accepted by the global shortcut
 * plugin. The event must contain one main key and one or two modifiers.
 */
export function normalizeShortcutFromKeyboardEvent(
  event: KeyboardEvent,
  pressedModifierCodes: ReadonlySet<string> = new Set(),
): ShortcutResult {
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("CommandOrControl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (isMetaModifier(event) || isMetaCodePressed(pressedModifierCodes)) {
    modifiers.push("Meta");
  }

  const mainKey = normalizeMainKey(event);
  const keyCount = modifiers.length + (mainKey ? 1 : 0);

  if (keyCount > 3 || modifiers.length > 2) {
    return { error: "El atajo no puede tener más de tres teclas." };
  }

  if (!mainKey) {
    return {
      error: modifiers.length
        ? "Selecciona una tecla principal además de los modificadores."
        : "No se detectó una tecla principal.",
    };
  }

  if (modifiers.length === 0) {
    return { error: "Usa uno o dos modificadores con la tecla principal." };
  }

  return { shortcut: [...modifiers, mainKey].join("+") };
}

export interface ShortcutFieldProps {
  value: string;
  onChange: (shortcut: string) => void;
  onError?: (message?: string) => void;
  onCapturingChange?: (capturing: boolean) => void;
  label?: string;
  disabled?: boolean;
}

export function normalizeShortcutForPlatform(
  shortcut: string,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): string {
  const modifier = /mac/i.test(platform) ? "Command" : "Ctrl";
  return shortcut.replace("CommandOrControl", modifier);
}

export function ShortcutField({
  value,
  onChange,
  onError,
  onCapturingChange,
  label = "Atajo global",
  disabled = false,
}: ShortcutFieldProps) {
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string>();
  const [capturePreview, setCapturePreview] = useState<string | null>(null);
  const captureButtonRef = useRef<HTMLButtonElement>(null);
  const pressedModifierCodesRef = useRef(new Set<string>());

  function reportError(message?: string) {
    setError(message);
    onError?.(message);
  }

  function clearError() {
    if (error !== undefined) onError?.(undefined);
    setError(undefined);
  }

  function startCapture() {
    if (disabled) return;
    clearError();
    setCapturePreview(null);
    setCapturing(true);
    pressedModifierCodesRef.current.clear();
    onCapturingChange?.(true);
    captureButtonRef.current?.focus();
  }

  function cancelCapture() {
    setCapturing(false);
    setCapturePreview(null);
    pressedModifierCodesRef.current.clear();
    clearError();
    onCapturingChange?.(false);
  }

  function modifierPreview(event: ReactKeyboardEvent<HTMLButtonElement>): string {
    const modifiers: string[] = [];
    if (event.ctrlKey) modifiers.push("Ctrl");
    if (event.altKey) modifiers.push("Alt");
    if (event.shiftKey) modifiers.push("Shift");
    if (isMetaModifier(event.nativeEvent)) modifiers.push("Meta");
    return `${modifiers.join(" + ")} + …`;
  }

  function captureKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!capturing) return;

    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape" || event.code === "Escape" || event.key === "Esc") {
      cancelCapture();
      return;
    }

    const code = event.code ?? "";
    if (code && isModifierKey(code, event.key)) {
      pressedModifierCodesRef.current.add(code);
    }

    const mainKey = normalizeMainKey(event.nativeEvent);
    const hasModifiers =
      event.ctrlKey || event.altKey || event.shiftKey || isMetaModifier(event.nativeEvent);
    if (!mainKey && hasModifiers) {
      setCapturePreview(modifierPreview(event));
      clearError();
      return;
    }

    const result = normalizeShortcutFromKeyboardEvent(
      event.nativeEvent,
      pressedModifierCodesRef.current,
    );
    if (result.shortcut) {
      pressedModifierCodesRef.current.clear();
      onChange(result.shortcut);
      setCapturing(false);
      setCapturePreview(null);
      reportError(undefined);
      onCapturingChange?.(false);
      return;
    }

    reportError(result.error ?? "No se pudo leer el atajo.");
  }

  function captureKeyUp(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!capturing) return;

    event.preventDefault();
    event.stopPropagation();

    const code = event.code ?? "";
    if (code && isModifierKey(code, event.key)) {
      pressedModifierCodesRef.current.delete(code);
    }

    const hasModifiers =
      event.ctrlKey || event.altKey || event.shiftKey || isMetaModifier(event.nativeEvent);
    setCapturePreview(hasModifiers ? modifierPreview(event) : null);
    clearError();
  }

  return (
    <div className="shortcut-field">
      <span className="shortcut-field__label">{label}</span>
      <output className="shortcut-field__value" aria-label={`${label}: valor actual`}>
        {(capturing && capturePreview !== null ? capturePreview : value) || "Sin definir"}
      </output>
      <button
        ref={captureButtonRef}
        type="button"
        className="shortcut-field__capture"
        aria-label={capturing ? "Pulsa el atajo de teclado" : "Capturar atajo"}
        aria-pressed={capturing}
        disabled={disabled}
        onClick={startCapture}
        onKeyDown={captureKey}
        onKeyUp={captureKeyUp}
      >
        {capturing ? "Pulsa el atajo…" : "Capturar atajo"}
      </button>
      {error ? (
        <span className="shortcut-field__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: unknown;
}

/**
 * Registers a shortcut only in Tauri to check availability, then unregisters
 * it in all cases. Browser builds intentionally perform no native operation.
 */
export async function probeGlobalShortcut(shortcut: string): Promise<void> {
  if (typeof window === "undefined" || !(window as TauriWindow).__TAURI_INTERNALS__) return;

  const { register, unregister } = await import("@tauri-apps/plugin-global-shortcut");
  const normalizedShortcut = normalizeShortcutForPlatform(shortcut);
  try {
    await register(normalizedShortcut, () => undefined);
  } finally {
    await unregister(normalizedShortcut);
  }
}
