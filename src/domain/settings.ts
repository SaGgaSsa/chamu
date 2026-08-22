export type AppLanguage = "es" | "en";
export type RecordingMode = "hold" | "toggle";
export type ThreadUsage = "medium" | "max";

export interface AppSettings {
  language: AppLanguage;
  mode: RecordingMode;
  shortcut: string;
  modelId: string;
  /** Empty string selects the system default input device. */
  inputDevice: string;
  /** Medium keeps roughly half of the logical cores free for the system. */
  threadUsage: ThreadUsage;
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = {
  language: "es",
  mode: "hold",
  shortcut: "CommandOrControl+Shift+Space",
  modelId: "small",
  inputDevice: "",
  threadUsage: "medium",
};

export function mergeSettings(
  settings: AppSettings,
  updates: Partial<AppSettings>,
): AppSettings {
  return { ...settings, ...updates };
}
