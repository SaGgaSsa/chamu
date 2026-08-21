export type AppLanguage = "es" | "en";
export type RecordingMode = "hold" | "toggle";

export interface AppSettings {
  language: AppLanguage;
  mode: RecordingMode;
  shortcut: string;
  modelId: string;
  /** Empty string selects the system default input device. */
  inputDevice: string;
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = {
  language: "es",
  mode: "hold",
  shortcut: "CommandOrControl+Shift+Space",
  modelId: "small",
  inputDevice: "",
};

export function mergeSettings(
  settings: AppSettings,
  updates: Partial<AppSettings>,
): AppSettings {
  return { ...settings, ...updates };
}
