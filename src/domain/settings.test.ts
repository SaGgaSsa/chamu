import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type AppSettings,
} from "./settings";

describe("app settings", () => {
  it("defaults to the small model, Spanish, hold-to-talk, and a global shortcut", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      language: "es",
      mode: "hold",
      shortcut: "CommandOrControl+Shift+Space",
      modelId: "small",
      inputDevice: "",
    });
  });

  it("merges a partial preference without dropping the other defaults", () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      language: "en",
      mode: "toggle",
      inputDevice: "Micrófono USB",
    });

    expect(settings).toEqual<AppSettings>({
      language: "en",
      mode: "toggle",
      shortcut: "CommandOrControl+Shift+Space",
      modelId: "small",
      inputDevice: "Micrófono USB",
    });
  });

  it("keeps an explicitly selected model when merging settings", () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, { modelId: "large-v3-turbo-q5_0" });

    expect(settings.modelId).toBe("large-v3-turbo-q5_0");
  });
});
