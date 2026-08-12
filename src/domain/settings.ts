export type AppLanguage = "es" | "en";
export type RecordingMode = "hold" | "toggle";

export interface AppSettings {
  language: AppLanguage;
  mode: RecordingMode;
  shortcut: string;
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = {
  language: "es",
  mode: "hold",
  shortcut: "CommandOrControl+Shift+Space",
};

export function mergeSettings(
  settings: AppSettings,
  updates: Partial<AppSettings>,
): AppSettings {
  return { ...settings, ...updates };
}
