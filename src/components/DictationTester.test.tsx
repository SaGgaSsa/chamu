import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../domain/settings";
import type { AppSettings } from "../domain/settings";
import type { RecordingState } from "../domain/recording";
import type { WaylandHoldShortcutEvent } from "../native/commands";
import { DictationTester, type DictationTesterHandle } from "./DictationTester";

function renderTester(overrides: Partial<{
  settings: AppSettings;
  state: RecordingState;
  pending: boolean;
  starting?: boolean;
  microphoneName?: string;
  resultText?: string;
  resultId?: string | number;
  shortcutRegistrationError?: string | null;
  waylandShortcutStatus?: WaylandHoldShortcutEvent;
} > = {}) {
  const onSettingsChange = vi.fn();
  const onDictationClick = vi.fn();
  const onShortcutRegistrationError = vi.fn();
  const props = {
    settings: DEFAULT_SETTINGS,
    onSettingsChange,
    state: { status: "ready" } as RecordingState,
    pending: false,
    starting: false,
    microphoneName: undefined,
    onDictationClick,
    resultText: undefined,
    resultId: undefined,
    shortcutRegistrationError: null,
    waylandShortcutStatus: undefined,
    onShortcutRegistrationError,
    ...overrides,
  };

  return {
    ...render(<DictationTester {...props} />),
    onSettingsChange,
    onDictationClick,
    onShortcutRegistrationError,
    props,
  };
}

describe("DictationTester", () => {
  it("inserts each result once when it has the same result identity", () => {
    const testerRef = createRef<DictationTesterHandle>();
    const { rerender, props } = renderTester();
    const textarea = screen.getByRole("textbox", { name: /texto de prueba/i }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "Buenos días" } });
    fireEvent.focus(textarea);
    textarea.setSelectionRange(7, 11);
    rerender(<DictationTester {...props} ref={testerRef} />);
    testerRef.current?.prepareForDictation();

    rerender(<DictationTester {...props} resultText="Chamu" resultId="result-1" />);
    expect(textarea).toHaveValue("Buenos Chamu");

    rerender(<DictationTester {...props} resultText="Chamu" resultId="result-1" />);
    expect(textarea).toHaveValue("Buenos Chamu");
  });

  it("exposes preparation for a global shortcut before focus leaves the textarea", () => {
    const testerRef = createRef<DictationTesterHandle>();
    const { rerender, props } = renderTester();
    const textarea = screen.getByRole("textbox", { name: /texto de prueba/i }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Texto base" } });
    fireEvent.focus(textarea);
    textarea.setSelectionRange(0, 5);

    rerender(<DictationTester {...props} ref={testerRef} />);
    testerRef.current?.prepareForDictation();
    fireEvent.blur(textarea);

    rerender(<DictationTester {...props} ref={testerRef} resultText="Nuevo" resultId="result-1" />);
    expect(textarea).toHaveValue("Nuevo base");
  });

  it("inserts two distinct results when their text is equal", () => {
    const testerRef = createRef<DictationTesterHandle>();
    const { rerender, props } = renderTester();
    const textarea = screen.getByRole("textbox", { name: /texto de prueba/i }) as HTMLTextAreaElement;
    fireEvent.focus(textarea);
    textarea.setSelectionRange(0, 0);
    rerender(<DictationTester {...props} ref={testerRef} />);
    testerRef.current?.prepareForDictation();

    rerender(<DictationTester {...props} ref={testerRef} resultText="hola" resultId="result-1" />);
    expect(textarea).toHaveValue("hola");

    fireEvent.focus(textarea);
    textarea.setSelectionRange(4, 4);
    testerRef.current?.prepareForDictation();
    rerender(<DictationTester {...props} ref={testerRef} resultText="hola" resultId="result-2" />);
    expect(textarea).toHaveValue("holahola");
  });

  it("does not insert when the textarea was unfocused at dictation start", () => {
    const testerRef = createRef<DictationTesterHandle>();
    const { rerender, props } = renderTester();
    const textarea = screen.getByRole("textbox", { name: /texto de prueba/i }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Texto base" } });
    rerender(<DictationTester {...props} ref={testerRef} />);
    testerRef.current?.prepareForDictation();
    fireEvent.focus(textarea);

    rerender(<DictationTester {...props} ref={testerRef} resultText="Nuevo" resultId="result-1" />);
    expect(textarea).toHaveValue("Texto base");
    expect(screen.getByText(/portapapeles/i)).toBeVisible();
  });

  it("clears a captured selection when a result is empty", () => {
    const testerRef = createRef<DictationTesterHandle>();
    const { rerender, props } = renderTester();
    const textarea = screen.getByRole("textbox", { name: /texto de prueba/i }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Texto base" } });
    fireEvent.focus(textarea);
    textarea.setSelectionRange(0, 5);
    rerender(<DictationTester {...props} ref={testerRef} />);
    testerRef.current?.prepareForDictation();
    rerender(<DictationTester {...props} ref={testerRef} resultText="" resultId="result-empty" />);

    fireEvent.blur(textarea);
    rerender(<DictationTester {...props} ref={testerRef} resultText="Nuevo" resultId="result-1" />);
    expect(textarea).toHaveValue("Texto base");
  });

  it("reports a copied-only result when the textarea was not focused", () => {
    renderTester({ resultText: "Texto dictado" });

    expect(screen.getByRole("textbox", { name: /texto de prueba/i })).toHaveValue("");
    expect(screen.getByText(/portapapeles/i)).toBeVisible();
  });

  it("updates recording mode and the saved shortcut through settings", () => {
    const { onSettingsChange } = renderTester();

    fireEvent.click(screen.getByRole("radio", { name: /pulsar para alternar/i }));
    expect(onSettingsChange).toHaveBeenCalledWith({
      ...DEFAULT_SETTINGS,
      mode: "toggle",
    });

    const captureButton = screen.getByRole("button", { name: /capturar atajo/i });
    fireEvent.click(captureButton);
    fireEvent.keyDown(screen.getByRole("button", { name: /pulsa el atajo/i }), {
      code: "KeyA",
      key: "a",
      ctrlKey: true,
      shiftKey: true,
    });

    expect(onSettingsChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SETTINGS,
      shortcut: "CommandOrControl+Shift+A",
    });
  });

  it("shows the active microphone name", () => {
    renderTester({ microphoneName: "Micrófono USB" });

    expect(screen.getByText("Micrófono activo: Micrófono USB")).toBeVisible();
  });

  it("shows the latest Wayland portal transition and its error message", () => {
    const { rerender, props } = renderTester();

    expect(screen.queryByText(/Atajo Wayland:/i)).toBeNull();

    rerender(
      <DictationTester
        {...props}
        waylandShortcutStatus={{ status: "registered" }}
      />,
    );
    expect(screen.getByText("Atajo Wayland: registrado")).toBeVisible();

    rerender(
      <DictationTester
        {...props}
        waylandShortcutStatus={{ status: "error", message: "Permiso rechazado" }}
      />,
    );
    expect(screen.getByText(/Permiso rechazado/)).toBeVisible();
  });
});
