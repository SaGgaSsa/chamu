import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "../domain/settings";
import {
  type ChamuBridge,
  type ClipboardCheck,
  type HistoryEntry,
  type MicrophoneCheck,
  type ModelDownloadProgress,
  type ModelStatus,
  type ShortcutCheck,
} from "../native/commands";
import { OnboardingFlow } from "./OnboardingFlow";

const shortcutPlugin = vi.hoisted(() => ({
  register: vi.fn(async () => undefined),
  unregister: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/plugin-global-shortcut", () => shortcutPlugin);

function makeBridge(overrides: Partial<ChamuBridge> = {}): ChamuBridge {
  const model: ModelStatus = {
    id: "base",
    name: "Whisper base multilingüe",
    installed: true,
    checksumValid: true,
    sizeMiB: 142,
  };
  const microphone: MicrophoneCheck = { ok: true, message: "Micrófono disponible" };
  const shortcut: ShortcutCheck = { ok: true, captured: DEFAULT_SETTINGS.shortcut };
  const clipboard: ClipboardCheck = { ok: true, message: "Portapapeles disponible" };

  return {
    loadSettings: vi.fn(async () => DEFAULT_SETTINGS),
    saveSettings: vi.fn(async (_settings: AppSettings) => undefined),
    inspectModel: vi.fn(async () => model),
    startModelDownload: vi.fn(async () => undefined),
    onModelDownloadProgress: vi.fn(async () => () => undefined),
    cancelModelDownload: vi.fn(async () => undefined),
    testMicrophone: vi.fn(async () => microphone),
    testShortcut: vi.fn(async () => shortcut),
    testClipboard: vi.fn(async () => clipboard),
    testPaste: vi.fn(async () => clipboard),
    loadHistory: vi.fn(async () => [] as HistoryEntry[]),
    copyHistory: vi.fn(async (_id: string | number) => undefined),
    deleteHistory: vi.fn(async (_id: string | number) => undefined),
    ...overrides,
  };
}

function continueStep() {
  fireEvent.click(screen.getByRole("button", { name: /continuar|terminar configuración/i }));
}

describe("OnboardingFlow", () => {
  afterEach(() => {
    shortcutPlugin.register.mockClear();
    shortcutPlugin.unregister.mockClear();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("shows model and language choices with a short local privacy note on the first screen", async () => {
    render(<OnboardingFlow bridge={makeBridge()} onComplete={vi.fn()} />);

    expect(screen.getAllByText(/sin cuentas.*sin telemetría.*sin nube/i)).not.toHaveLength(0);
    expect(screen.getByRole("heading", { name: /prepara el modelo/i })).toBeVisible();
    expect(screen.getByRole("radio", { name: /español/i })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /english/i }));
    expect(screen.getByRole("radio", { name: /english/i })).toBeChecked();
    await waitFor(() => expect(screen.getByText(/modelo listo/i)).toBeVisible());
  });

  it("subscribes before a confirmed download and renders progress", async () => {
    const missing: ModelStatus = {
      id: "base",
      name: "Whisper base multilingüe",
      installed: false,
      checksumValid: false,
      sizeMiB: 142,
    };
    let progressListener: ((progress: ModelDownloadProgress) => void) | undefined;
    const callOrder: string[] = [];
    const bridge = makeBridge({
      inspectModel: vi.fn(async () => missing),
      onModelDownloadProgress: vi.fn(async (listener) => {
        callOrder.push("listen");
        progressListener = listener;
        return () => undefined;
      }),
      startModelDownload: vi.fn(async () => { callOrder.push("start"); }),
    });
    render(<OnboardingFlow bridge={bridge} onComplete={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /descargar modelo/i })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: /descargar modelo/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirmar descarga/i }));

    await waitFor(() => expect(bridge.onModelDownloadProgress).toHaveBeenCalledOnce());
    await waitFor(() => expect(bridge.startModelDownload).toHaveBeenCalledWith("base"));
    expect(callOrder).toEqual(["listen", "start"]);

    await act(async () => {
      progressListener?.({
        modelId: "base",
        phase: "downloading",
        downloadedBytes: 71,
        totalBytes: 142,
        percent: 50,
        message: "Descargando modelo",
      });
    });

    expect(await screen.findByText(/descargando modelo.*50%/i)).toBeVisible();
  });

  it("allows cancelling a model download and shows the cancellation message", async () => {
    const missing: ModelStatus = {
      id: "base",
      name: "Whisper base multilingüe",
      installed: false,
      checksumValid: false,
      sizeMiB: 142,
    };
    let progressListener: ((progress: ModelDownloadProgress) => void) | undefined;
    const bridge = makeBridge({
      inspectModel: vi.fn(async () => missing),
      onModelDownloadProgress: vi.fn(async (listener) => {
        progressListener = listener;
        return () => undefined;
      }),
    });
    render(<OnboardingFlow bridge={bridge} onComplete={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /descargar modelo/i })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: /descargar modelo/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirmar descarga/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /cancelar descarga/i })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: /cancelar descarga/i }));
    await waitFor(() => expect(bridge.cancelModelDownload).toHaveBeenCalledWith("base"));

    await act(async () => {
      progressListener?.({
        modelId: "base",
        phase: "cancelled",
        downloadedBytes: 0,
        message: "Descarga cancelada",
      });
    });
    expect((await screen.findAllByText(/descarga cancelada/i))[0]).toBeVisible();
  });

  it("unlistens once when a download reports a terminal failure", async () => {
    const missing: ModelStatus = {
      id: "base",
      name: "Whisper base multilingüe",
      installed: false,
      checksumValid: false,
      sizeMiB: 142,
    };
    let progressListener: ((progress: ModelDownloadProgress) => void) | undefined;
    const unlisten = vi.fn();
    const bridge = makeBridge({
      inspectModel: vi.fn(async () => missing),
      onModelDownloadProgress: vi.fn(async (listener) => {
        progressListener = listener;
        return unlisten;
      }),
    });
    const { unmount } = render(<OnboardingFlow bridge={bridge} onComplete={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /descargar modelo/i })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: /descargar modelo/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirmar descarga/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /cancelar descarga/i })).toBeVisible());

    await act(async () => {
      progressListener?.({
        modelId: "base",
        phase: "failed",
        downloadedBytes: 0,
        message: "No se pudo descargar el modelo",
      });
    });

    await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
    unmount();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("moves to the second screen after a validated model and saves without optional tests", async () => {
    const bridge = makeBridge();
    const onComplete = vi.fn();
    render(<OnboardingFlow bridge={bridge} onComplete={onComplete} />);

    await waitFor(() => expect(screen.getByText(/modelo listo/i)).toBeVisible());
    continueStep();

    expect(screen.getByRole("heading", { name: /prueba el dictado/i })).toBeVisible();
    expect(screen.getByRole("textbox", { name: /texto de prueba/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /probar atajo|probar micrófono|probar pegado/i })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /pulsar para alternar/i }));
    continueStep();

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ mode: "toggle" })));
    expect(bridge.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ mode: "toggle" }));
  });

  it("registers the selected shortcut for the onboarding tester", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    Object.defineProperty(window.navigator, "platform", { configurable: true, value: "Linux x86_64" });

    render(<OnboardingFlow bridge={makeBridge()} onComplete={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/modelo listo/i)).toBeVisible());
    continueStep();

    await waitFor(() => expect(shortcutPlugin.register).toHaveBeenCalledWith(
      "Ctrl+Shift+Space",
      expect.any(Function),
    ));
  });
});
