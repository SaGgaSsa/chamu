import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "../domain/settings";
import {
  type ChamuBridge,
  type ClipboardCheck,
  type DictationResult,
  type HistoryEntry,
  type MicrophoneCheck,
  type ModelDownloadProgress,
  type ModelMetadata,
  type ModelStatus,
  type ShortcutCheck,
} from "../native/commands";
import { OnboardingFlow } from "./OnboardingFlow";
import { MODEL_PROFILES } from "./ModelSelector";

const shortcutPlugin = vi.hoisted(() => ({
  register: vi.fn(async () => undefined),
  unregister: vi.fn(async () => undefined),
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
  const microphone: MicrophoneCheck = { ok: true, message: "Micrófono disponible" };
  const shortcut: ShortcutCheck = { ok: true, captured: DEFAULT_SETTINGS.shortcut };
  const clipboard: ClipboardCheck = { ok: true, message: "Portapapeles disponible" };

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
    startModelDownload: vi.fn(async () => undefined),
    onModelDownloadProgress: vi.fn(async () => () => undefined),
    cancelModelDownload: vi.fn(async () => undefined),
    testMicrophone: vi.fn(async () => microphone),
    getMicrophoneInfo: vi.fn(async () => ({ name: "Micrófono USB" })),
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
    await waitFor(() => expect(screen.getByRole("radio", { name: /liviano/i })).toBeVisible());
    expect(screen.getByRole("radio", { name: /predeterminado/i })).toBeVisible();
    expect(screen.getByRole("radio", { name: /calidad/i })).toBeVisible();
    expect(screen.getByRole("radio", { name: /rápido/i })).toBeVisible();
    expect(screen.getByRole("radio", { name: /balanceado/i })).toBeVisible();
    expect(screen.getByRole("radio", { name: /máximo/i })).toBeVisible();
    expect(screen.getByRole("radio", { name: /español/i })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /english/i }));
    expect(screen.getByRole("radio", { name: /english/i })).toBeChecked();
    await waitFor(() => expect(screen.getByText(/modelo listo/i)).toBeVisible());
  });

  it("keeps all six profiles visible when the catalog is incomplete", async () => {
    const bridge = makeBridge({
      getModelCatalog: vi.fn(async () => []),
    });
    render(<OnboardingFlow bridge={bridge} onComplete={vi.fn()} />);

    expect(await screen.findByRole("radio", { name: /rápido/i })).toBeVisible();
    expect(screen.getByRole("radio", { name: /liviano/i })).toBeVisible();
    expect(screen.getByRole("radio", { name: /balanceado/i })).toBeVisible();
    expect(screen.getByRole("radio", { name: /predeterminado/i })).toBeVisible();
    expect(screen.getByRole("radio", { name: /calidad/i })).toBeVisible();
    expect(screen.getByRole("radio", { name: /máximo/i })).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent(/catálogo.*incompleto/i);
  });

  it("subscribes before a confirmed download and renders progress", async () => {
    const missing: ModelStatus = {
      id: "base",
      name: "Whisper base",
      label: "Liviano",
      installed: false,
      checksumValid: false,
      active: false,
      sizeMiB: 142,
    };
    let progressListener: ((progress: ModelDownloadProgress) => void) | undefined;
    const callOrder: string[] = [];
    const bridge = makeBridge({
      inspectModel: vi.fn(async (modelId = "base") => ({ ...missing, id: modelId })),
      onModelDownloadProgress: vi.fn(async (listener) => {
        callOrder.push("listen");
        progressListener = listener;
        return () => undefined;
      }),
      startModelDownload: vi.fn(async () => { callOrder.push("start"); }),
    });
    render(<OnboardingFlow bridge={bridge} onComplete={vi.fn()} />);

    fireEvent.click(await screen.findByRole("radio", { name: /liviano/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /descargar modelo liviano/i })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: /descargar modelo liviano/i }));
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

    expect(await screen.findByRole("status")).toHaveTextContent("Descargando modelo · 50%");
  });

  it("allows cancelling a model download without reopening the consent dialog", async () => {
    const missing: ModelStatus = {
      id: "base",
      name: "Whisper base",
      label: "Liviano",
      installed: false,
      checksumValid: false,
      active: false,
      sizeMiB: 142,
    };
    let progressListener: ((progress: ModelDownloadProgress) => void) | undefined;
    const bridge = makeBridge({
      inspectModel: vi.fn(async (modelId = "base") => ({ ...missing, id: modelId })),
      onModelDownloadProgress: vi.fn(async (listener) => {
        progressListener = listener;
        return () => undefined;
      }),
    });
    render(<OnboardingFlow bridge={bridge} onComplete={vi.fn()} />);

    fireEvent.click(await screen.findByRole("radio", { name: /liviano/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /descargar modelo liviano/i })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: /descargar modelo liviano/i }));
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
    expect(screen.queryByRole("dialog", { name: /confirmar descarga del modelo/i })).toBeNull();
  });

  it("downloads and activates a different selected profile before continuing", async () => {
    let progressListener: ((progress: ModelDownloadProgress) => void) | undefined;
    let baseInspectionCount = 0;
    const callOrder: string[] = [];
    const bridge = makeBridge({
      inspectModel: vi.fn(async (modelId = "small") => {
        if (modelId === "base") {
          baseInspectionCount += 1;
          return {
            id: modelId,
            name: "Whisper base",
            label: "Liviano",
            installed: baseInspectionCount > 1,
            checksumValid: baseInspectionCount > 1,
            active: false,
            sizeMiB: 142,
          };
        }
        return {
          id: modelId,
          name: `Whisper ${modelId}`,
          label: MODEL_PROFILES.find((profile) => profile.id === modelId)?.label ?? "Predeterminado",
          installed: true,
          checksumValid: true,
          active: modelId === "small",
          sizeMiB: MODEL_PROFILES.find((profile) => profile.id === modelId)?.displaySizeMiB ?? 466,
        };
      }),
      onModelDownloadProgress: vi.fn(async (listener) => {
        callOrder.push("listen");
        progressListener = listener;
        return () => undefined;
      }),
      startModelDownload: vi.fn(async () => {
        callOrder.push("start");
      }),
      activateModel: vi.fn(async (modelId) => {
        callOrder.push(`activate:${modelId}`);
      }),
    });
    render(<OnboardingFlow bridge={bridge} onComplete={vi.fn()} />);

    fireEvent.click(await screen.findByRole("radio", { name: /liviano/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /descargar modelo liviano/i })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: /descargar modelo liviano/i }));
    expect(bridge.startModelDownload).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /confirmar descarga/i })).toHaveTextContent("142 MiB");
    fireEvent.click(screen.getByRole("button", { name: /confirmar descarga/i }));

    await waitFor(() => expect(bridge.startModelDownload).toHaveBeenCalledWith("base"));
    expect(callOrder).toEqual(["listen", "start"]);
    expect(bridge.activateModel).not.toHaveBeenCalled();

    await act(async () => {
      progressListener?.({
        modelId: "base",
        phase: "completed",
        downloadedBytes: 142,
        totalBytes: 142,
        percent: 100,
        message: "Descarga completada",
      });
    });

    await waitFor(() => expect(screen.getByText(/modelo listo/i)).toBeVisible());
    continueStep();
    await waitFor(() => expect(bridge.activateModel).toHaveBeenCalledWith("base"));
    expect(callOrder).toContain("activate:base");
    expect(screen.getByRole("heading", { name: /prueba el dictado/i })).toBeVisible();
  });

  it("unlistens once when a download reports a terminal failure", async () => {
    const missing: ModelStatus = {
      id: "base",
      name: "Whisper base",
      label: "Liviano",
      installed: false,
      checksumValid: false,
      active: false,
      sizeMiB: 142,
    };
    let progressListener: ((progress: ModelDownloadProgress) => void) | undefined;
    const unlisten = vi.fn();
    const bridge = makeBridge({
      inspectModel: vi.fn(async (modelId = "base") => ({ ...missing, id: modelId })),
      onModelDownloadProgress: vi.fn(async (listener) => {
        progressListener = listener;
        return unlisten;
      }),
    });
    const { unmount } = render(<OnboardingFlow bridge={bridge} onComplete={vi.fn()} />);

    fireEvent.click(await screen.findByRole("radio", { name: /liviano/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /descargar modelo liviano/i })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: /descargar modelo liviano/i }));
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

    expect(bridge.activateModel).toHaveBeenCalledWith("small");

    await waitFor(() => expect(screen.getByRole("heading", { name: /prueba el dictado/i })).toBeVisible());
    expect(screen.getByRole("textbox", { name: /texto de prueba/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /probar atajo|probar micrófono|probar pegado/i })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /pulsar para alternar/i }));
    continueStep();

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ mode: "toggle" })));
    expect(bridge.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ mode: "toggle" }));
  });

  it("saves the selected input device when finishing", async () => {
    const bridge = makeBridge({
      listInputDevices: vi.fn(async () => [
        { id: "front:CARD=Generic_1,DEV=0", label: "HD-Audio Generic", isBuiltIn: true },
        { id: "front:CARD=S,DEV=0", label: "HyperX QuadCast S", isBuiltIn: false },
      ]),
    });
    const onComplete = vi.fn();
    render(<OnboardingFlow bridge={bridge} onComplete={onComplete} />);

    await waitFor(() => expect(screen.getByText(/modelo listo/i)).toBeVisible());
    continueStep();
    await waitFor(() => expect(screen.getByRole("heading", { name: /prueba el dictado/i })).toBeVisible());

    const select = await waitFor(() => screen.getByRole("combobox", { name: /dispositivo de captura/i }));
    fireEvent.change(select, { target: { value: "front:CARD=S,DEV=0" } });
    continueStep();

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ inputDevice: "front:CARD=S,DEV=0" })));
    expect(bridge.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ inputDevice: "front:CARD=S,DEV=0" }));
  });

  it("does not continue or change modelId when activation fails", async () => {
    const initialSettings = { ...DEFAULT_SETTINGS, modelId: "small" };
    const bridge = makeBridge({
      activateModel: vi.fn(async () => {
        throw new Error("No se pudo activar el modelo");
      }),
    });
    const onComplete = vi.fn();
    render(<OnboardingFlow bridge={bridge} initialSettings={initialSettings} onComplete={onComplete} />);

    await waitFor(() => expect(screen.getByText(/modelo listo/i)).toBeVisible());
    continueStep();

    await waitFor(() => expect(screen.getByText("No se pudo activar el modelo")).toBeVisible());
    expect(screen.getByRole("heading", { name: /prepara el modelo/i })).toBeVisible();
    expect(screen.getByRole("radio", { name: /predeterminado/i })).toBeChecked();
    expect(onComplete).not.toHaveBeenCalled();
    expect(bridge.saveSettings).not.toHaveBeenCalled();
  });

  it("ignores a catalog response from a previous bridge", async () => {
    let resolveOldCatalog: ((value: ModelMetadata[]) => void) | undefined;
    const oldCatalog = new Promise<ModelMetadata[]>((resolve) => {
      resolveOldCatalog = resolve;
    });
    const oldBridge = makeBridge({ getModelCatalog: vi.fn(() => oldCatalog) });
    const newBridge = makeBridge();
    const rendered = render(<OnboardingFlow bridge={oldBridge} onComplete={vi.fn()} />);

    rendered.rerender(<OnboardingFlow bridge={newBridge} onComplete={vi.fn()} />);
    expect(await screen.findByRole("radio", { name: /calidad/i })).toBeVisible();

    await act(async () => {
      resolveOldCatalog?.([]);
    });

    expect(screen.getByRole("radio", { name: /liviano/i })).toBeVisible();
    expect(screen.getByRole("radio", { name: /predeterminado/i })).toBeVisible();
    expect(screen.getByRole("radio", { name: /calidad/i })).toBeVisible();
  });

  it("ignores an inspection response from a previous bridge", async () => {
    const oldResolvers: Record<string, (value: ModelStatus) => void> = {};
    const oldBridge = makeBridge({
      inspectModel: vi.fn((modelId = "small") => new Promise<ModelStatus>((resolve) => {
        oldResolvers[modelId] = resolve;
      })),
    });
    const newBridge = makeBridge();
    const rendered = render(<OnboardingFlow bridge={oldBridge} onComplete={vi.fn()} />);

    await waitFor(() => expect(Object.keys(oldResolvers)).toHaveLength(6));
    rendered.rerender(<OnboardingFlow bridge={newBridge} onComplete={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/modelo listo/i)).toBeVisible());

    await act(async () => {
      Object.values(oldResolvers).forEach((resolve) => resolve({
        id: "small",
        name: "Whisper small",
        label: "Predeterminado",
        installed: true,
        checksumValid: false,
        active: false,
        sizeMiB: 466,
        error: "Respuesta antigua",
      }));
    });

    expect(screen.queryByText(/respuesta antigua/i)).toBeNull();
    expect(screen.getByText(/modelo listo/i)).toBeVisible();
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

  it("shows the default microphone name in the setup tester", async () => {
    const getMicrophoneInfo = vi.fn(async () => ({ name: "Micrófono USB" }));
    const bridge = makeBridge({ getMicrophoneInfo });

    render(<OnboardingFlow bridge={bridge} onComplete={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/modelo listo/i)).toBeVisible());
    continueStep();

    await waitFor(() => expect(screen.getByText("Micrófono activo: Micrófono USB")).toBeVisible());
    expect(getMicrophoneInfo).toHaveBeenCalledOnce();
  });

  it("shows microphone preparation until native capture starts", async () => {
    let resolveStart: ((result: DictationResult) => void) | undefined;
    const bridge = makeBridge({
      startDictation: vi.fn(() => new Promise<DictationResult>((resolve) => {
        resolveStart = resolve;
      })),
    });

    render(<OnboardingFlow bridge={bridge} onComplete={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/modelo listo/i)).toBeVisible());
    continueStep();

    const startButton = await screen.findByRole("button", { name: /comenzar dictado/i });
    fireEvent.click(startButton);

    expect(screen.getByText("Preparando micrófono…")).toBeVisible();
    expect(startButton).toBeDisabled();

    resolveStart?.({ status: "recording" });
    await waitFor(() => expect(screen.getByText("Grabando")).toBeVisible());
    expect(screen.queryByText("Preparando micrófono…")).toBeNull();
  });

  it("pauses and resumes the global shortcut while capturing", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    Object.defineProperty(window.navigator, "platform", { configurable: true, value: "Linux x86_64" });
    const bridge = makeBridge();

    render(<OnboardingFlow bridge={bridge} onComplete={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/modelo listo/i)).toBeVisible());
    continueStep();
    await waitFor(() => expect(shortcutPlugin.register).toHaveBeenCalledWith(
      "Ctrl+Shift+Space",
      expect.any(Function),
    ));
    const registrationsBeforeCapture = shortcutPlugin.register.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /capturar atajo/i }));
    await waitFor(() => expect(shortcutPlugin.unregister).toHaveBeenCalledWith("Ctrl+Shift+Space"));
    expect(shortcutPlugin.register).toHaveBeenCalledTimes(registrationsBeforeCapture);

    fireEvent.keyDown(screen.getByRole("button", { name: /pulsa el atajo/i }), {
      code: "Escape",
      key: "Escape",
    });
    await waitFor(() => expect(shortcutPlugin.register).toHaveBeenCalledTimes(registrationsBeforeCapture + 1));
  });
});
