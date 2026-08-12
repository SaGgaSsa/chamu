import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type AppSettings,
} from "./settings";

describe("app settings", () => {
  it("defaults to Spanish, hold-to-talk, and a global shortcut", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      language: "es",
      mode: "hold",
      shortcut: "CommandOrControl+Shift+Space",
    });
  });

  it("merges a partial preference without dropping the other defaults", () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      language: "en",
      mode: "toggle",
    });

    expect(settings).toEqual<AppSettings>({
      language: "en",
      mode: "toggle",
      shortcut: "CommandOrControl+Shift+Space",
    });
  });
});
