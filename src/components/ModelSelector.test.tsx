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

  it("keeps all three profiles visible when the catalog is incomplete", async () => {
    const bridge = makeBridge({
      getModelCatalog: vi.fn(async () => catalog.slice(0, 1)),
    });

    render(<ModelSelector bridge={bridge} selectedModelId="small" onModelActivated={vi.fn()} />);

    expect(await screen.findByRole("radio", { name: /liviano/i })).toBeVisible();
    expect(screen.getByRole("radio", { name: /predeterminado/i })).toBeVisible();
    expect(screen.getByRole("radio", { name: /calidad/i })).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent(/catálogo.*incompleto/i);
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

    await waitFor(() => expect(bridge.activateModel).toHaveBeenCalledWith("base"));
    expect(screen.getByRole("radio", { name: /liviano/i })).toBeDisabled();
    expect(onModelActivated).not.toHaveBeenCalled();

    resolveActivation?.();
    await waitFor(() => expect(onModelActivated).toHaveBeenCalledWith("base"));
  });

  it("blocks the screen with a loading overlay while the model loads", async () => {
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
    render(<ModelSelector bridge={bridge} selectedModelId="small" onModelActivated={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("radio", { name: /liviano/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("radio", { name: /liviano/i }));

    await waitFor(() => expect(screen.getByText(/cargando modelo liviano/i)).toBeVisible());
    const overlay = screen.getByText(/cargando modelo liviano/i).closest("[role='status']");
    expect(overlay).not.toBeNull();
    expect(screen.getByRole("radio", { name: /predeterminado/i })).toBeDisabled();

    resolveActivation?.();
    await waitFor(() => expect(screen.queryByText(/cargando modelo liviano/i)).toBeNull());
  });

  it("checks and activates an inactive model only when it is selected", async () => {
    const bridge = makeBridge({
      inspectModel: vi.fn(async (modelId = "small") => status(modelId, {
        installed: true,
        checksumValid: true,
        active: modelId === "small",
      })),
    });
    render(<ModelSelector bridge={bridge} selectedModelId="small" onModelActivated={vi.fn()} />);

    await waitFor(() => expect(screen.getAllByText("Activo").length).toBeGreaterThan(0));
    expect(bridge.inspectModel).toHaveBeenCalledTimes(1);
    expect(bridge.inspectModel).toHaveBeenCalledWith("small");
    expect(screen.queryByText("Instalado")).toBeNull();
    expect(screen.queryByText(/comprobando estado/i)).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /liviano/i }));
    await waitFor(() => expect(bridge.inspectModel).toHaveBeenCalledWith("base"));
    await waitFor(() => expect(screen.getAllByText("Activo").length).toBeGreaterThan(1));
    expect(screen.getAllByText("Instalado")[0]).toBeVisible();
  });

  it("requires confirmation, reports progress, and does not activate during download", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: /descargar modelo calidad/i }));
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
    expect(bridge.activateModel).not.toHaveBeenCalled();
  });

  it("refreshes the profile that completed its download and activates it immediately", async () => {
    let progressListener: ((progress: ModelDownloadProgress) => void) | undefined;
    let largeInspectionCount = 0;
    const bridge = makeBridge({
      inspectModel: vi.fn(async (modelId = "small") => {
        if (modelId === "large-v3-turbo-q5_0") {
          largeInspectionCount += 1;
          return status(modelId, {
            installed: largeInspectionCount > 1,
            checksumValid: largeInspectionCount > 1,
            active: false,
          });
        }
        return status(modelId);
      }),
      onModelDownloadProgress: vi.fn(async (listener) => {
        progressListener = listener;
        return () => undefined;
      }),
    });
    const onModelActivated = vi.fn();
    render(<ModelSelector bridge={bridge} selectedModelId="small" onModelActivated={onModelActivated} />);

    fireEvent.click(await screen.findByRole("radio", { name: /calidad/i }));
    fireEvent.click(await screen.findByRole("button", { name: /descargar modelo calidad/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirmar descarga/i }));
    await waitFor(() => expect(bridge.startModelDownload).toHaveBeenCalledWith("large-v3-turbo-q5_0"));

    await act(async () => {
      progressListener?.({
        modelId: "large-v3-turbo-q5_0",
        phase: "completed",
        downloadedBytes: 547,
        totalBytes: 547,
        percent: 100,
        message: "Descarga completada",
      });
    });

    await waitFor(() => expect(bridge.inspectModel).toHaveBeenCalledWith("large-v3-turbo-q5_0"));
    await waitFor(() => expect(bridge.activateModel).toHaveBeenCalledWith("large-v3-turbo-q5_0"));
    await waitFor(() => expect(onModelActivated).toHaveBeenCalledWith("large-v3-turbo-q5_0"));
    expect(largeInspectionCount).toBeGreaterThan(1);
  });

  it("shows checksum and status errors only for the models it checks", async () => {
    const bridge = makeBridge({
      inspectModel: vi.fn(async (modelId = "small") => status(modelId, modelId === "base"
        ? { installed: true, checksumValid: false }
        : { error: "No se pudo comprobar el archivo" })),
    });
    render(<ModelSelector bridge={bridge} selectedModelId="small" onModelActivated={vi.fn()} />);

    await waitFor(() => expect(screen.getAllByText("Error: No se pudo comprobar el archivo")[0]).toBeVisible());
    expect(screen.queryByText("Checksum inválido")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /liviano/i }));
    await waitFor(() => expect(screen.getByText("Checksum inválido")).toBeVisible());
  });

  it("preserves the previous active profile when activation fails", async () => {
    const bridge = makeBridge({
      inspectModel: vi.fn(async (modelId = "small") => status(modelId, {
        installed: true,
        checksumValid: true,
        active: modelId === "small",
      })),
      activateModel: vi.fn(async () => {
        throw new Error("No se pudo activar el modelo");
      }),
    });
    const onModelActivated = vi.fn();
    render(<ModelSelector bridge={bridge} selectedModelId="small" onModelActivated={onModelActivated} />);

    const previous = await screen.findByRole("radio", { name: /predeterminado/i });
    const candidate = screen.getByRole("radio", { name: /liviano/i });
    fireEvent.click(candidate);

    await waitFor(() => expect(screen.getByText("No se pudo activar el modelo")).toBeVisible());
    expect(previous).toBeChecked();
    expect(candidate).not.toBeChecked();
    expect(screen.getAllByText("Activo").length).toBeGreaterThan(0);
    expect(onModelActivated).not.toHaveBeenCalled();
  });

  it("ignores a catalog response from a previous bridge", async () => {
    let resolveOldCatalog: ((value: ModelMetadata[]) => void) | undefined;
    const oldCatalog = new Promise<ModelMetadata[]>((resolve) => {
      resolveOldCatalog = resolve;
    });
    const oldBridge = makeBridge({ getModelCatalog: vi.fn(() => oldCatalog) });
    const newBridge = makeBridge();
    const rendered = render(
      <ModelSelector bridge={oldBridge} selectedModelId="small" onModelActivated={vi.fn()} />,
    );

    rendered.rerender(<ModelSelector bridge={newBridge} selectedModelId="small" onModelActivated={vi.fn()} />);
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
    const newBridge = makeBridge({
      inspectModel: vi.fn(async (modelId = "small") => status(modelId, {
        installed: true,
        checksumValid: true,
        active: modelId === "small",
      })),
    });
    const rendered = render(
      <ModelSelector bridge={oldBridge} selectedModelId="small" onModelActivated={vi.fn()} />,
    );

    await waitFor(() => expect(Object.keys(oldResolvers)).toHaveLength(1));
    rendered.rerender(<ModelSelector bridge={newBridge} selectedModelId="small" onModelActivated={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText("Activo").length).toBeGreaterThan(0));

    await act(async () => {
      Object.values(oldResolvers).forEach((resolve) => resolve(status("small", {
        error: "Respuesta antigua",
      })));
    });

    expect(screen.queryByText(/respuesta antigua/i)).toBeNull();
    expect(screen.getAllByText("Activo").length).toBeGreaterThan(0);
  });
});
