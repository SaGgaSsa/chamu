import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "../domain/settings";
import {
  type ChamuBridge,
  type ModelStatus,
  type MicrophoneCheck,
  type ShortcutCheck,
  type ClipboardCheck,
  type HistoryEntry,
} from "../native/commands";
import { OnboardingFlow } from "./OnboardingFlow";

function makeBridge(overrides: Partial<ChamuBridge> = {}): ChamuBridge {
  const model: ModelStatus = {
    id: "base",
    name: "Whisper base multilingüe",
    installed: true,
    checksumValid: true,
    sizeMiB: 142,
  };
  const microphone: MicrophoneCheck = { ok: true, message: "Micrófono disponible" };
  const shortcut: ShortcutCheck = { ok: true, captured: "Ctrl+Super" };
  const clipboard: ClipboardCheck = { ok: true, message: "Portapapeles disponible" };

  return {
    loadSettings: vi.fn(async () => DEFAULT_SETTINGS),
    saveSettings: vi.fn(async (_settings: AppSettings) => undefined),
    inspectModel: vi.fn(async () => model),
    downloadModel: vi.fn(async () => model),
    cancelModelDownload: vi.fn(async () => undefined),
    testMicrophone: vi.fn(async () => microphone),
    testShortcut: vi.fn(async (shortcutValue: string) => ({ ...shortcut, captured: shortcutValue })),
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
  it("explains local privacy and lets the person choose Spanish or English", () => {
    const onComplete = vi.fn();
    render(<OnboardingFlow bridge={makeBridge()} onComplete={onComplete} />);

    expect(screen.getByRole("heading", { name: /configura chamu/i })).toBeVisible();
    expect(screen.getByText(/^sin cuentas\./i)).toBeVisible();
    expect(screen.getByText(/audio se procesa.*descarta/i)).toBeVisible();

    continueStep();

    expect(screen.getByRole("heading", { name: /idioma/i })).toBeVisible();
    expect(screen.getByRole("radio", { name: /español/i })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /english/i }));
    expect(screen.getByRole("radio", { name: /english/i })).toBeChecked();
  });

  it("requires explicit consent before downloading a missing model and can cancel it", async () => {
    const modelMissing: ModelStatus = {
      id: "base",
      name: "Whisper base multilingüe",
      installed: false,
      checksumValid: false,
      sizeMiB: 142,
    };
    const bridge = makeBridge({
      inspectModel: vi.fn(async () => modelMissing),
      downloadModel: vi.fn(() => new Promise<ModelStatus>(() => undefined)),
    });
    render(<OnboardingFlow bridge={bridge} onComplete={vi.fn()} />);

    continueStep();
    continueStep();
    await waitFor(() => expect(screen.getByRole("heading", { name: /modelo/i })).toBeVisible());
    expect(screen.getByText(/no se encontró/i)).toBeVisible();
    expect(bridge.downloadModel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /descargar modelo/i }));
    expect(screen.getByText(/confirmas descargar/i)).toBeVisible();
    expect(screen.getByText(/no se conecta a ningún servicio de transcripción/i)).toBeVisible();
    expect(bridge.downloadModel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /confirmar descarga/i }));
    await waitFor(() => expect(bridge.downloadModel).toHaveBeenCalledWith("base"));

    fireEvent.click(screen.getByRole("button", { name: /cancelar descarga/i }));
    await waitFor(() => expect(bridge.cancelModelDownload).toHaveBeenCalledWith("base"));
  });

  it("unblocks onboarding when a confirmed download returns a validated model", async () => {
    const modelMissing: ModelStatus = {
      id: "base",
      name: "Whisper base multilingüe",
      installed: false,
      checksumValid: false,
      sizeMiB: 142,
    };
    const modelReady: ModelStatus = {
      ...modelMissing,
      installed: true,
      checksumValid: true,
      progress: 100,
    };
    const bridge = makeBridge({
      inspectModel: vi.fn(async () => modelMissing),
      downloadModel: vi.fn(async () => modelReady),
    });
    render(<OnboardingFlow bridge={bridge} onComplete={vi.fn()} />);

    continueStep();
    continueStep();
    await waitFor(() => expect(screen.getByRole("heading", { name: /modelo/i })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: /descargar modelo/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirmar descarga/i }));
    await waitFor(() => expect(screen.getByText(/modelo listo/i)).toBeVisible());
    expect(screen.getByRole("button", { name: /continuar/i })).toBeEnabled();

    continueStep();
    await waitFor(() => expect(screen.getByRole("heading", { name: /micrófono/i })).toBeVisible());
  });

  it("checks microphone, forces an alternative after a failed shortcut, and checks paste", async () => {
    const shortcutProbe = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, captured: "Ctrl+Super", message: "No se pudo capturar" })
      .mockResolvedValueOnce({ ok: true, captured: "Ctrl+Space", message: "Atajo capturado" });
    const bridge = makeBridge({
      testShortcut: shortcutProbe,
    });
    render(<OnboardingFlow bridge={bridge} onComplete={vi.fn()} />);

    continueStep();
    continueStep();
    await waitFor(() => expect(screen.getByRole("heading", { name: /modelo/i })).toBeVisible());
    continueStep();
    await waitFor(() => expect(screen.getByRole("heading", { name: /micrófono/i })).toBeVisible());

    fireEvent.click(screen.getByRole("button", { name: /probar micrófono/i }));
    await waitFor(() => expect(screen.getByText(/micrófono listo/i)).toBeVisible());
    continueStep();

    await waitFor(() => expect(screen.getByRole("heading", { name: /atajo/i })).toBeVisible());
    expect(screen.getByText(/^ctrl \+ super$/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /probar atajo ctrl \+ super/i }));
    await waitFor(() => expect(screen.getByText(/elige y prueba una alternativa/i)).toBeVisible());
    expect(screen.getByRole("button", { name: /ctrl \+ space/i })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /ctrl \+ space/i }));
    await waitFor(() => expect(screen.getByText(/atajo listo/i)).toBeVisible());
    continueStep();

    await waitFor(() => expect(screen.getByRole("heading", { name: /portapapeles/i })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: /probar portapapeles y pegado/i }));
    await waitFor(() => expect(screen.getByText(/portapapeles y pegado listos/i)).toBeVisible());
    expect(bridge.testClipboard).toHaveBeenCalledOnce();
    expect(bridge.testPaste).toHaveBeenCalledOnce();
  });

  it("offers hold and toggle recording modes before finishing onboarding", async () => {
    const bridge = makeBridge();
    const onComplete = vi.fn();
    render(<OnboardingFlow bridge={bridge} onComplete={onComplete} />);

    continueStep();
    fireEvent.click(screen.getByRole("radio", { name: /english/i }));
    continueStep();
    await waitFor(() => expect(screen.getByRole("heading", { name: /modelo/i })).toBeVisible());
    continueStep();
    await waitFor(() => expect(screen.getByRole("heading", { name: /micrófono/i })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: /probar micrófono/i }));
    await waitFor(() => expect(screen.getByText(/micrófono listo/i)).toBeVisible());
    continueStep();
    await waitFor(() => expect(screen.getByRole("heading", { name: /atajo/i })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: /probar atajo/i }));
    await waitFor(() => expect(screen.getByText(/atajo listo/i)).toBeVisible());
    continueStep();
    await waitFor(() => expect(screen.getByRole("heading", { name: /portapapeles/i })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: /probar portapapeles y pegado/i }));
    await waitFor(() => expect(screen.getByText(/portapapeles y pegado listos/i)).toBeVisible());
    continueStep();

    expect(screen.getByRole("heading", { name: /modo de dictado/i })).toBeVisible();
    fireEvent.click(screen.getByRole("radio", { name: /alternar/i }));
    continueStep();
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ language: "en", mode: "toggle" })));
    expect(bridge.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ language: "en", mode: "toggle" }));
  });
});
