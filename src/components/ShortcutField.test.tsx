import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SHORTCUT,
  ShortcutField,
  normalizeShortcutFromKeyboardEvent,
  probeGlobalShortcut,
} from "./ShortcutField";

const shortcutPlugin = vi.hoisted(() => ({
  register: vi.fn(async () => undefined),
  unregister: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/plugin-global-shortcut", () => shortcutPlugin);

function keyboardEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("normalizeShortcutFromKeyboardEvent", () => {
  it("normalizes Ctrl+Shift+Space to the global shortcut format", () => {
    expect(normalizeShortcutFromKeyboardEvent(keyboardEvent({
      code: "Space",
      key: " ",
      ctrlKey: true,
      shiftKey: true,
    }))).toEqual({ shortcut: DEFAULT_SHORTCUT });
  });

  it("rejects a modifier without a main key", () => {
    const result = normalizeShortcutFromKeyboardEvent(keyboardEvent({
      code: "ControlLeft",
      key: "Control",
      ctrlKey: true,
    }));

    expect(result.shortcut).toBeUndefined();
    expect(result.error).toMatch(/tecla principal/i);
  });

  it("rejects more than three keys", () => {
    const result = normalizeShortcutFromKeyboardEvent(keyboardEvent({
      code: "KeyA",
      key: "a",
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
      metaKey: true,
    }));

    expect(result.shortcut).toBeUndefined();
    expect(result.error).toMatch(/tres teclas/i);
  });

  it("normalizes letters, functional keys, and modifier names", () => {
    expect(normalizeShortcutFromKeyboardEvent(keyboardEvent({
      code: "KeyA",
      key: "a",
      ctrlKey: true,
      shiftKey: true,
    }))).toEqual({ shortcut: "CommandOrControl+Shift+A" });

    expect(normalizeShortcutFromKeyboardEvent(keyboardEvent({
      code: "F1",
      key: "F1",
      altKey: true,
      metaKey: true,
    }))).toEqual({ shortcut: "Alt+Meta+F1" });
  });
});

describe("ShortcutField", () => {
  it("publishes Ctrl+Shift+Space after one capture", () => {
    const onChange = vi.fn();
    const onError = vi.fn();
    render(
      <ShortcutField
        value={DEFAULT_SHORTCUT}
        onChange={onChange}
        onError={onError}
      />,
    );

    const captureButton = screen.getByRole("button", { name: /capturar atajo/i });
    expect(screen.getByText(DEFAULT_SHORTCUT)).toBeVisible();

    fireEvent.click(captureButton);
    fireEvent.keyDown(captureButton, {
      code: "Space",
      key: " ",
      ctrlKey: true,
      shiftKey: true,
    });

    expect(onChange).toHaveBeenCalledWith(DEFAULT_SHORTCUT);
    expect(onError).toHaveBeenLastCalledWith(undefined);
  });

  it("reports an invalid modifier-only capture", () => {
    const onChange = vi.fn();
    const onError = vi.fn();
    render(<ShortcutField value={DEFAULT_SHORTCUT} onChange={onChange} onError={onError} />);

    const captureButton = screen.getByRole("button", { name: /capturar atajo/i });
    fireEvent.click(captureButton);
    fireEvent.keyDown(captureButton, {
      code: "ShiftLeft",
      key: "Shift",
      shiftKey: true,
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/tecla principal/i));
    expect(screen.getByRole("alert")).toHaveTextContent(/tecla principal/i);
  });
});

describe("probeGlobalShortcut", () => {
  beforeEach(() => {
    shortcutPlugin.register.mockClear();
    shortcutPlugin.unregister.mockClear();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("does nothing in a browser context", async () => {
    await expect(probeGlobalShortcut(DEFAULT_SHORTCUT)).resolves.toBeUndefined();
    expect(shortcutPlugin.register).not.toHaveBeenCalled();
    expect(shortcutPlugin.unregister).not.toHaveBeenCalled();
  });

  it("unregisters the shortcut after probing it in Tauri", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    await expect(probeGlobalShortcut(DEFAULT_SHORTCUT)).resolves.toBeUndefined();

    expect(shortcutPlugin.register).toHaveBeenCalledWith(DEFAULT_SHORTCUT, expect.any(Function));
    expect(shortcutPlugin.unregister).toHaveBeenCalledWith(DEFAULT_SHORTCUT);
  });

  it("unregisters the shortcut when registration fails", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const registrationError = new Error("Atajo no disponible");
    shortcutPlugin.register.mockRejectedValueOnce(registrationError);

    await expect(probeGlobalShortcut(DEFAULT_SHORTCUT)).rejects.toThrow(registrationError);
    expect(shortcutPlugin.unregister).toHaveBeenCalledWith(DEFAULT_SHORTCUT);
  });
});
