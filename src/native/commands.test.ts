import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { copyHistory } from "./commands";

describe("native history bridge", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it("copies by stored history id without sending caller-provided text", async () => {
    await copyHistory("entry-42");

    expect(invoke).toHaveBeenCalledWith("copy_history_entry", { id: "entry-42" });
  });
});
