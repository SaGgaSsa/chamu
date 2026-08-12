import {
  createRecordingState,
  getRecordingStateLabel,
  isBusyRecordingState,
  type RecordingState,
} from "./recording";

describe("recording state", () => {
  it("starts ready without an error message", () => {
    expect(createRecordingState()).toEqual({ status: "ready" });
  });

  it.each([
    ["ready", false],
    ["recording", true],
    ["transcribing", true],
    ["copied", false],
    ["error", false],
  ] as const)("marks %s as busy=%s", (status, busy) => {
    expect(isBusyRecordingState({ status })).toBe(busy);
  });

  it("keeps an error detail available while providing a Spanish label", () => {
    const state: RecordingState = {
      status: "error",
      message: "No se pudo acceder al micrófono",
    };

    expect(getRecordingStateLabel(state)).toBe("Error");
    expect(state.message).toContain("micrófono");
  });
});
