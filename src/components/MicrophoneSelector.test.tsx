import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { DEFAULT_SETTINGS } from "../domain/settings";
import type { ChamuBridge } from "../native/commands";
import { MicrophoneSelector } from "./MicrophoneSelector";

function makeBridge(overrides: Partial<ChamuBridge> = {}): ChamuBridge {
  return {
    loadSettings: vi.fn(async () => DEFAULT_SETTINGS),
    saveSettings: vi.fn(async () => undefined),
    getModelCatalog: vi.fn(async () => []),
    inspectModel: vi.fn(async () => ({ id: "small", name: "Whisper", label: "Predeterminado", installed: true, checksumValid: true, active: true, sizeMiB: 466 })),
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

describe("MicrophoneSelector", () => {
  it("shows the system default when no device is selected", async () => {
    render(<MicrophoneSelector bridge={makeBridge()} onChange={vi.fn()} value="" />);

    expect(screen.getByText(/micrófono actual:/i).parentElement).toHaveTextContent("Micrófono predeterminado del sistema");
    const select = await waitFor(() => screen.getByRole("combobox", { name: /dispositivo de captura/i }));
    expect(select).toHaveValue("");
    expect(screen.getByRole("option", { name: /predeterminado del sistema/i })).toBeInTheDocument();
  });

  it("lists every available device and reports a selection", async () => {
    const onChange = vi.fn();
    const bridge = makeBridge({
      listInputDevices: vi.fn(async () => [
        { id: "front:CARD=Generic_1,DEV=0", label: "HD-Audio Generic", isBuiltIn: true },
        { id: "front:CARD=S,DEV=0", label: "HyperX QuadCast S", isBuiltIn: false },
      ]),
    });
    render(<MicrophoneSelector bridge={bridge} onChange={onChange} value="front:CARD=S,DEV=0" />);

    const select = await waitFor(() => screen.getByRole("combobox", { name: /dispositivo de captura/i }));
    expect(select).toHaveValue("front:CARD=S,DEV=0");
    expect(screen.getByRole("option", { name: /HD-Audio Generic \(Integrado\)/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /HyperX QuadCast S/ })).toBeInTheDocument();
    expect(select).toBeEnabled();

    fireEvent.change(select, { target: { value: "front:CARD=Generic_1,DEV=0" } });
    expect(onChange).toHaveBeenCalledWith("front:CARD=Generic_1,DEV=0");
  });

  it("shows the friendly label of the selected device", async () => {
    const bridge = makeBridge({
      listInputDevices: vi.fn(async () => [
        { id: "front:CARD=S,DEV=0", label: "HyperX QuadCast S", isBuiltIn: false },
      ]),
    });
    render(<MicrophoneSelector bridge={bridge} onChange={vi.fn()} value="front:CARD=S,DEV=0" />);

    expect(await waitFor(() => screen.getByText(/micrófono actual:/i).parentElement)).toHaveTextContent("HyperX QuadCast S");
  });

  it("allows returning to the system default when only one device is available", async () => {
    const onChange = vi.fn();
    const bridge = makeBridge({
      listInputDevices: vi.fn(async () => [
        { id: "front:CARD=S,DEV=0", label: "HyperX QuadCast S", isBuiltIn: false },
      ]),
    });
    render(<MicrophoneSelector bridge={bridge} onChange={onChange} value="front:CARD=S,DEV=0" />);

    const select = await waitFor(() => screen.getByRole("combobox", { name: /dispositivo de captura/i }));
    expect(select).toBeEnabled();
    expect(screen.getByRole("option", { name: /predeterminado del sistema/i })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("allows returning to the system default when no device is enumerated", async () => {
    const onChange = vi.fn();
    const bridge = makeBridge({
      listInputDevices: vi.fn(async () => []),
    });
    render(<MicrophoneSelector bridge={bridge} onChange={onChange} value="" />);

    const select = await waitFor(() => screen.getByRole("combobox", { name: /dispositivo de captura/i }));
    expect(select).toBeEnabled();
    expect(screen.getByRole("option", { name: /predeterminado del sistema/i })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the system default when a saved device is no longer enumerated", async () => {
    const onChange = vi.fn();
    const bridge = makeBridge({
      listInputDevices: vi.fn(async () => []),
    });
    render(<MicrophoneSelector bridge={bridge} onChange={onChange} value="front:CARD=missing,DEV=0" />);

    const select = await waitFor(() => screen.getByRole("combobox", { name: /dispositivo de captura/i }));
    expect(screen.getByText(/micrófono actual:/i).parentElement).toHaveTextContent("Micrófono predeterminado del sistema");
    expect(select).toHaveValue("");
    expect(select).toBeEnabled();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(""));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("re-enumerates the devices when the refresh button is pressed", async () => {
    const listInputDevices = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "front:CARD=Generic_1,DEV=0", label: "HD-Audio Generic", isBuiltIn: true },
      ])
      .mockResolvedValueOnce([
        { id: "front:CARD=Generic_1,DEV=0", label: "HD-Audio Generic", isBuiltIn: true },
        { id: "front:CARD=S,DEV=0", label: "HyperX QuadCast S", isBuiltIn: false },
      ]);
    const bridge = makeBridge({ listInputDevices });
    render(<MicrophoneSelector bridge={bridge} onChange={vi.fn()} value="" />);

    const select = await waitFor(() => screen.getByRole("combobox", { name: /dispositivo de captura/i }));
    expect(select).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /actualizar lista de micrófonos/i }));

    await waitFor(() => expect(select).toBeEnabled());
    expect(listInputDevices).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("option", { name: /HyperX QuadCast S/ })).toBeInTheDocument();
  });

  it("shows an error when the device list cannot be loaded", async () => {
    const bridge = makeBridge({
      listInputDevices: vi.fn(async () => {
        throw new Error("sin permisos");
      }),
    });
    render(<MicrophoneSelector bridge={bridge} onChange={vi.fn()} value="" />);

    expect(await screen.findByText(/sin permisos/i)).toBeVisible();
  });
});
