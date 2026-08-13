import type { RecordingState } from "../domain/recording";

export interface DictationControlProps {
  state: RecordingState;
  pending: boolean;
  disabled: boolean;
  onClick: () => void | Promise<void>;
}

const CONTROL_LABELS: Record<RecordingState["status"], string> = {
  ready: "Comenzar dictado",
  recording: "Terminar dictado",
  transcribing: "Transcribiendo…",
  copied: "Nuevo dictado",
  error: "Reintentar dictado",
};

export function DictationControl({ state, pending, disabled, onClick }: DictationControlProps) {
  const label = CONTROL_LABELS[state.status];
  const recording = state.status === "recording";
  const icon = recording ? <StopIcon /> : <MicrophoneIcon />;

  return (
    <button
      aria-busy={pending}
      aria-label={label}
      className={`primary-button dictation-action dictation-control${recording ? " dictation-control--recording" : ""}`}
      data-status={state.status}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span aria-hidden="true" className="dictation-control__icon" data-icon={recording ? "stop" : "microphone"}>
        {icon}
      </span>
      {recording && <RecordingPulse />}
      {recording && <span aria-hidden="true" className="dictation-control__rec">REC</span>}
      <span aria-hidden="true" className="dictation-control__label">{label}</span>
      {recording && <Waveform />}
    </button>
  );
}

function MicrophoneIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="32" stroke="currentColor" strokeLinecap="square" strokeWidth="2" viewBox="0 0 24 24" width="32" xmlns="http://www.w3.org/2000/svg">
      <rect height="11" rx="3" stroke="currentColor" strokeLinecap="square" strokeWidth="2" width="6" x="9" y="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" stroke="currentColor" strokeLinecap="square" strokeWidth="2" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="32" stroke="currentColor" strokeLinecap="square" strokeWidth="2" viewBox="0 0 24 24" width="32" xmlns="http://www.w3.org/2000/svg">
      <rect height="10" stroke="currentColor" strokeLinecap="square" strokeWidth="2" width="10" x="7" y="7" />
    </svg>
  );
}

function RecordingPulse() {
  return (
    <svg
      aria-hidden="true"
      className="dictation-control__pulse"
      fill="none"
      height="128"
      stroke="currentColor"
      strokeLinecap="square"
      strokeWidth="2"
      viewBox="0 0 128 128"
      width="128"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="64" cy="64" opacity="0" r="54" stroke="#00ff9c" strokeLinecap="square" strokeWidth="2" />
    </svg>
  );
}

function Waveform() {
  return (
    <span aria-hidden="true" className="dictation-control__waveform" data-testid="dictation-waveform">
      <svg fill="none" height="18" stroke="currentColor" strokeLinecap="square" strokeWidth="2" viewBox="0 0 96 18" width="96" xmlns="http://www.w3.org/2000/svg">
        <path d="M1 9h8l3-5 4 10 4-8 4 6 4-3 4 1 4-5 4 8 4-4 4 2 4-5 4 7 4-4 4 2 4-2 4 1 4-3 4 5 4-3 4 3h8" stroke="currentColor" strokeLinecap="square" strokeWidth="2" />
      </svg>
    </span>
  );
}
