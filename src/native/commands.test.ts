import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import {
  activateModel,
  cancelModelDownload,
  copyHistory,
  getModelCatalog,
  onModelDownloadProgress,
  startModelDownload,
} from "./commands";

describe("native history bridge", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    listen.mockReset();
  });

  it("copies by stored history id without sending caller-provided text", async () => {
    await copyHistory("entry-42");

    expect(invoke).toHaveBeenCalledWith("copy_history_entry", { id: "entry-42" });
  });

  it("starts a model download through the asynchronous native command", async () => {
    await startModelDownload("base");

    expect(invoke).toHaveBeenCalledWith("start_model_download", { modelId: "base" });
  });

  it("loads the closed model catalog through the native command", async () => {
    await getModelCatalog();

    expect(invoke).toHaveBeenCalledWith("get_model_catalog");
  });

  it("activates a selected model through the native command", async () => {
    await activateModel("small");

    expect(invoke).toHaveBeenCalledWith("activate_model", { modelId: "small" });
  });

  it("cancels a model download through the native command", async () => {
    await cancelModelDownload("base");

    expect(invoke).toHaveBeenCalledWith("cancel_model_download", { modelId: "base" });
  });

  it("forwards camelCase progress and releases the native event listener", async () => {
    const unlisten = vi.fn();
    let handleProgress: ((event: { payload: Record<string, unknown> }) => void) | undefined;
    listen.mockImplementation(async (_event, handler) => {
      handleProgress = handler;
      return unlisten;
    });
    const listener = vi.fn();

    const release = await onModelDownloadProgress(listener);

    expect(listen).toHaveBeenCalledWith("model-download-progress", expect.any(Function));
    handleProgress?.({
      payload: {
        model_id: "base",
        phase: "downloading",
        downloaded_bytes: 512,
        total_bytes: 1024,
        percent: 50,
        message: "Descargando modelo",
      },
    });

    expect(listener).toHaveBeenCalledWith({
      modelId: "base",
      phase: "downloading",
      downloadedBytes: 512,
      totalBytes: 1024,
      percent: 50,
      message: "Descargando modelo",
    });

    await release();

    expect(unlisten).toHaveBeenCalledOnce();
  });
});
