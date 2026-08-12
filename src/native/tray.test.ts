import { getTrayMenuItems } from "./tray";

describe("tray menu", () => {
  it("exposes the Spanish quick actions used by the desktop shell", () => {
    expect(getTrayMenuItems()).toEqual([
      { id: "show", label: "Mostrar Chamu" },
      { id: "settings", label: "Configuración" },
      { id: "quit", label: "Salir" },
    ]);
  });
});
