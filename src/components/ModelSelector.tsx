import { useEffect, useMemo, useRef, useState } from "react";
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
  { id: "base", label: "Liviano", displaySizeMiB: 142 },
  { id: "small", label: "Predeterminado", displaySizeMiB: 466 },
  { id: "large-v3-turbo-q5_0", label: "Calidad", displaySizeMiB: 547 },
];

export interface ModelSelectorProps {
  bridge: ChamuBridge;
  selectedModelId: string;
  onModelActivated: (modelId: string) => void;
  disabled?: boolean;
  heading?: string;
}

interface DownloadListener {
  token: symbol;
  unlisten?: () => void;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function profileFor(id: string): ModelProfile {
  return MODEL_PROFILES.find((profile) => profile.id === id) ?? MODEL_PROFILES[1];
}

function metadataFor(profile: ModelProfile, catalog: readonly ModelMetadata[]): ModelMetadata | undefined {
  return catalog.find((metadata) => metadata.id === profile.id);
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
): string {
  if (downloadId === profile.id) {
    const percent = progress?.percent === undefined ? "" : ` · ${progress.percent}%`;
    return `Descarga en curso${percent}`;
  }
  if (statusError) return `Error: ${statusError}`;
  if (!status) return "Comprobando estado…";
  if (status.installed && !status.checksumValid) return "Checksum inválido";
  if (status.error) return `Error: ${status.error}`;
  if (status.installed && status.checksumValid) {
    return status.active ? "Activo · instalado y validado" : "Instalado y validado";
  }
  if (status.installed) return "Checksum inválido";
  return "Descargable";
}

export function ModelSelector({
  bridge,
  selectedModelId,
  onModelActivated,
  disabled = false,
  heading = "Modelo de dictado",
}: ModelSelectorProps) {
  const [catalog, setCatalog] = useState<ModelMetadata[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ModelStatus>>({});
  const [statusErrors, setStatusErrors] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState(selectedModelId);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<ModelDownloadProgress | null>(null);
  const [downloadConsentId, setDownloadConsentId] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const downloadListenerRef = useRef<DownloadListener | null>(null);
  const downloadTokenRef = useRef<symbol | null>(null);
  const confirmedIdRef = useRef(selectedModelId);
  const disposedRef = useRef(false);

  useEffect(() => {
    setSelectedId(selectedModelId);
    confirmedIdRef.current = selectedModelId;
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

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      releaseDownloadListener();
    };
  }, []);

  async function inspectProfile(id: string): Promise<void> {
    try {
      const status = await bridge.inspectModel(id);
      if (disposedRef.current) return;
      setStatuses((current) => ({ ...current, [id]: status }));
      setStatusErrors((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
    } catch (error: unknown) {
      if (disposedRef.current) return;
      setStatusErrors((current) => ({
        ...current,
        [id]: getErrorMessage(error, "No se pudo comprobar el modelo"),
      }));
    }
  }

  async function loadModels() {
    setCatalogError(null);
    try {
      const loadedCatalog = await bridge.getModelCatalog();
      if (disposedRef.current) return;
      const knownCatalog = MODEL_PROFILES
        .map((profile) => metadataFor(profile, loadedCatalog))
        .filter((metadata): metadata is ModelMetadata => metadata !== undefined);
      setCatalog(knownCatalog);
      await Promise.all(MODEL_PROFILES.map((profile) => inspectProfile(profile.id)));
    } catch (error: unknown) {
      if (disposedRef.current) return;
      setCatalogError(getErrorMessage(error, "No se pudo cargar el catálogo de modelos"));
    }
  }

  useEffect(() => {
    void loadModels();
  }, [bridge]);

  async function refreshProfile(id: string) {
    await inspectProfile(id);
  }

  async function handleDownloadProgress(progress: ModelDownloadProgress, token: symbol, id: string) {
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
      await refreshProfile(progress.modelId);
    }
  }

  async function confirmDownload() {
    const id = downloadConsentId;
    if (!id || disabled || downloadId !== null || activatingId !== null) return;

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
      const unlisten = await bridge.onModelDownloadProgress((progress) => {
        void handleDownloadProgress(progress, token, id);
      });
      if (disposedRef.current || downloadListenerRef.current?.token !== token) {
        unlisten();
        return;
      }
      downloadListenerRef.current.unlisten = unlisten;
      await bridge.startModelDownload(id);
    } catch (error: unknown) {
      if (downloadListenerRef.current?.token !== token) return;
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
    try {
      await bridge.cancelModelDownload(downloadId);
    } catch (error: unknown) {
      setStatusErrors((current) => ({
        ...current,
        [downloadId]: getErrorMessage(error, "No se pudo cancelar la descarga"),
      }));
    }
  }

  async function activate(id: string) {
    if (disabled || downloadId !== null || activatingId !== null) return;
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
      await bridge.activateModel(id);
      if (disposedRef.current) return;
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
      if (disposedRef.current) return;
      setSelectedId(previousId);
      setStatusErrors((current) => ({
        ...current,
        [id]: getErrorMessage(error, "No se pudo activar el modelo"),
      }));
      setOperationError(getErrorMessage(error, "No se pudo activar el modelo"));
    } finally {
      if (!disposedRef.current) setActivatingId(null);
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
    const status = statuses[id];
    if (statusIsReady(status) && !status.active) {
      await activate(id);
    }
  }

  const profiles = useMemo(
    () => MODEL_PROFILES.filter((profile) => metadataFor(profile, catalog) !== undefined),
    [catalog],
  );
  const selectedProfile = profileFor(selectedId);
  const selectedStatus = statuses[selectedId];
  const selectorBusy = disabled || downloadId !== null || activatingId !== null;
  const selectedReady = statusIsReady(selectedStatus);
  const selectedActive = Boolean(selectedStatus?.active);
  const canActivate = selectedReady && !selectedActive && !selectorBusy;

  return (
    <section className="model-selector" aria-label="Selector de modelo">
      <div className="model-selector__header">
        <div>
          <p className="eyebrow">MODELO LOCAL</p>
          <h2>{heading}</h2>
        </div>
        {selectedActive && <span className="model-selector__active">Activo</span>}
      </div>
      {catalogError && <p className="error-message" role="alert">{catalogError}</p>}
      {!catalogError && profiles.length === 0 && <p className="model-selector__loading" role="status">Cargando modelos…</p>}
      {profiles.length > 0 && (
        <fieldset className="choice-list model-selector__choices" disabled={selectorBusy}>
          <legend>Perfil de Whisper</legend>
          {profiles.map((profile) => {
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
                  <small>{profile.id}</small>
                  <small data-model-status={profile.id}>
                    {statusLabel(profile, status, statusErrors[profile.id], downloadId, downloadProgress)}
                  </small>
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
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
      {canActivate && (
        <button className="primary-button model-selector__activate-button" onClick={() => void activate(selectedId)} type="button">
          Activar {selectedProfile.label}
        </button>
      )}
      {activatingId && <p className="model-selector__message" role="status">Activando {profileFor(activatingId).label}…</p>}
      {operationError && <p className="error-message" role="alert">{operationError}</p>}
    </section>
  );
}
