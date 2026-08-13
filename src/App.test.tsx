import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "./domain/settings";
import type { ChamuBridge, HistoryEntry } from "./native/commands";
import App from "./App";

const shortcutPlugin = vi.hoisted(() => ({
  register: vi.fn(async () => undefined),
  unregister: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/plugin-global-shortcut", () => shortcutPlugin);

function makeBridge(overrides: Partial<ChamuBridge> = {}): ChamuBridge {
  return {
    loadSettings: vi.fn(async () => DEFAULT_SETTINGS),
    saveSettings: vi.fn(async (_settings: AppSettings) => undefined),
    inspectModel: vi.fn(async () => ({ id: "base", name: "Whisper base", installed: true, checksumValid: true, sizeMiB: 142 })),
    startModelDownload: vi.fn(),
    onModelDownloadProgress: vi.fn(async () => () => undefined),
    cancelModelDownload: vi.fn(),
    testMicrophone: vi.fn(),
    testShortcut: vi.fn(),
    testClipboard: vi.fn(),
    testPaste: vi.fn(),
    loadHistory: vi.fn(async () => []),
    copyHistory: vi.fn(async (_id: string | number) => undefined),
    deleteHistory: vi.fn(async (_id: string | number) => undefined),
    ...overrides,
  };
}

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
    shortcutPlugin.register.mockClear();
    shortcutPlugin.unregister.mockClear();
  });

  it("starts with onboarding and shows the main shell only after local setup is marked complete", async () => {
    const bridge = makeBridge();
    const { unmount } = render(<App bridge={bridge} />);

    await waitFor(() => expect(screen.getByRole("heading", { name: /prepara el modelo/i })).toBeVisible());
    expect(screen.queryByRole("heading", { name: /habla\. chamu escribe/i })).toBeNull();

    window.localStorage.setItem("chamu:onboarding-complete", "true");
    unmount();
    render(<App bridge={bridge} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: /habla\. chamu escribe/i })).toBeVisible());
  });

  it("resets only the onboarding marker from settings", async () => {
    window.localStorage.setItem("chamu:onboarding-complete", "true");
    const bridge = makeBridge();
    render(<App bridge={bridge} />);

    await waitFor(() => expect(screen.getByRole("heading", { name: /habla\. chamu escribe/i })).toBeVisible());
    await waitFor(() => expect(bridge.loadSettings).toHaveBeenCalledOnce());
    const loadSettingsCalls = vi.mocked(bridge.loadSettings).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /abrir configuración/i }));
    fireEvent.click(screen.getByRole("button", { name: /reiniciar onboarding/i }));

    await waitFor(() => expect(screen.getByRole("heading", { name: /prepara el modelo/i })).toBeVisible());
    expect(window.localStorage.getItem("chamu:onboarding-complete")).toBeNull();
    expect(bridge.saveSettings).not.toHaveBeenCalled();
    expect(vi.mocked(bridge.loadSettings).mock.calls.length).toBe(loadSettingsCalls);
  });

  it("does not mount a shortcut backend before saved toggle settings are loaded", async () => {
    window.localStorage.setItem("chamu:onboarding-complete", "true");
    let resolveSettings: ((settings: AppSettings) => void) | undefined;
    const bridge = makeBridge({
      loadSettings: vi.fn(() => new Promise<AppSettings>((resolve) => {
        resolveSettings = resolve;
      })),
      diagnosePlatform: vi.fn(async () => ({
        session: "x11" as const,
        shortcutMethod: "x11-global-hook",
        holdModeSupported: true,
        toggleModeSupported: true,
      })),
    });
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    const { unmount } = render(<App bridge={bridge} />);

    expect(screen.queryByRole("heading", { name: /habla\. chamu escribe/i })).toBeNull();
    expect(bridge.diagnosePlatform).not.toHaveBeenCalled();
    expect(shortcutPlugin.register).not.toHaveBeenCalled();

    resolveSettings?.({ ...DEFAULT_SETTINGS, mode: "toggle" });
    await waitFor(() => expect(screen.getByRole("heading", { name: /habla\. chamu escribe/i })).toBeVisible());
    await waitFor(() => expect(bridge.diagnosePlatform).toHaveBeenCalledOnce());
    await waitFor(() => expect(shortcutPlugin.register).toHaveBeenCalledWith("Ctrl+Shift+Space", expect.any(Function)));

    unmount();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("configures the saved custom Wayland shortcut only after settings are ready", async () => {
    window.localStorage.setItem("chamu:onboarding-complete", "true");
    let resolveSettings: ((settings: AppSettings) => void) | undefined;
    const bridge = makeBridge({
      loadSettings: vi.fn(() => new Promise<AppSettings>((resolve) => {
        resolveSettings = resolve;
      })),
      diagnosePlatform: vi.fn(async () => ({
        session: "wayland" as const,
        shortcutMethod: "xdg-global-shortcuts-portal",
        holdModeSupported: true,
        toggleModeSupported: true,
        waylandPortalAvailable: true,
      })),
      configureWaylandHoldShortcut: vi.fn(async (_shortcut: string) => undefined),
      clearWaylandHoldShortcut: vi.fn(async () => undefined),
      onWaylandHoldShortcut: vi.fn(async (_listener) => () => undefined),
    });

    const { unmount } = render(<App bridge={bridge} />);
    expect(bridge.configureWaylandHoldShortcut).not.toHaveBeenCalled();

    const savedSettings = {
      ...DEFAULT_SETTINGS,
      shortcut: "Ctrl+Alt+A",
    };
    resolveSettings?.(savedSettings);
    await waitFor(() => expect(bridge.configureWaylandHoldShortcut).toHaveBeenCalledWith("Ctrl+Alt+A"));
    expect(bridge.configureWaylandHoldShortcut).not.toHaveBeenCalledWith(DEFAULT_SETTINGS.shortcut);

    unmount();
  });
});
