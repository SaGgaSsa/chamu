import { useCallback, useEffect, useState } from "react";
import type { ChamuBridge, InputDevice } from "../native/commands";

const SYSTEM_DEFAULT_LABEL = "Micrófono predeterminado del sistema";

export interface MicrophoneSelectorProps {
  bridge: ChamuBridge;
  /** Empty string selects the system default input device. */
  value: string;
  onChange: (inputDevice: string) => void;
  disabled?: boolean;
  heading?: string;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function MicrophoneSelector({
  bridge,
  value,
  onChange,
  disabled = false,
  heading = "Micrófono",
}: MicrophoneSelectorProps) {
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDevices = useCallback(() => {
    const listDevices = bridge.listInputDevices;
    if (!listDevices) {
      setError("No se pudo enumerar los micrófonos");
      return;
    }
    setLoading(true);
    setLoaded(false);
    setError(null);
    void listDevices()
      .then((found) => {
        console.log("[chamu] selector devices:", found, "selected:", value);
        setDevices(found);
        setLoading(false);
        setLoaded(true);
      })
      .catch((listError: unknown) => {
        setError(getErrorMessage(listError, "No se pudo enumerar los micrófonos"));
        setLoading(false);
      });
  }, [bridge]);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  useEffect(() => {
    if (loaded && !loading && !error && value && !devices.some((device) => device.id === value)) {
      onChange("");
    }
  }, [devices, error, loaded, loading, onChange, value]);

  const selectedDevice = devices.find((device) => device.id === value);
  const selectedValue = selectedDevice ? value : "";
  const currentName = selectedDevice?.label ?? SYSTEM_DEFAULT_LABEL;

  return (
    <fieldset className="microphone-selector" disabled={disabled}>
      <legend>{heading}</legend>
      <p className="microphone-selector__current">
        <strong>Micrófono actual:</strong> {currentName}
      </p>
      {loading && (
        <p className="microphone-selector__note" role="status">
          Buscando micrófonos…
        </p>
      )}
      {!loading && error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && devices.length <= 1 && (
        <p className="microphone-selector__note">
          El predeterminado del sistema está disponible como opción de captura.
        </p>
      )}
      <div className="microphone-selector__row">
        <label className="microphone-selector__label" htmlFor="microphone-selector-input">
          Dispositivo de captura
        </label>
        <button
          aria-label="Actualizar lista de micrófonos"
          className="microphone-selector__refresh"
          disabled={loading}
          onClick={loadDevices}
          type="button"
        >
          Actualizar
        </button>
      </div>
      <select
        aria-label="Dispositivo de captura"
        className="microphone-selector__field"
        id="microphone-selector-input"
        onChange={(event) => onChange(event.target.value)}
        value={selectedValue}
      >
        <option value="">{SYSTEM_DEFAULT_LABEL}</option>
        {devices.map((device) => (
          <option key={device.id} value={device.id}>
            {device.label}
            {device.isBuiltIn ? " (Integrado)" : ""}
          </option>
        ))}
      </select>
    </fieldset>
  );
}
