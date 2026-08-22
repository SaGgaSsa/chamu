import { act, render, screen, within } from "@testing-library/react";
import { fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { AppShell } from "./AppShell";
import { DEFAULT_SETTINGS, type AppSettings } from "../domain/settings";
import type {
  ChamuBridge,
  DictationResult,
  ModelMetadata,
  ModelStatus,
  WaylandHoldShortcutEvent,
} from "../native/commands";
import { MODEL_PROFILES } from "./ModelSelector";

const shortcutPlugin = vi.hoisted(() => ({
  register: vi.fn(async (..._args: unknown[]) => undefined),
  unregister: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("@tauri-apps/plugin-global-shortcut", () => shortcutPlugin);

function makeBridge(overrides: Partial<ChamuBridge> = {}): ChamuBridge {
  const catalog: ModelMetadata[] = MODEL_PROFILES.map((profile) => ({
    id: profile.id,
    label: profile.label,
    filename: `ggml-${profile.id}.bin`,
    language: "multilingual",
    sizeBytes: profile.displaySizeMiB * 1024 * 1024,
    sha256: "checksum",
    downloadUrl: "https://example.invalid/model.bin",
  }));
  return {
    loadSettings: vi.fn(async () => DEFAULT_SETTINGS),
    saveSettings: vi.fn(async (_settings: AppSettings) => undefined),
    getModelCatalog: vi.fn(async () => catalog),
    inspectModel: vi.fn(async (modelId = DEFAULT_SETTINGS.modelId): Promise<ModelStatus> => ({
      id: modelId,
      name: `Whisper ${modelId}`,
      label: MODEL_PROFILES.find((profile) => profile.id === modelId)?.label ?? "Predeterminado",
      installed: true,
      checksumValid: true,
      active: modelId === DEFAULT_SETTINGS.modelId,
      sizeMiB: MODEL_PROFILES.find((profile) => profile.id === modelId)?.displaySizeMiB ?? 466,
    })),
    activateModel: vi.fn(async () => undefined),
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

function makeQuietBridge(): ChamuBridge {
  return makeBridge({
    getModelCatalog: vi.fn(() => new Promise<ModelMetadata[]>(() => undefined)),
    getMicrophoneInfo: undefined,
  });
}

function makeWaylandBridge() {
  let emit: ((event: WaylandHoldShortcutEvent) => void) | undefined;
  const unlisten = vi.fn();
  const waylandListeners: Array<(event: WaylandHoldShortcutEvent) => void> = [];
  const bridge = makeBridge({
    diagnosePlatform: vi.fn(async () => ({
      session: "wayland" as const,
      shortcutMethod: "xdg-global-shortcuts-portal",
      holdModeSupported: true,
      toggleModeSupported: true,
      waylandPortalAvailable: true,
    })),
    configureWaylandHoldShortcut: vi.fn(async (_shortcut: string) => undefined),
    clearWaylandHoldShortcut: vi.fn(async () => undefined),
    onWaylandHoldShortcut: vi.fn(async (listener) => {
      emit = listener;
      waylandListeners.push(listener);
      return () => {
        unlisten();
        if (emit === listener) emit = undefined;
      };
    }),
    startDictation: vi.fn(async () => ({ status: "recording" as const })),
    stopDictation: vi.fn(async () => ({ status: "copied" as const })),
  });

  return {
    bridge,
    unlisten,
    waylandListeners,
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
    render(<AppShell bridge={makeQuietBridge()} />);

    expect(screen.getByRole("heading", { name: "Chamu" })).toBeVisible();
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("Listo");
  });

  it("renders a status-aware microphone icon with the existing accessible name", () => {
    render(<AppShell bridge={makeQuietBridge()} recordingState={{ status: "ready" }} />);

    const control = screen.getByRole("button", { name: "Comenzar dictado" });
    expect(control).toHaveAttribute("data-status", "ready");
    expect(control.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("shows REC while recording", () => {
    render(<AppShell bridge={makeQuietBridge()} recordingState={{ status: "recording" }} />);

    const control = screen.getByRole("button", { name: "Terminar dictado" });
    expect(control).toHaveTextContent("REC");
  });

  it("disables the dictation control while transcribing", () => {
    render(<AppShell bridge={makeQuietBridge()} recordingState={{ status: "transcribing" }} />);

    expect(screen.getByRole("button", { name: "Transcribiendo…" })).toBeDisabled();
  });

  it("renders the decorative waveform only while recording", () => {
    const bridge = makeQuietBridge();
    const { rerender } = render(<AppShell bridge={bridge} recordingState={{ status: "ready" }} />);

    expect(screen.queryByTestId("dictation-waveform")).not.toBeInTheDocument();

    rerender(<AppShell bridge={bridge} recordingState={{ status: "recording" }} />);
    expect(screen.getByTestId("dictation-waveform")).toBeInTheDocument();

    const control = screen.getByRole("button", { name: "Terminar dictado" });
    expect(control.querySelector(".dictation-control__pulse")).toBeInTheDocument();
    expect(control.querySelector("animate")).not.toBeInTheDocument();

    rerender(<AppShell bridge={bridge} recordingState={{ status: "copied" }} />);
    expect(screen.queryByTestId("dictation-waveform")).not.toBeInTheDocument();
  });

  it("renders a visible pulse circle while recording", () => {
    render(<AppShell bridge={makeQuietBridge()} recordingState={{ status: "recording" }} />);

    const pulseCircle = screen
      .getByRole("button", { name: "Terminar dictado" })
      .querySelector(".dictation-control__pulse circle");

    expect(pulseCircle).toBeInTheDocument();
    expect(pulseCircle).not.toHaveAttribute("opacity", "0");
  });

  it("renders the active recording status from state", () => {
    render(<AppShell bridge={makeQuietBridge()} recordingState={{ status: "recording" }} />);

    expect(screen.getAllByRole("status")[0]).toHaveTextContent("Grabando");
    expect(screen.getByText("Suelta el atajo para terminar")).toBeVisible();
  });

  it("renders an error message without exposing audio controls", () => {
    render(
      <AppShell
        bridge={makeQuietBridge()}
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

  it("keeps language, model, and onboarding reset controls in settings", async () => {
    const bridge = makeBridge();
    const onRestartOnboarding = vi.fn();
    render(<AppShell bridge={bridge} onRestartOnboarding={onRestartOnboarding} />);

    fireEvent.click(screen.getByRole("button", { name: /abrir configuración/i }));
    const dialog = screen.getByRole("dialog", { name: /configuración/i });
    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole("radio", { name: /english/i })).toBeVisible();
    expect(within(dialog).getByRole("radio", { name: /calidad/i })).toBeVisible();
    expect(within(dialog).queryByRole("radio", { name: /pulsar para alternar|mantener pulsado/i })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /capturar atajo/i })).toBeNull();
    fireEvent.click(within(dialog).getByRole("radio", { name: /english/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: /guardar configuración/i }));

    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ language: "en" })));
    fireEvent.click(screen.getByRole("button", { name: /abrir configuración/i }));
    fireEvent.click(screen.getByRole("button", { name: /reiniciar onboarding/i }));
    expect(onRestartOnboarding).toHaveBeenCalledOnce();
  });

  it("shows the active model only inside settings", async () => {
    const bridge = makeBridge();
    render(<AppShell bridge={bridge} />);

    await waitFor(() => expect(screen.getByText("Micrófono activo: Micrófono USB")).toBeVisible());
    expect(screen.queryByRole("radio", { name: /predeterminado/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /abrir configuración/i }));
    const dialog = screen.getByRole("dialog", { name: /configuración/i });
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: /predeterminado/i })).toBeVisible());
    expect(within(dialog).getByRole("radio", { name: /predeterminado/i })).toBeChecked();
    expect(within(dialog).getAllByText(/activo/i).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/liviano.*142 MiB/i)).toBeVisible();
  });

  it("disables model controls while dictation is recording", async () => {
    const bridge = makeBridge();
    render(<AppShell bridge={bridge} recordingState={{ status: "recording" }} />);

    fireEvent.click(screen.getByRole("button", { name: /abrir configuración/i }));
    const dialog = screen.getByRole("dialog", { name: /configuración/i });
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: /predeterminado/i })).toBeDisabled());
    expect(within(dialog).getByText(/selector bloqueado/i)).toBeVisible();
  });

  it("lets the user pick an input device inside settings", async () => {
    const bridge = makeBridge({
      listInputDevices: vi.fn(async () => [
        { id: "front:CARD=Generic_1,DEV=0", label: "HD-Audio Generic", isBuiltIn: true },
        { id: "front:CARD=S,DEV=0", label: "HyperX QuadCast S", isBuiltIn: false },
      ]),
    });
    render(<AppShell bridge={bridge} />);

    fireEvent.click(screen.getByRole("button", { name: /abrir configuración/i }));
    const dialog = screen.getByRole("dialog", { name: /configuración/i });
    const select = await waitFor(() => within(dialog).getByRole("combobox", { name: /dispositivo de captura/i }));
    expect(select).toHaveValue("");
    fireEvent.change(select, { target: { value: "front:CARD=S,DEV=0" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /guardar configuración/i }));

    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ inputDevice: "front:CARD=S,DEV=0" })));
  });

  it("keeps the previous model selected when activation fails", async () => {
    const bridge = makeBridge({
      activateModel: vi.fn(async () => {
        throw new Error("No se pudo activar el modelo");
      }),
    });
    render(<AppShell bridge={bridge} />);

    fireEvent.click(screen.getByRole("button", { name: /abrir configuración/i }));
    const dialog = screen.getByRole("dialog", { name: /configuración/i });
    const previous = await within(dialog).findByRole("radio", { name: /predeterminado/i });
    const candidate = within(dialog).getByRole("radio", { name: /liviano/i });
    fireEvent.click(candidate);

    await waitFor(() => expect(screen.getByText("No se pudo activar el modelo")).toBeVisible());
    expect(previous).toBeChecked();
    expect(candidate).not.toBeChecked();
  });

  it("blocks the whole screen while the model loads", async () => {
    let resolveActivation: (() => void) | undefined;
    const bridge = makeBridge({
      activateModel: vi.fn(() => new Promise<void>((resolve) => {
        resolveActivation = resolve;
      })),
    });
    render(<AppShell bridge={bridge} />);

    fireEvent.click(screen.getByRole("button", { name: /abrir configuración/i }));
    const dialog = screen.getByRole("dialog", { name: /configuración/i });
    fireEvent.click(await within(dialog).findByRole("radio", { name: /liviano/i }));

    await waitFor(() => expect(screen.getByText(/cargando modelo liviano/i)).toBeVisible());
    expect(dialog.querySelector(".model-loading-overlay")).not.toBeNull();

    resolveActivation?.();
    await waitFor(() => expect(screen.queryByText(/cargando modelo liviano/i)).toBeNull());
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

  it("does not toggle or stop a recording that Wayland did not start", async () => {
    const { bridge, emitWaylandShortcut } = makeWaylandBridge();
    render(<AppShell bridge={bridge} />);

    await waitFor(() => expect(bridge.configureWaylandHoldShortcut).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /comenzar dictado/i }));
    await waitFor(() => expect(screen.getAllByRole("status")[0]).toHaveTextContent("Grabando"));

    await emitWaylandShortcut({ status: "pressed" });
    await emitWaylandShortcut({ status: "pressed" });
    await emitWaylandShortcut({ status: "released" });

    expect(bridge.startDictation).toHaveBeenCalledOnce();
    expect(bridge.stopDictation).not.toHaveBeenCalled();
  });

  it("stops capture owned by Wayland when the portal session is cleaned up", async () => {
    const { bridge, emitWaylandShortcut } = makeWaylandBridge();
    const { unmount } = render(<AppShell bridge={bridge} />);

    await waitFor(() => expect(bridge.configureWaylandHoldShortcut).toHaveBeenCalled());
    await emitWaylandShortcut({ status: "pressed" });
    await waitFor(() => expect(bridge.startDictation).toHaveBeenCalledOnce());
    unmount();

    await waitFor(() => expect(bridge.stopDictation).toHaveBeenCalledOnce());
  });

  it("stops Wayland-owned capture when the portal reports an error", async () => {
    const { bridge, emitWaylandShortcut } = makeWaylandBridge();
    render(<AppShell bridge={bridge} />);

    await waitFor(() => expect(bridge.configureWaylandHoldShortcut).toHaveBeenCalled());
    await emitWaylandShortcut({ status: "pressed" });
    await waitFor(() => expect(bridge.startDictation).toHaveBeenCalledOnce());
    await emitWaylandShortcut({ status: "error", message: "El portal se cerró" });

    await waitFor(() => expect(bridge.stopDictation).toHaveBeenCalledOnce());
  });

  it("keeps a Wayland stop pending when cleanup happens during capture start", async () => {
    let resolveStart: ((result: DictationResult) => void) | undefined;
    const { bridge, emitWaylandShortcut } = makeWaylandBridge();
    bridge.startDictation = vi.fn(() => new Promise<DictationResult>((resolve) => {
      resolveStart = resolve;
    }));
    const { unmount } = render(<AppShell bridge={bridge} />);

    await waitFor(() => expect(bridge.configureWaylandHoldShortcut).toHaveBeenCalled());
    await emitWaylandShortcut({ status: "pressed" });
    await waitFor(() => expect(bridge.startDictation).toHaveBeenCalledOnce());
    unmount();
    expect(bridge.stopDictation).not.toHaveBeenCalled();

    resolveStart?.({ status: "recording" });
    await waitFor(() => expect(bridge.stopDictation).toHaveBeenCalledOnce());
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

    await emitWaylandShortcut({ status: "registered", triggerDescription: "Ctrl+Alt+A" });
    expect(screen.getByText("Atajo Wayland: registrado (Ctrl+Alt+A)")).toBeVisible();

    await emitWaylandShortcut({ status: "error", message: "El portal rechazó el atajo" });
    expect(screen.getByText(/El portal rechazó el atajo/)).toBeVisible();
  });

  it("retries a portal configuration once when cleanup is still pending", async () => {
    const { bridge, emitWaylandShortcut } = makeWaylandBridge();
    render(<AppShell bridge={bridge} />);

    await waitFor(() => expect(bridge.configureWaylandHoldShortcut).toHaveBeenCalledOnce());
    await emitWaylandShortcut({
      status: "error",
      message: "La limpieza de una sesión Wayland anterior todavía está pendiente",
    });

    await waitFor(
      () => expect(bridge.configureWaylandHoldShortcut).toHaveBeenCalledTimes(2),
      { timeout: 1500 },
    );
    expect(bridge.configureWaylandHoldShortcut).toHaveBeenLastCalledWith(DEFAULT_SETTINGS.shortcut);
  });

  it("retries when the portal command rejects because cleanup is still pending", async () => {
    const { bridge } = makeWaylandBridge();
    bridge.configureWaylandHoldShortcut = vi.fn()
      .mockRejectedValueOnce(new Error("La limpieza de una sesión Wayland anterior todavía está pendiente"))
      .mockResolvedValue(undefined);
    render(<AppShell bridge={bridge} />);

    await waitFor(
      () => expect(bridge.configureWaylandHoldShortcut).toHaveBeenCalledTimes(2),
      { timeout: 1500 },
    );
    expect(bridge.configureWaylandHoldShortcut).toHaveBeenLastCalledWith(DEFAULT_SETTINGS.shortcut);
  });

  it("requests portal configuration when an existing assignment is changed", async () => {
    const { bridge, emitWaylandShortcut } = makeWaylandBridge();
    render(<AppShell bridge={bridge} />);

    await waitFor(() => expect(bridge.configureWaylandHoldShortcut).toHaveBeenCalledWith(
      DEFAULT_SETTINGS.shortcut,
    ));
    await emitWaylandShortcut({ status: "registered", triggerDescription: "Ctrl+Shift+Space" });

    fireEvent.click(screen.getByRole("button", { name: /capturar atajo/i }));
    fireEvent.keyDown(screen.getByRole("button", { name: /pulsa el atajo/i }), {
      code: "KeyA",
      key: "a",
      ctrlKey: true,
      altKey: true,
    });

    await waitFor(() => expect(bridge.configureWaylandHoldShortcut).toHaveBeenLastCalledWith(
      "CommandOrControl+Alt+A",
      { requestConfiguration: true },
    ));
  });

  it("clears the portal listener and session on unmount", async () => {
    const { bridge, unlisten } = makeWaylandBridge();
    const { unmount } = render(<AppShell bridge={bridge} />);

    await waitFor(() => expect(bridge.configureWaylandHoldShortcut).toHaveBeenCalled());
    unmount();

    await waitFor(() => expect(bridge.clearWaylandHoldShortcut).toHaveBeenCalledOnce());
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("ignores a queued portal event after switching away from Wayland hold mode", async () => {
    const { bridge, waylandListeners } = makeWaylandBridge();
    const { unmount } = render(<AppShell bridge={bridge} />);

    await waitFor(() => expect(bridge.configureWaylandHoldShortcut).toHaveBeenCalled());
    expect(waylandListeners).toHaveLength(1);

    fireEvent.click(screen.getByRole("radio", { name: /pulsar para alternar/i }));
    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "toggle" }),
    ));

    await act(async () => {
      waylandListeners[0]?.({ status: "pressed" });
      waylandListeners[0]?.({ status: "released" });
    });

    expect(bridge.startDictation).not.toHaveBeenCalled();
    expect(bridge.stopDictation).not.toHaveBeenCalled();
    expect(screen.queryByText(/Atajo Wayland:/i)).toBeNull();
    unmount();
  });

  it("ignores a queued global event after switching to the Wayland portal", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    shortcutPlugin.register.mockClear();
    shortcutPlugin.unregister.mockClear();
    let oldGlobalHandler: ((event: { state: "Pressed" | "Released" }) => void) | undefined;
    shortcutPlugin.register.mockImplementationOnce(async (...args: unknown[]) => {
      oldGlobalHandler = args[1] as ((event: { state: "Pressed" | "Released" }) => void);
    });
    const bridge = makeBridge({
      diagnosePlatform: vi.fn(async () => ({
        session: "x11" as const,
        shortcutMethod: "x11-global-hook",
        holdModeSupported: true,
        toggleModeSupported: true,
      })),
      startDictation: vi.fn(async () => ({ status: "recording" as const })),
      stopDictation: vi.fn(async () => ({ status: "copied" as const })),
    });
    const rendered = render(<AppShell bridge={bridge} />);

    await waitFor(() => expect(oldGlobalHandler).toBeDefined());
    const wayland = makeWaylandBridge();
    rendered.rerender(<AppShell bridge={wayland.bridge} />);
    await waitFor(() => expect(wayland.bridge.configureWaylandHoldShortcut).toHaveBeenCalled());

    await act(async () => {
      oldGlobalHandler?.({ state: "Pressed" });
      oldGlobalHandler?.({ state: "Released" });
    });

    expect(bridge.startDictation).not.toHaveBeenCalled();
    expect(bridge.stopDictation).not.toHaveBeenCalled();
    expect(wayland.bridge.startDictation).not.toHaveBeenCalled();
    expect(wayland.bridge.stopDictation).not.toHaveBeenCalled();
    expect(screen.queryByText(/Atajo Wayland:/i)).toBeNull();
    rendered.unmount();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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

  it("keeps the global shortcut registered while the effect is active", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    shortcutPlugin.register.mockClear();
    shortcutPlugin.unregister.mockClear();
    const bridge = makeBridge({
      diagnosePlatform: vi.fn(async () => ({
        session: "x11" as const,
        shortcutMethod: "x11-global-hook",
        holdModeSupported: true,
        toggleModeSupported: true,
      })),
    });
    const { unmount } = render(<AppShell bridge={bridge} />);

    await waitFor(() => expect(shortcutPlugin.register).toHaveBeenCalledWith(
      "Ctrl+Shift+Space",
      expect.any(Function),
    ));
    expect(shortcutPlugin.unregister).not.toHaveBeenCalled();

    unmount();
    await waitFor(() => expect(shortcutPlugin.unregister).toHaveBeenCalledWith("Ctrl+Shift+Space"));
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("unregisters the previous global shortcut before registering its replacement", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    shortcutPlugin.register.mockClear();
    shortcutPlugin.unregister.mockClear();
    const events: string[] = [];
    shortcutPlugin.register.mockImplementation(async (...args: unknown[]) => {
      events.push(`register:${String(args[0])}`);
    });
    shortcutPlugin.unregister.mockImplementation(async (...args: unknown[]) => {
      events.push(`unregister:${String(args[0])}`);
    });
    const bridge = makeBridge({
      diagnosePlatform: vi.fn(async () => ({
        session: "x11" as const,
        shortcutMethod: "x11-global-hook",
        holdModeSupported: true,
        toggleModeSupported: true,
      })),
    });
    const { unmount } = render(<AppShell bridge={bridge} />);

    await waitFor(() => expect(events).toEqual(["register:Ctrl+Shift+Space"]));
    fireEvent.click(screen.getByRole("button", { name: /capturar atajo/i }));
    fireEvent.keyDown(screen.getByRole("button", { name: /pulsa el atajo/i }), {
      code: "KeyA",
      key: "a",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => expect(events).toEqual([
      "register:Ctrl+Shift+Space",
      "unregister:Ctrl+Shift+Space",
      "register:Ctrl+Shift+A",
    ]));
    expect(shortcutPlugin.unregister).toHaveBeenCalledTimes(1);

    unmount();
    await waitFor(() => expect(shortcutPlugin.unregister).toHaveBeenCalledTimes(2));
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("requests portal configuration after recapturing the same saved shortcut", async () => {
    const { bridge, emitWaylandShortcut } = makeWaylandBridge();
    render(<AppShell bridge={bridge} />);

    await waitFor(() => expect(bridge.configureWaylandHoldShortcut).toHaveBeenCalledWith(
      DEFAULT_SETTINGS.shortcut,
    ));
    await emitWaylandShortcut({ status: "registered", triggerDescription: "Ctrl+Alt+A" });

    fireEvent.click(screen.getByRole("button", { name: /capturar atajo/i }));
    fireEvent.keyDown(screen.getByRole("button", { name: /pulsa el atajo/i }), {
      code: "Space",
      key: " ",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => expect(bridge.configureWaylandHoldShortcut).toHaveBeenLastCalledWith(
      DEFAULT_SETTINGS.shortcut,
      { requestConfiguration: true },
    ));
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
