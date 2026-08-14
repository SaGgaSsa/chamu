import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

export type ModelDownloadPhase =
  | "connecting"
  | "downloading"
  | "validating"
  | "completed"
  | "cancelled"
  | "failed";

export interface ModelDownloadProgress {
  modelId: string;
  phase: ModelDownloadPhase;
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
  message: string;
}

interface NativeModelDownloadProgress {
  modelId?: string;
  model_id?: string;
  phase: ModelDownloadPhase;
  downloadedBytes?: number;
  downloaded_bytes?: number;
  totalBytes?: number;
  total_bytes?: number;
  percent?: number;
  message: string;
}

export interface MicrophoneCheck {
  ok: boolean;
  message: string;
}

export interface MicrophoneInfo {
  name: string;
}

export type PlatformSession = "windows" | "x11" | "wayland" | "unknown";

export interface PlatformDiagnosis {
  session: PlatformSession;
  shortcutMethod: string;
  holdModeSupported: boolean;
  toggleModeSupported: boolean;
  waylandPortalAvailable?: boolean;
}

export type WaylandHoldShortcutStatus = "registered" | "pressed" | "released" | "error";

export interface WaylandHoldShortcutEvent {
  status: WaylandHoldShortcutStatus;
  message?: string;
  triggerDescription?: string;
}

export interface WaylandShortcutConfigurationOptions {
  requestConfiguration?: boolean;
}

export function shouldRequestWaylandShortcutConfiguration(
  previousShortcut: string | undefined,
  nextShortcut: string,
  hasRegisteredAssignment: boolean,
): boolean {
  return hasRegisteredAssignment && previousShortcut !== undefined && previousShortcut !== nextShortcut;
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
  pasted?: boolean;
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
  startModelDownload: (modelId: string) => Promise<void>;
  onModelDownloadProgress: (
    listener: (progress: ModelDownloadProgress) => void,
  ) => Promise<() => void>;
  cancelModelDownload: (modelId: string) => Promise<void>;
  testMicrophone: () => Promise<MicrophoneCheck>;
  getMicrophoneInfo?: () => Promise<MicrophoneInfo>;
  testShortcut: (shortcut: string) => Promise<ShortcutCheck>;
  testClipboard: () => Promise<ClipboardCheck>;
  testPaste: () => Promise<ClipboardCheck>;
  loadHistory: () => Promise<HistoryEntry[]>;
  copyHistory: (id: string | number) => Promise<void>;
  deleteHistory: (id: string | number) => Promise<void>;
  /** Optional to keep browser/test bridges source-compatible; nativeBridge provides both. */
  startDictation?: () => Promise<DictationResult | void>;
  stopDictation?: () => Promise<DictationResult | void>;
  /** Optional to keep browser/test bridges source-compatible; nativeBridge provides all portal methods. */
  diagnosePlatform?: () => Promise<PlatformDiagnosis>;
  configureWaylandHoldShortcut?: (
    shortcut: string,
    options?: WaylandShortcutConfigurationOptions,
  ) => Promise<void>;
  clearWaylandHoldShortcut?: () => Promise<void>;
  onWaylandHoldShortcut?: (
    listener: (event: WaylandHoldShortcutEvent) => void,
  ) => Promise<() => void>;
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

export function startModelDownload(modelId: string): Promise<void> {
  return invoke<void>("start_model_download", { modelId });
}

function toModelDownloadProgress(
  payload: NativeModelDownloadProgress,
): ModelDownloadProgress {
  const modelId = payload.modelId ?? payload.model_id;
  const downloadedBytes = payload.downloadedBytes ?? payload.downloaded_bytes;

  if (modelId === undefined || downloadedBytes === undefined) {
    throw new Error("Payload de progreso de descarga inválido");
  }

  const progress: ModelDownloadProgress = {
    modelId,
    phase: payload.phase,
    downloadedBytes,
    message: payload.message,
  };

  const totalBytes = payload.totalBytes ?? payload.total_bytes;
  if (totalBytes !== undefined) {
    progress.totalBytes = totalBytes;
  }
  if (payload.percent !== undefined) {
    progress.percent = payload.percent;
  }

  return progress;
}

export async function onModelDownloadProgress(
  listener: (progress: ModelDownloadProgress) => void,
): Promise<() => void> {
  return listen<NativeModelDownloadProgress>("model-download-progress", (event) => {
    listener(toModelDownloadProgress(event.payload));
  });
}

export function cancelModelDownload(modelId: string): Promise<void> {
  return invoke("cancel_model_download", { modelId });
}

export function testMicrophone(): Promise<MicrophoneCheck> {
  return invoke<MicrophoneCheck>("test_microphone");
}

export function getMicrophoneInfo(): Promise<MicrophoneInfo> {
  return invoke<MicrophoneInfo>("get_microphone_info");
}

export function testShortcut(shortcut: string): Promise<ShortcutCheck> {
  return invoke<ShortcutCheck>("test_shortcut", { shortcut });
}

export function diagnosePlatform(): Promise<PlatformDiagnosis> {
  return invoke<PlatformDiagnosis>("diagnose_platform");
}

export function configureWaylandHoldShortcut(
  shortcut: string,
  options?: WaylandShortcutConfigurationOptions,
): Promise<void> {
  return invoke("configure_wayland_hold_shortcut", {
    shortcut,
    requestConfiguration: options?.requestConfiguration ?? false,
  });
}

export function clearWaylandHoldShortcut(): Promise<void> {
  return invoke("clear_wayland_hold_shortcut");
}

export async function onWaylandHoldShortcut(
  listener: (event: WaylandHoldShortcutEvent) => void,
): Promise<() => void> {
  return listen<WaylandHoldShortcutEvent>("wayland-hold-shortcut", (event) => {
    listener(event.payload);
  });
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
  startModelDownload,
  onModelDownloadProgress,
  cancelModelDownload,
  testMicrophone,
  getMicrophoneInfo,
  testShortcut,
  diagnosePlatform,
  configureWaylandHoldShortcut,
  clearWaylandHoldShortcut,
  onWaylandHoldShortcut,
  testClipboard,
  testPaste,
  loadHistory,
  copyHistory,
  deleteHistory,
  startDictation,
  stopDictation,
};
