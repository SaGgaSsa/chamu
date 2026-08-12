export type TrayMenuItemId = "show" | "settings" | "quit";

export interface TrayMenuItem {
  id: TrayMenuItemId;
  label: string;
}

export function getTrayMenuItems(): TrayMenuItem[] {
  return [
    { id: "show", label: "Mostrar Chamu" },
    { id: "settings", label: "Configuración" },
    { id: "quit", label: "Salir" },
  ];
}
