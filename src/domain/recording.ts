export type RecordingStatus =
  | "ready"
  | "recording"
  | "transcribing"
  | "copied"
  | "error";

export type RecordingState =
  | { status: "ready" }
  | { status: "recording" }
  | { status: "transcribing" }
  | { status: "copied" }
  | { status: "error"; message: string };

const RECORDING_LABELS: Record<RecordingStatus, string> = {
  ready: "Listo",
  recording: "Grabando",
  transcribing: "Transcribiendo",
  copied: "Copiado",
  error: "Error",
};

export function createRecordingState(): RecordingState {
  return { status: "ready" };
}

export function getRecordingStateLabel(state: RecordingState): string {
  return RECORDING_LABELS[state.status];
}

export function isBusyRecordingState(state: { status: RecordingStatus }): boolean {
  return state.status === "recording" || state.status === "transcribing";
}
