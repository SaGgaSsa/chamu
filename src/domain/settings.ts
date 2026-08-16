export type AppLanguage = "es" | "en";
export type RecordingMode = "hold" | "toggle";

export interface AppSettings {
  language: AppLanguage;
  mode: RecordingMode;
  shortcut: string;
  modelId: string;
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = {
  language: "es",
  mode: "hold",
  shortcut: "CommandOrControl+Shift+Space",
  modelId: "small",
};

export function mergeSettings(
  settings: AppSettings,
  updates: Partial<AppSettings>,
): AppSettings {
  return { ...settings, ...updates };
}
