import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { DEFAULT_SETTINGS } from "../domain/settings";
import type {
  ChamuBridge,
  ModelDownloadProgress,
  ModelMetadata,
  ModelStatus,
} from "../native/commands";
import { MODEL_PROFILES, ModelSelector } from "./ModelSelector";

const catalog: ModelMetadata[] = MODEL_PROFILES.map((profile) => ({
  id: profile.id,
  label: profile.label,
  filename: `ggml-${profile.id}.bin`,
  language: "multilingual",
  sizeBytes: profile.displaySizeMiB * 1024 * 1024,
  sha256: "checksum",
  downloadUrl: "https://example.invalid/model.bin",
}));

function status(id: string, overrides: Partial<ModelStatus> = {}): ModelStatus {
  const profile = MODEL_PROFILES.find((item) => item.id === id) ?? MODEL_PROFILES[0];
  return {
    id,
    name: `Whisper ${id}`,
    label: profile.label,
    installed: false,
    checksumValid: false,
    active: id === "small",
    sizeMiB: profile.displaySizeMiB,
    ...overrides,
  };
}

function makeBridge(overrides: Partial<ChamuBridge> = {}): ChamuBridge {
  return {
    loadSettings: vi.fn(async () => DEFAULT_SETTINGS),
    saveSettings: vi.fn(async () => undefined),
    getModelCatalog: vi.fn(async () => catalog),
    inspectModel: vi.fn(async (modelId = "small") => status(modelId)),
    activateModel: vi.fn(async () => undefined),
    startModelDownload: vi.fn(async () => undefined),
    onModelDownloadProgress: vi.fn(async () => () => undefined),
    cancelModelDownload: vi.fn(async () => undefined),
    testMicrophone: vi.fn(),
    testShortcut: vi.fn(),
    testClipboard: vi.fn(),
    testPaste: vi.fn(),
    loadHistory: vi.fn(async () => []),
    copyHistory: vi.fn(async () => undefined),
    deleteHistory: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("ModelSelector", () => {
  it("shows the three closed Whisper profiles with exact display sizes", async () => {
    render(<ModelSelector bridge={makeBridge()} selectedModelId="small" onModelActivated={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("radio", { name: /liviano/i })).toBeVisible());
    expect(screen.getByRole("radio", { name: /predeterminado/i })).toBeChecked();
    expect(screen.getByText(/Liviano.*142 MiB/i)).toBeVisible();
    expect(screen.getAllByText(/Predeterminado.*466 MiB/i)[0]).toBeVisible();
    expect(screen.getByText(/Calidad.*547 MiB/i)).toBeVisible();
  });

  it("activates an installed valid profile only after the bridge resolves", async () => {
    let resolveActivation: (() => void) | undefined;
    const bridge = makeBridge({
      inspectModel: vi.fn(async (modelId = "small") => status(modelId, {
        installed: true,
        checksumValid: true,
        active: modelId === "small",
      })),
      activateModel: vi.fn(() => new Promise<void>((resolve) => {
        resolveActivation = resolve;
      })),
    });
    const onModelActivated = vi.fn();
    render(<ModelSelector bridge={bridge} selectedModelId="small" onModelActivated={onModelActivated} />);

    await waitFor(() => expect(screen.getByRole("radio", { name: /liviano/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("radio", { name: /liviano/i }));

    expect(bridge.activateModel).toHaveBeenCalledWith("base");
    expect(screen.getByRole("radio", { name: /liviano/i })).toBeDisabled();
    expect(onModelActivated).not.toHaveBeenCalled();

    resolveActivation?.();
    await waitFor(() => expect(onModelActivated).toHaveBeenCalledWith("base"));
  });

  it("requires confirmation, reports progress, and does not activate after download", async () => {
    let progressListener: ((progress: ModelDownloadProgress) => void) | undefined;
    const missing = (modelId = "small") => status(modelId, {
      installed: modelId !== "large-v3-turbo-q5_0",
      checksumValid: modelId !== "large-v3-turbo-q5_0",
      active: modelId === "small",
    });
    const bridge = makeBridge({
      inspectModel: vi.fn(async (modelId = "small") => missing(modelId)),
      onModelDownloadProgress: vi.fn(async (listener) => {
        progressListener = listener;
        return () => undefined;
      }),
    });
    render(<ModelSelector bridge={bridge} selectedModelId="small" onModelActivated={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("radio", { name: /calidad/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("radio", { name: /calidad/i }));
    fireEvent.click(screen.getByRole("button", { name: /descargar modelo calidad/i }));
    expect(bridge.startModelDownload).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /confirmar descarga/i })).toHaveTextContent("547 MiB");

    fireEvent.click(screen.getByRole("button", { name: /confirmar descarga/i }));
    await waitFor(() => expect(bridge.startModelDownload).toHaveBeenCalledWith("large-v3-turbo-q5_0"));

    await act(async () => {
      progressListener?.({
        modelId: "large-v3-turbo-q5_0",
        phase: "downloading",
        downloadedBytes: 10,
        totalBytes: 100,
        percent: 10,
        message: "Descargando modelo",
      });
    });
    expect(screen.getByText(/descargando modelo.*10%/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /activar/i })).toBeNull();
  });
});
