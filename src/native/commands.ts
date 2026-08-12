import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../domain/settings";

export interface ModelStatus {
  id: string;
  name: string;
  installed: boolean;
  checksumValid: boolean;
  sizeMiB: number;
  progress?: number;
  error?: string;
}

export interface MicrophoneCheck {
  ok: boolean;
  message: string;
}

export interface ShortcutCheck {
  ok: boolean;
  captured: string;
  message?: string;
}

export interface ClipboardCheck {
  ok: boolean;
  message: string;
}

export interface HistoryEntry {
  id: string | number;
  text: string;
  /** Browser-friendly ISO timestamp. Native history currently returns `timestamp`. */
  createdAt?: string;
  timestamp?: string | number;
}

/**
 * Result returned by one complete native dictation operation.
 *
 * `transcribing` is intentionally a first-class result: stopping the capture
 * hands the in-memory audio to the local engine and can take a while. No
 * audio or temporary path crosses this bridge.
 */
export interface DictationResult {
  status: "ready" | "recording" | "transcribing" | "copied" | "error";
  text?: string;
  historyEntry?: HistoryEntry;
  message?: string;
}

/**
 * The browser-facing contract for the native side of Chamu.
 *
 * Audio is intentionally absent from this interface. A microphone probe only
 * returns whether the permission/device check succeeded; it never returns a
 * recording or a path to one.
 */
export interface ChamuBridge {
  loadSettings: () => Promise<AppSettings>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  inspectModel: (modelId?: string) => Promise<ModelStatus>;
  downloadModel: (modelId: string) => Promise<ModelStatus>;
  cancelModelDownload: (modelId: string) => Promise<void>;
  testMicrophone: () => Promise<MicrophoneCheck>;
  testShortcut: (shortcut: string) => Promise<ShortcutCheck>;
  testClipboard: () => Promise<ClipboardCheck>;
  testPaste: () => Promise<ClipboardCheck>;
  loadHistory: () => Promise<HistoryEntry[]>;
  copyHistory: (id: string | number) => Promise<void>;
  deleteHistory: (id: string | number) => Promise<void>;
  /** Optional to keep browser/test bridges source-compatible; nativeBridge provides both. */
  startDictation?: () => Promise<DictationResult | void>;
  stopDictation?: () => Promise<DictationResult | void>;
}

/** Native bridge kept intentionally small; audio never crosses this boundary. */
export function loadSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_settings");
}

export function saveSettings(settings: AppSettings): Promise<void> {
  return invoke("set_settings", { settings });
}

export function setRecordingActive(active: boolean): Promise<void> {
  return invoke("set_recording_active", { active });
}

export function startDictation(): Promise<DictationResult> {
  return invoke<DictationResult>("start_dictation");
}

export function stopDictation(): Promise<DictationResult> {
  return invoke<DictationResult>("stop_dictation");
}

export function showMainWindow(): Promise<void> {
  return invoke("show_main_window");
}

export function inspectModel(modelId?: string): Promise<ModelStatus> {
  return modelId === undefined
    ? invoke<ModelStatus>("inspect_model")
    : invoke<ModelStatus>("inspect_model", { modelId });
}

export function downloadModel(modelId: string): Promise<ModelStatus> {
  return invoke<ModelStatus>("download_model", { modelId });
}

export function cancelModelDownload(modelId: string): Promise<void> {
  return invoke("cancel_model_download", { modelId });
}

export function testMicrophone(): Promise<MicrophoneCheck> {
  return invoke<MicrophoneCheck>("test_microphone");
}

export function testShortcut(shortcut: string): Promise<ShortcutCheck> {
  return invoke<ShortcutCheck>("test_shortcut", { shortcut });
}

export function testClipboard(): Promise<ClipboardCheck> {
  return invoke<ClipboardCheck>("test_clipboard");
}

export function testPaste(): Promise<ClipboardCheck> {
  return invoke<ClipboardCheck>("test_paste");
}

export function loadHistory(): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>("get_history");
}

export function copyHistory(id: string | number): Promise<void> {
  return invoke("copy_history_entry", { id });
}

export function deleteHistory(id: string | number): Promise<void> {
  return invoke("delete_history", { id });
}

export const nativeBridge: ChamuBridge = {
  loadSettings,
  saveSettings,
  inspectModel,
  downloadModel,
  cancelModelDownload,
  testMicrophone,
  testShortcut,
  testClipboard,
  testPaste,
  loadHistory,
  copyHistory,
  deleteHistory,
  startDictation,
  stopDictation,
};
