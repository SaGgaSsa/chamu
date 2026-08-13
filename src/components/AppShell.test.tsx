import { render, screen } from "@testing-library/react";
import { fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { AppShell } from "./AppShell";
import { DEFAULT_SETTINGS, type AppSettings } from "../domain/settings";
import type { ChamuBridge, DictationResult, HistoryEntry } from "../native/commands";

const shortcutPlugin = vi.hoisted(() => ({
  register: vi.fn(async () => undefined),
  unregister: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/plugin-global-shortcut", () => shortcutPlugin);

function makeBridge(): ChamuBridge {
  return {
    loadSettings: vi.fn(async () => DEFAULT_SETTINGS),
    saveSettings: vi.fn(async (_settings: AppSettings) => undefined),
    inspectModel: vi.fn(),
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

describe("AppShell", () => {
  it("shows the local Spanish shell and ready status by default", () => {
    render(<AppShell />);

    expect(screen.getByRole("heading", { name: "Chamu" })).toBeVisible();
    expect(screen.getByText("Tu voz, en tus manos")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Listo");
    expect(screen.getByText("Todo ocurre en este dispositivo")).toBeVisible();
  });

  it("renders the active recording status from state", () => {
    render(<AppShell recordingState={{ status: "recording" }} />);

    expect(screen.getByRole("status")).toHaveTextContent("Grabando");
    expect(screen.getByText("Suelta el atajo para terminar")).toBeVisible();
  });

  it("renders an error message without exposing audio controls", () => {
    render(
      <AppShell
        recordingState={{
          status: "error",
          message: "No se encontró un micrófono",
        }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Error");
    expect(screen.getByText("No se encontró un micrófono")).toBeVisible();
    expect(screen.queryByRole("button", { name: /reproducir audio/i })).toBeNull();
  });

  it("loads text-only history and lets the user copy or delete each entry", async () => {
    const bridge = makeBridge();
    const history: HistoryEntry[] = [
      { id: "entry-1", text: "Hola desde Chamu", createdAt: "2026-08-12T18:30:00.000Z" },
    ];

    render(<AppShell bridge={bridge} initialHistory={history} />);

    expect(screen.getByRole("heading", { name: /historial/i })).toBeVisible();
    expect(screen.getByText("Hola desde Chamu")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /copiar/i }));
    await waitFor(() => expect(bridge.copyHistory).toHaveBeenCalledWith(history[0].id));

    fireEvent.click(screen.getByRole("button", { name: /borrar/i }));
    await waitFor(() => expect(bridge.deleteHistory).toHaveBeenCalledWith("entry-1"));
    expect(screen.queryByText("Hola desde Chamu")).toBeNull();
  });

  it("opens settings and saves the selected recording mode through the bridge", async () => {
    const bridge = makeBridge();
    render(<AppShell bridge={bridge} />);

    fireEvent.click(screen.getByRole("button", { name: /abrir configuración/i }));
    expect(screen.getByRole("dialog", { name: /configuración/i })).toBeVisible();
    fireEvent.click(screen.getByRole("radio", { name: /pulsar para alternar/i }));
    const captureButton = screen.getByRole("button", { name: /capturar atajo/i });
    fireEvent.click(captureButton);
    fireEvent.keyDown(captureButton, { code: "KeyA", key: "a", ctrlKey: true, shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: /guardar configuración/i }));

    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      mode: "toggle",
      shortcut: "CommandOrControl+Shift+A",
    })));
  });

  it("opens the system check and runs the local readiness probes", async () => {
    const bridge = makeBridge();
    bridge.inspectModel = vi.fn(async () => ({
      id: "base",
      name: "Whisper base multilingüe",
      installed: true,
      checksumValid: true,
      sizeMiB: 142,
    }));
    bridge.testMicrophone = vi.fn(async () => ({ ok: true, message: "Micrófono disponible" }));
    bridge.testClipboard = vi.fn(async () => ({ ok: true, message: "Portapapeles disponible" }));
    bridge.testPaste = vi.fn(async () => ({ ok: true, message: "Pegado disponible" }));

    render(<AppShell bridge={bridge} />);

    fireEvent.click(screen.getByRole("button", { name: /abrir prueba del sistema/i }));
    expect(screen.getByRole("dialog", { name: /prueba del sistema/i })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /ejecutar comprobaciones/i }));

    await waitFor(() => expect(bridge.inspectModel).toHaveBeenCalledWith("base"));
    expect(bridge.testMicrophone).toHaveBeenCalledOnce();
    expect(bridge.testClipboard).toHaveBeenCalledOnce();
    expect(bridge.testPaste).toHaveBeenCalledOnce();
    expect(screen.getByText(/modelo validado/i)).toBeVisible();
  });

  it("runs the dictation lifecycle from recording through backend transcription result", async () => {
    const bridge = makeBridge();
    let resolveStop: ((result: DictationResult) => void) | undefined;
    bridge.startDictation = vi.fn(async () => ({ status: "recording" as const }));
    bridge.stopDictation = vi.fn(() => new Promise<DictationResult>((resolve) => {
      resolveStop = resolve;
    }));

    render(<AppShell bridge={bridge} />);

    fireEvent.click(screen.getByRole("button", { name: /comenzar dictado/i }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Grabando"));
    expect(bridge.startDictation).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /terminar dictado/i }));
    expect(screen.getByRole("status")).toHaveTextContent("Transcribiendo");
    expect(bridge.stopDictation).toHaveBeenCalledTimes(1);

    resolveStop?.({
      status: "copied",
      text: "Hola desde el micrófono",
      historyEntry: {
        id: "entry-2",
        text: "Hola desde el micrófono",
        createdAt: "2026-08-12T18:45:00.000Z",
      },
    });

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Copiado"));
    expect(screen.getByText("Hola desde el micrófono")).toBeVisible();
  });

  it("surfaces a backend dictation error and lets the user retry", async () => {
    const bridge = makeBridge();
    bridge.startDictation = vi.fn(async () => ({ status: "error" as const, message: "No se pudo abrir el micrófono" }));

    render(<AppShell bridge={bridge} />);

    fireEvent.click(screen.getByRole("button", { name: /comenzar dictado/i }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Error");
      expect(screen.getByText("No se pudo abrir el micrófono")).toBeVisible();
    });
  });

  it("unregisters a shortcut after a pending registration resolves during unmount", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const lifecycle: string[] = [];
    let resolveRegister: (() => void) | undefined;
    const registerPromise = new Promise<undefined>((resolve) => {
      resolveRegister = () => {
        lifecycle.push("registered");
        resolve(undefined);
      };
    });
    shortcutPlugin.register.mockImplementationOnce(() => registerPromise);
    shortcutPlugin.unregister.mockImplementationOnce(async () => {
      lifecycle.push("unregistered");
    });

    const { unmount } = render(<AppShell bridge={makeBridge()} />);

    await waitFor(() => expect(shortcutPlugin.register).toHaveBeenCalledWith(
      DEFAULT_SETTINGS.shortcut,
      expect.any(Function),
    ));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shortcutPlugin.unregister).not.toHaveBeenCalled();

    resolveRegister?.();

    await waitFor(() => expect(shortcutPlugin.unregister).toHaveBeenCalledWith(DEFAULT_SETTINGS.shortcut));
    expect(lifecycle).toEqual(["registered", "unregistered"]);
  });
});
