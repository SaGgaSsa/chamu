import { useEffect, useRef, useState } from "react";
import type {
  ChamuBridge,
  ModelDownloadProgress,
  ModelMetadata,
  ModelStatus,
} from "../native/commands";

export interface ModelProfile {
  id: string;
  label: string;
  displaySizeMiB: number;
}

/** The model list is intentionally closed and follows the native catalog order. */
export const MODEL_PROFILES: readonly ModelProfile[] = [
  { id: "tiny-q8_0", label: "Rápido", displaySizeMiB: 42 },
  { id: "base", label: "Liviano", displaySizeMiB: 142 },
  { id: "small-q8_0", label: "Balanceado", displaySizeMiB: 252 },
  { id: "small", label: "Predeterminado", displaySizeMiB: 466 },
  { id: "large-v3-turbo-q5_0", label: "Calidad", displaySizeMiB: 547 },
  { id: "large-v3-turbo-q8_0", label: "Máximo", displaySizeMiB: 834 },
];

export const DEFAULT_MODEL_ID = "small";

export interface ModelSelectorProps {
  bridge: ChamuBridge;
  selectedModelId: string;
  onModelActivated: (modelId: string) => void;
  disabled?: boolean;
}

interface DownloadListener {
  token: symbol;
  unlisten?: () => void;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function profileFor(id: string): ModelProfile {
  return (
    MODEL_PROFILES.find((profile) => profile.id === id)
    ?? MODEL_PROFILES.find((profile) => profile.id === DEFAULT_MODEL_ID)
    ?? MODEL_PROFILES[0]
  );
}

function metadataFor(profile: ModelProfile, catalog: readonly ModelMetadata[]): ModelMetadata | undefined {
  return catalog.find((metadata) => metadata.id === profile.id);
}

function missingProfileLabels(catalog: readonly ModelMetadata[]): string[] {
  return MODEL_PROFILES
    .filter((profile) => metadataFor(profile, catalog) === undefined)
    .map((profile) => profile.label);
}

function statusIsReady(status: ModelStatus | undefined): boolean {
  return Boolean(status?.installed && status.checksumValid);
}

function statusLabel(
  profile: ModelProfile,
  status: ModelStatus | undefined,
  statusError: string | undefined,
  downloadId: string | null,
  progress: ModelDownloadProgress | null,
  inspectingId: string | null,
): string {
  if (downloadId === profile.id) {
    const percent = progress?.percent === undefined ? "" : ` · ${progress.percent}%`;
    return `Descarga en curso${percent}`;
  }
  if (statusError) return `Error: ${statusError}`;
  if (!status) {
    return profile.id === inspectingId ? "Comprobando estado…" : "";
  }
  if (status.error) {
    return status.installed && !status.checksumValid
      ? `Checksum inválido · Error: ${status.error}`
      : `Error: ${status.error}`;
  }
  if (status.installed && !status.checksumValid) return "Checksum inválido";
  if (status.installed && status.checksumValid) {
    return status.active ? "Activo" : "Instalado";
  }
  if (status.installed) return "Checksum inválido";
  return "Descargable";
}

export function ModelSelector({
  bridge,
  selectedModelId,
  onModelActivated,
  disabled = false,
}: ModelSelectorProps) {
  const [catalog, setCatalog] = useState<ModelMetadata[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ModelStatus>>({});
  const [statusErrors, setStatusErrors] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState(selectedModelId);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogValidationError, setCatalogValidationError] = useState<string | null>(null);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<ModelDownloadProgress | null>(null);
  const [downloadConsentId, setDownloadConsentId] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const downloadListenerRef = useRef<DownloadListener | null>(null);
  const downloadTokenRef = useRef<symbol | null>(null);
  const confirmedIdRef = useRef(selectedModelId);
  const disposedRef = useRef(false);
  const bridgeRef = useRef(bridge);
  const bridgeGenerationRef = useRef(0);
  const selectedModelIdRef = useRef(selectedModelId);

  useEffect(() => {
    setSelectedId(selectedModelId);
    confirmedIdRef.current = selectedModelId;
    selectedModelIdRef.current = selectedModelId;
  }, [selectedModelId]);

  function releaseDownloadListener(token?: symbol) {
    const listener = downloadListenerRef.current;
    if (!listener || (token && listener.token !== token)) return;
    downloadListenerRef.current = null;
    downloadTokenRef.current = null;
    try {
      listener.unlisten?.();
    } catch {
      // The listener is already outside the component lifecycle.
    }
  }

  function isCurrentBridge(expectedBridge: ChamuBridge, generation: number): boolean {
    return !disposedRef.current
      && bridgeRef.current === expectedBridge
      && bridgeGenerationRef.current === generation;
  }

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      releaseDownloadListener();
    };
  }, []);

  async function inspectProfile(
    id: string,
    expectedBridge = bridgeRef.current,
    generation = bridgeGenerationRef.current,
  ): Promise<ModelStatus | null> {
    try {
      const status = await expectedBridge.inspectModel(id);
      if (!isCurrentBridge(expectedBridge, generation)) return null;
      setStatuses((current) => ({ ...current, [id]: status }));
      setStatusErrors((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
      return status;
    } catch (error: unknown) {
      if (!isCurrentBridge(expectedBridge, generation)) return null;
      setStatusErrors((current) => ({
        ...current,
        [id]: getErrorMessage(error, "No se pudo comprobar el modelo"),
      }));
      return null;
    }
  }

  useEffect(() => {
    const expectedBridge = bridge;
    const generation = bridgeGenerationRef.current + 1;
    bridgeGenerationRef.current = generation;
    bridgeRef.current = expectedBridge;
    let cancelled = false;

    setCatalog([]);
    setCatalogLoaded(false);
    setCatalogError(null);
    setCatalogValidationError(null);
    setStatuses({});
    setStatusErrors({});
    setDownloadId(null);
    setDownloadProgress(null);
    setDownloadConsentId(null);
    setActivatingId(null);
    setInspectingId(null);
    setOperationError(null);

    function isCurrent(): boolean {
      return !cancelled && isCurrentBridge(expectedBridge, generation);
    }

    async function inspectForGeneration(id: string): Promise<void> {
      try {
        const status = await expectedBridge.inspectModel(id);
        if (!isCurrent()) return;
        setStatuses((current) => ({ ...current, [id]: status }));
        setStatusErrors((current) => {
          if (!(id in current)) return current;
          const next = { ...current };
          delete next[id];
          return next;
        });
      } catch (error: unknown) {
        if (!isCurrent()) return;
        setStatusErrors((current) => ({
          ...current,
          [id]: getErrorMessage(error, "No se pudo comprobar el modelo"),
        }));
      }
    }

    void expectedBridge.getModelCatalog().then(async (loadedCatalog) => {
      if (!isCurrent()) return;
      setCatalog(loadedCatalog);
      setCatalogLoaded(true);
      const missing = missingProfileLabels(loadedCatalog);
      setCatalogValidationError(
        missing.length > 0
          ? `El catálogo de modelos está incompleto. Falta: ${missing.join(", ")}.`
          : null,
      );
      await inspectForGeneration(selectedModelIdRef.current);
    }).catch((error: unknown) => {
      if (!isCurrent()) return;
      setCatalogLoaded(true);
      setCatalogError(getErrorMessage(error, "No se pudo cargar el catálogo de modelos"));
    });

    return () => {
      cancelled = true;
      releaseDownloadListener();
      if (bridgeGenerationRef.current === generation) bridgeGenerationRef.current += 1;
    };
  }, [bridge]);

  async function refreshProfile(
    id: string,
    expectedBridge = bridgeRef.current,
    generation = bridgeGenerationRef.current,
  ) {
    await inspectProfile(id, expectedBridge, generation);
  }

  async function handleDownloadProgress(
    progress: ModelDownloadProgress,
    token: symbol,
    id: string,
    expectedBridge: ChamuBridge,
    generation: number,
  ) {
    if (!isCurrentBridge(expectedBridge, generation)) return;
    if (downloadListenerRef.current?.token !== token || progress.modelId !== id) return;
    setDownloadProgress(progress);
    if (progress.phase === "failed" || progress.phase === "cancelled") {
      releaseDownloadListener(token);
      setDownloadId(null);
      setDownloadConsentId(null);
      setStatusErrors((current) => ({ ...current, [progress.modelId]: progress.message }));
      return;
    }
    if (progress.phase === "completed") {
      releaseDownloadListener(token);
      setDownloadId(null);
      setDownloadConsentId(null);
      await refreshProfile(progress.modelId, expectedBridge, generation);
      await activate(progress.modelId, expectedBridge, generation);
    }
  }

  async function confirmDownload() {
    const id = downloadConsentId;
    if (!id || disabled || downloadId !== null || activatingId !== null) return;

    const expectedBridge = bridgeRef.current;
    const generation = bridgeGenerationRef.current;

    setOperationError(null);
    setStatusErrors((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setDownloadProgress(null);
    releaseDownloadListener();
    const token = Symbol("model-download-progress");
    downloadTokenRef.current = token;
    downloadListenerRef.current = { token };
    setDownloadId(id);

    try {
      const unlisten = await expectedBridge.onModelDownloadProgress((progress) => {
        void handleDownloadProgress(progress, token, id, expectedBridge, generation);
      });
      if (!isCurrentBridge(expectedBridge, generation) || downloadListenerRef.current?.token !== token) {
        unlisten();
        return;
      }
      downloadListenerRef.current.unlisten = unlisten;
      await expectedBridge.startModelDownload(id);
    } catch (error: unknown) {
      if (!isCurrentBridge(expectedBridge, generation) || downloadListenerRef.current?.token !== token) return;
      releaseDownloadListener(token);
      setDownloadId(null);
      setDownloadConsentId(null);
      setStatusErrors((current) => ({
        ...current,
        [id]: getErrorMessage(error, "No se pudo iniciar la descarga"),
      }));
    }
  }

  async function cancelDownload() {
    if (!downloadId) return;
    const expectedBridge = bridgeRef.current;
    const generation = bridgeGenerationRef.current;
    const id = downloadId;
    try {
      await expectedBridge.cancelModelDownload(id);
    } catch (error: unknown) {
      if (!isCurrentBridge(expectedBridge, generation) || downloadId !== id) return;
      setStatusErrors((current) => ({
        ...current,
        [id]: getErrorMessage(error, "No se pudo cancelar la descarga"),
      }));
    }
  }

  async function activate(
    id: string,
    expectedBridge = bridgeRef.current,
    generation = bridgeGenerationRef.current,
  ) {
    if (disabled || activatingId !== null) return;
    const previousId = confirmedIdRef.current;
    setActivatingId(id);
    setOperationError(null);
    setStatusErrors((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    try {
      await expectedBridge.activateModel(id);
      if (!isCurrentBridge(expectedBridge, generation)) return;
      setStatuses((current) => Object.fromEntries(
        Object.entries(current).map(([statusId, status]) => [
          statusId,
          { ...status, active: statusId === id },
        ]),
      ));
      confirmedIdRef.current = id;
      setSelectedId(id);
      onModelActivated(id);
    } catch (error: unknown) {
      if (!isCurrentBridge(expectedBridge, generation)) return;
      setSelectedId(previousId);
      setStatusErrors((current) => ({
        ...current,
        [id]: getErrorMessage(error, "No se pudo activar el modelo"),
      }));
      setOperationError(getErrorMessage(error, "No se pudo activar el modelo"));
    } finally {
      if (isCurrentBridge(expectedBridge, generation)) setActivatingId(null);
    }
  }

  async function handleSelection(id: string) {
    if (disabled || downloadId !== null || activatingId !== null) return;
    setSelectedId(id);
    setOperationError(null);
    setDownloadConsentId(null);
    setStatusErrors((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    const known = statuses[id];
    if (known) {
      if (statusIsReady(known) && !known.active) await activate(id);
      return;
    }
    setInspectingId(id);
    try {
      const status = await inspectProfile(id);
      if (status && statusIsReady(status) && !status.active) await activate(id);
    } finally {
      setInspectingId((current) => (current === id ? null : current));
    }
  }

  const selectedProfile = profileFor(selectedId);
  const selectedStatus = statuses[selectedId];
  const selectorBusy = disabled || downloadId !== null || activatingId !== null;
  const selectedReady = statusIsReady(selectedStatus);

  return (
    <section className="model-selector" aria-label="Selector de modelo">
      {catalogError && <p className="error-message" role="alert">{catalogError}</p>}
      {catalogValidationError && <p className="error-message" role="alert">{catalogValidationError}</p>}
      {!catalogLoaded && <p className="model-selector__loading" role="status">Cargando catálogo de modelos…</p>}
      <fieldset className="choice-list model-selector__choices" disabled={selectorBusy}>
        <legend>Modelo de dictado</legend>
        {MODEL_PROFILES.map((profile) => {
            const status = statuses[profile.id];
            return (
              <label className="choice-card model-selector__choice" key={profile.id}>
                <input
                  checked={selectedId === profile.id}
                  name="model-profile"
                  onChange={() => void handleSelection(profile.id)}
                  type="radio"
                  value={profile.id}
                />
                <span>
                  <strong>{profile.label} · {profile.displaySizeMiB} MiB</strong>
                  <small data-model-status={profile.id}>
                    {statusLabel(profile, status, statusErrors[profile.id], downloadId, downloadProgress, inspectingId)}
                  </small>
                </span>
              </label>
            );
          })}
      </fieldset>
      {disabled && <p className="model-selector__message" role="status">Selector bloqueado mientras Chamu procesa el dictado.</p>}
      {downloadId && (
        <div className="download-panel model-selector__download" role="status">
          <span>
            {downloadProgress?.message ?? "Conectando con el servidor…"}
            {downloadProgress?.percent === undefined ? "" : ` · ${downloadProgress.percent}%`}
          </span>
          <button className="secondary-button" disabled={disabled} onClick={() => void cancelDownload()} type="button">Cancelar descarga</button>
        </div>
      )}
      {!selectorBusy && selectedStatus && !selectedReady && !downloadConsentId && (
        <button className="primary-button model-selector__download-button" onClick={() => setDownloadConsentId(selectedId)} type="button">
          Descargar modelo {selectedProfile.label} ({selectedProfile.displaySizeMiB} MiB)
        </button>
      )}
      {downloadConsentId && !downloadId && (
        <div className="consent-panel model-selector__consent" role="dialog" aria-label="Confirmar descarga del modelo">
          <p><strong>¿Confirmas descargar {profileFor(downloadConsentId).label}?</strong></p>
          <p>Perfil elegido: {profileFor(downloadConsentId).label}. Tamaño: {profileFor(downloadConsentId).displaySizeMiB} MiB.</p>
          <div className="button-row">
            <button className="secondary-button" onClick={() => setDownloadConsentId(null)} type="button">Ahora no</button>
            <button className="primary-button" onClick={() => void confirmDownload()} type="button">Confirmar descarga</button>
          </div>
        </div>
      )}
      {operationError && <p className="error-message" role="alert">{operationError}</p>}
      {activatingId && (
        <div className="model-loading-overlay" role="status" aria-live="polite">
          <span aria-hidden="true" className="model-loading-overlay__spinner" />
          <p>Cargando modelo {profileFor(activatingId).label}…</p>
        </div>
      )}
    </section>
  );
}
