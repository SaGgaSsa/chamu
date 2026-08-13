export type TrayMenuItemId = "open" | "close";

export interface TrayMenuItem {
  id: TrayMenuItemId;
  label: string;
}

export function getTrayMenuItems(): TrayMenuItem[] {
  return [
    { id: "open", label: "Abrir Chamu" },
    { id: "close", label: "Cerrar Chamu" },
  ];
}
