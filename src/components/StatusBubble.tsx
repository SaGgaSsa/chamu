import type { RecordingState } from "../domain/recording";
import {
  getRecordingStateLabel,
  isBusyRecordingState,
} from "../domain/recording";

interface StatusBubbleProps {
  state: RecordingState;
}

function getStatusHint(state: RecordingState): string {
  switch (state.status) {
    case "ready":
      return "Pulsa el atajo para comenzar";
    case "recording":
      return "Suelta el atajo para terminar";
    case "transcribing":
      return "Procesando de forma local…";
    case "copied":
      return "Texto copiado al portapapeles";
    case "error":
      return state.message;
  }
}

export function StatusBubble({ state }: StatusBubbleProps) {
  const busy = isBusyRecordingState(state);

  return (
    <section
      aria-label="Estado de grabación"
      aria-live="polite"
      className={`status-bubble status-bubble--${state.status}`}
      data-busy={busy}
      data-status={state.status}
      role="status"
    >
      <span aria-hidden="true" className="status-bubble__dot" />
      <span className="status-bubble__copy">
        <strong>{getRecordingStateLabel(state)}</strong>
        <span>{getStatusHint(state)}</span>
      </span>
    </section>
  );
}
