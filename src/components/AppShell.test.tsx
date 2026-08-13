import { render, screen } from "@testing-library/react";
import { fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { AppShell } from "./AppShell";
import { DEFAULT_SETTINGS, type AppSettings } from "../domain/settings";
import type { ChamuBridge, DictationResult, HistoryEntry } from "../native/commands";

function makeBridge(): ChamuBridge {
  return {
    loadSettings: vi.fn(async () => DEFAULT_SETTINGS),
    saveSettings: vi.fn(async (_settings: AppSettings) => undefined),
    inspectModel: vi.fn(),
    downloadModel: vi.fn(),
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
    fireEvent.click(screen.getByRole("button", { name: /guardar configuración/i }));

    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ mode: "toggle" })));
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
});
