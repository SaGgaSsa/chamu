import { act, render, screen, within } from "@testing-library/react";
import { fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { AppShell } from "./AppShell";
import { DEFAULT_SETTINGS, type AppSettings } from "../domain/settings";
import type {
  ChamuBridge,
  DictationResult,
  WaylandHoldShortcutEvent,
} from "../native/commands";

const shortcutPlugin = vi.hoisted(() => ({
  register: vi.fn(async () => undefined),
  unregister: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/plugin-global-shortcut", () => shortcutPlugin);

function makeBridge(overrides: Partial<ChamuBridge> = {}): ChamuBridge {
  return {
    loadSettings: vi.fn(async () => DEFAULT_SETTINGS),
    saveSettings: vi.fn(async (_settings: AppSettings) => undefined),
    inspectModel: vi.fn(),
    startModelDownload: vi.fn(),
    onModelDownloadProgress: vi.fn(async () => () => undefined),
    cancelModelDownload: vi.fn(),
    testMicrophone: vi.fn(),
    getMicrophoneInfo: vi.fn(async () => ({ name: "Micrófono USB" })),
    testShortcut: vi.fn(),
    testClipboard: vi.fn(),
    testPaste: vi.fn(),
    loadHistory: vi.fn(async () => []),
    copyHistory: vi.fn(async (_id: string | number) => undefined),
    deleteHistory: vi.fn(async (_id: string | number) => undefined),
    ...overrides,
  };
}

function makeWaylandBridge() {
  let emit: ((event: WaylandHoldShortcutEvent) => void) | undefined;
  const unlisten = vi.fn();
  const bridge = makeBridge({
    diagnosePlatform: vi.fn(async () => ({ session: "wayland" as const })),
    configureWaylandHoldShortcut: vi.fn(async (_shortcut: string) => undefined),
    clearWaylandHoldShortcut: vi.fn(async () => undefined),
    onWaylandHoldShortcut: vi.fn(async (listener) => {
      emit = listener;
      return () => {
        unlisten();
        emit = undefined;
      };
    }),
    startDictation: vi.fn(async () => ({ status: "recording" as const })),
    stopDictation: vi.fn(async () => ({ status: "copied" as const })),
  });

  return {
    bridge,
    unlisten,
    emitWaylandShortcut: async (event: WaylandHoldShortcutEvent) => {
      await waitFor(() => expect(emit).toBeDefined());
      await act(async () => {
        emit?.(event);
      });
    },
  };
}

describe("AppShell", () => {
  it("shows the local Spanish shell and ready status by default", () => {
    render(<AppShell />);

    expect(screen.getByRole("heading", { name: "Chamu" })).toBeVisible();
    expect(screen.getByText("Tu voz, en tus manos")).toBeVisible();
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("Listo");
    expect(screen.getByText("Todo ocurre en este dispositivo")).toBeVisible();
  });

  it("renders a status-aware microphone icon with the existing accessible name", () => {
    render(<AppShell recordingState={{ status: "ready" }} />);

    const control = screen.getByRole("button", { name: "Comenzar dictado" });
    expect(control).toHaveAttribute("data-status", "ready");
    expect(control.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("shows REC while recording", () => {
    render(<AppShell recordingState={{ status: "recording" }} />);

    const control = screen.getByRole("button", { name: "Terminar dictado" });
    expect(control).toHaveTextContent("REC");
  });

  it("disables the dictation control while transcribing", () => {
    render(<AppShell recordingState={{ status: "transcribing" }} />);

    expect(screen.getByRole("button", { name: "Transcribiendo…" })).toBeDisabled();
  });

  it("renders the decorative waveform only while recording", () => {
    const { rerender } = render(<AppShell recordingState={{ status: "ready" }} />);

    expect(screen.queryByTestId("dictation-waveform")).not.toBeInTheDocument();

    rerender(<AppShell recordingState={{ status: "recording" }} />);
    expect(screen.getByTestId("dictation-waveform")).toBeInTheDocument();

    const control = screen.getByRole("button", { name: "Terminar dictado" });
    expect(control.querySelector(".dictation-control__pulse")).toBeInTheDocument();
    expect(control.querySelector("animate")).not.toBeInTheDocument();

    rerender(<AppShell recordingState={{ status: "copied" }} />);
    expect(screen.queryByTestId("dictation-waveform")).not.toBeInTheDocument();
  });

  it("renders a visible pulse circle while recording", () => {
    render(<AppShell recordingState={{ status: "recording" }} />);

    const pulseCircle = screen
      .getByRole("button", { name: "Terminar dictado" })
      .querySelector(".dictation-control__pulse circle");

    expect(pulseCircle).toBeInTheDocument();
    expect(pulseCircle).not.toHaveAttribute("opacity", "0");
  });

  it("renders the active recording status from state", () => {
    render(<AppShell recordingState={{ status: "recording" }} />);

    expect(screen.getAllByRole("status")[0]).toHaveTextContent("Grabando");
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

    expect(screen.getAllByRole("status")[0]).toHaveTextContent("Error");
    expect(screen.getByText("No se encontró un micrófono")).toBeVisible();
    expect(screen.queryByRole("button", { name: /reproducir audio/i })).toBeNull();
  });

  it("does not render history or the system check in the main view", async () => {
    const bridge = makeBridge();
    render(<AppShell bridge={bridge} />);

    await waitFor(() => expect(screen.getByText("Micrófono activo: Micrófono USB")).toBeVisible());
    expect(screen.queryByRole("heading", { name: /historial/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /prueba del sistema/i })).toBeNull();
    expect(bridge.loadHistory).not.toHaveBeenCalled();
  });

  it("keeps only language controls and onboarding reset in settings", async () => {
    const bridge = makeBridge();
    const onRestartOnboarding = vi.fn();
    render(<AppShell bridge={bridge} onRestartOnboarding={onRestartOnboarding} />);

    fireEvent.click(screen.getByRole("button", { name: /abrir configuración/i }));
    const dialog = screen.getByRole("dialog", { name: /configuración/i });
    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole("radio", { name: /english/i })).toBeVisible();
    expect(within(dialog).queryByRole("radio", { name: /pulsar para alternar|mantener pulsado/i })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /capturar atajo/i })).toBeNull();
    fireEvent.click(within(dialog).getByRole("radio", { name: /english/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: /guardar configuración/i }));

    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ language: "en" })));
    fireEvent.click(screen.getByRole("button", { name: /abrir configuración/i }));
    fireEvent.click(screen.getByRole("button", { name: /reiniciar onboarding/i }));
    expect(onRestartOnboarding).toHaveBeenCalledOnce();
  });

  it("saves mode and shortcut changes made in the dictation tester", async () => {
    const bridge = makeBridge();
    render(<AppShell bridge={bridge} />);

    fireEvent.click(screen.getByRole("radio", { name: /pulsar para alternar/i }));
    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ mode: "toggle" })));

    const captureButton = screen.getByRole("button", { name: /capturar atajo/i });
    fireEvent.click(captureButton);
    fireEvent.keyDown(screen.getByRole("button", { name: /pulsa el atajo/i }), { code: "KeyA", key: "a", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ shortcut: "CommandOrControl+Shift+A" })));
  });

  it("runs the dictation lifecycle from recording through backend transcription result", async () => {
    const bridge = makeBridge();
    let resolveStop: ((result: DictationResult) => void) | undefined;
    bridge.startDictation = vi.fn(async () => ({ status: "recording" as const }));
    bridge.stopDictation = vi.fn(() => new Promise<DictationResult>((resolve) => {
      resolveStop = resolve;
    }));

    render(<AppShell bridge={bridge} />);

    fireEvent.focus(screen.getByRole("textbox", { name: /texto de prueba/i }));
    const startButton = screen.getByRole("button", { name: /comenzar dictado/i });
    fireEvent.mouseDown(startButton);
    fireEvent.click(startButton);
    await waitFor(() => expect(screen.getAllByRole("status")[0]).toHaveTextContent("Grabando"));
    expect(bridge.startDictation).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /terminar dictado/i }));
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("Transcribiendo");
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

    await waitFor(() => expect(screen.getAllByRole("status")[0]).toHaveTextContent("Copiado"));
    const textarea = screen.getByRole("textbox", { name: /texto de prueba/i });
    await waitFor(() => expect(textarea).toHaveValue("Hola desde el micrófono"));
  });

  it("surfaces a backend dictation error and lets the user retry", async () => {
    const bridge = makeBridge();
    bridge.startDictation = vi.fn(async () => ({ status: "error" as const, message: "No se pudo abrir el micrófono" }));

    render(<AppShell bridge={bridge} />);

    fireEvent.click(screen.getByRole("button", { name: /comenzar dictado/i }));

    await waitFor(() => {
      expect(screen.getAllByRole("status")[0]).toHaveTextContent("Error");
      expect(screen.getByText("No se pudo abrir el micrófono")).toBeVisible();
    });
  });

  it("shows microphone preparation while native capture is starting", async () => {
    const bridge = makeBridge();
    let resolveStart: ((result: DictationResult) => void) | undefined;
    bridge.startDictation = vi.fn(() => new Promise<DictationResult>((resolve) => {
      resolveStart = resolve;
    }));

    render(<AppShell bridge={bridge} />);

    const startButton = screen.getByRole("button", { name: /comenzar dictado/i });
    fireEvent.click(startButton);

    expect(screen.getByText("Preparando micrófono…")).toBeVisible();
    expect(startButton).toBeDisabled();

    resolveStart?.({ status: "recording" });
    await waitFor(() => expect(screen.getAllByRole("status")[0]).toHaveTextContent("Grabando"));
    expect(screen.queryByText("Preparando micrófono…")).toBeNull();
  });

  it("starts on Wayland portal press and stops on release", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    shortcutPlugin.register.mockClear();
    const { bridge, emitWaylandShortcut } = makeWaylandBridge();
    const { unmount } = render(<AppShell bridge={bridge} />);

    await waitFor(() => expect(bridge.configureWaylandHoldShortcut).toHaveBeenCalledWith(
      DEFAULT_SETTINGS.shortcut,
    ));
    await emitWaylandShortcut({ status: "pressed" });
    await waitFor(() => expect(bridge.startDictation).toHaveBeenCalledOnce());

    await emitWaylandShortcut({ status: "released" });
    await waitFor(() => expect(bridge.stopDictation).toHaveBeenCalledOnce());
    expect(shortcutPlugin.register).not.toHaveBeenCalled();
    unmount();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("stops after a Wayland release that arrives while start is pending", async () => {
    let resolveStart: ((result: DictationResult) => void) | undefined;
    const { bridge, emitWaylandShortcut } = makeWaylandBridge();
    bridge.startDictation = vi.fn(() => new Promise<DictationResult>((resolve) => {
      resolveStart = resolve;
    }));

    render(<AppShell bridge={bridge} />);
    await waitFor(() => expect(bridge.configureWaylandHoldShortcut).toHaveBeenCalled());

    await emitWaylandShortcut({ status: "pressed" });
    await waitFor(() => expect(bridge.startDictation).toHaveBeenCalledOnce());
    await emitWaylandShortcut({ status: "released" });
    expect(bridge.stopDictation).not.toHaveBeenCalled();

    resolveStart?.({ status: "recording" });
    await waitFor(() => expect(bridge.stopDictation).toHaveBeenCalledOnce());
  });

  it("shows portal status only after receiving its event", async () => {
    const { bridge, emitWaylandShortcut } = makeWaylandBridge();
    render(<AppShell bridge={bridge} />);

    expect(screen.queryByText("Atajo Wayland: registrado")).toBeNull();
    await waitFor(() => expect(bridge.configureWaylandHoldShortcut).toHaveBeenCalled());

    await emitWaylandShortcut({ status: "registered" });
    expect(screen.getByText("Atajo Wayland: registrado")).toBeVisible();

    await emitWaylandShortcut({ status: "error", message: "El portal rechazó el atajo" });
    expect(screen.getByText(/El portal rechazó el atajo/)).toBeVisible();
  });

  it("clears the portal listener and session on unmount", async () => {
    const { bridge, unlisten } = makeWaylandBridge();
    const { unmount } = render(<AppShell bridge={bridge} />);

    await waitFor(() => expect(bridge.configureWaylandHoldShortcut).toHaveBeenCalled());
    unmount();

    await waitFor(() => expect(bridge.clearWaylandHoldShortcut).toHaveBeenCalledOnce());
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("pauses the global shortcut while capturing a replacement", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    shortcutPlugin.register.mockClear();
    shortcutPlugin.unregister.mockClear();
    const bridge = makeBridge();
    const { unmount } = render(<AppShell bridge={bridge} />);

    await waitFor(() => expect(shortcutPlugin.register).toHaveBeenCalledWith(
      "Ctrl+Shift+Space",
      expect.any(Function),
    ));
    const registrationsBeforeCapture = shortcutPlugin.register.mock.calls.length;
    const captureButton = screen.getByRole("button", { name: /capturar atajo/i });
    fireEvent.click(captureButton);

    await waitFor(() => expect(shortcutPlugin.unregister).toHaveBeenCalledWith("Ctrl+Shift+Space"));
    expect(shortcutPlugin.register).toHaveBeenCalledTimes(registrationsBeforeCapture);

    const capturingButton = screen.getByRole("button", { name: /pulsa el atajo/i });
    fireEvent.keyDown(capturingButton, { code: "Escape", key: "Escape" });
    await waitFor(() => expect(shortcutPlugin.register).toHaveBeenCalledTimes(registrationsBeforeCapture + 1));

    unmount();
    await waitFor(() => expect(shortcutPlugin.unregister).toHaveBeenCalledTimes(2));
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("unregisters a shortcut after a pending registration resolves during unmount", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    shortcutPlugin.register.mockClear();
    shortcutPlugin.unregister.mockClear();
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

    Object.defineProperty(window.navigator, "platform", { configurable: true, value: "Linux x86_64" });
    await waitFor(() => expect(shortcutPlugin.register).toHaveBeenCalledWith(
      "Ctrl+Shift+Space",
      expect.any(Function),
    ));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shortcutPlugin.unregister).not.toHaveBeenCalled();

    resolveRegister?.();

    await waitFor(() => expect(shortcutPlugin.unregister).toHaveBeenCalledWith("Ctrl+Shift+Space"));
    expect(lifecycle).toEqual(["registered", "unregistered"]);
  });
});
