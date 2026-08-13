import { getTrayMenuItems } from "./tray";

describe("tray menu", () => {
  it("exposes the Spanish quick actions used by the desktop shell", () => {
    expect(getTrayMenuItems()).toEqual([
      { id: "open", label: "Abrir Chamu" },
      { id: "close", label: "Cerrar Chamu" },
    ]);
  });
});
