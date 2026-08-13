import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "./domain/settings";
import type { ChamuBridge, HistoryEntry } from "./native/commands";
import App from "./App";

function makeBridge(): ChamuBridge {
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
  };
}

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
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
});
