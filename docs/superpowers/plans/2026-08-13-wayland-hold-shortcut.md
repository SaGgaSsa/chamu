# Atajo mantener pulsado en Wayland Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir dictado de mantener pulsado con atajos globales del portal XDG en Wayland.

**Architecture:** Un módulo Rust usa `ashpd` y `org.freedesktop.portal.GlobalShortcuts`. Conserva una sesión mientras el atajo está activo y emite eventos Tauri al frontend. `AppShell` elige ese backend solo en Wayland con modo `hold`; el registro actual continúa en los demás casos.

**Tech Stack:** Rust, Tauri 2, ashpd 0.13 con `global_shortcuts`, React, TypeScript, Vitest.

## Global Constraints

- Usar `org.freedesktop.portal.GlobalShortcuts` en Wayland.
- Usar `Activated` y `Deactivated` como presionar y soltar.
- No leer `/dev/input`.
- No pedir permisos de bajo nivel.
- Mantener `tauri-plugin-global-shortcut` para Windows, macOS y X11.
- No persistir audio ni texto nuevo fuera de la historia SQLite existente.
- El estado visible no puede indicar registro antes de confirmación del portal.

---

### Task 1: Backend del portal Wayland

**Files:**
- Create: `src-tauri/src/wayland_shortcut.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/wayland_shortcut.rs`

**Interfaces:**
- Produces: `PortalShortcutEvent { status: String, message: Option<String> }`.
- Produces: `configure_wayland_hold_shortcut(shortcut: String, app: AppHandle, state: State<RuntimeState>) -> Result<(), String>`.
- Produces: `clear_wayland_hold_shortcut(state: State<RuntimeState>) -> Result<(), String>`.

- [x] **Step 1: Write the failing Rust tests**

```rust
#[test]
fn converts_chamu_shortcut_to_xdg_trigger() {
    assert_eq!(to_xdg_trigger("CommandOrControl+Shift+Space"), "CTRL+SHIFT+space");
}

#[test]
fn maps_portal_state_to_frontend_status() {
    assert_eq!(PortalEventKind::Activated.status(), "pressed");
    assert_eq!(PortalEventKind::Deactivated.status(), "released");
}
```

- [x] **Step 2: Run the Rust tests to verify failure**

Run: `cargo test -q wayland_shortcut` from `src-tauri/`.

Expected: FAIL because the module and functions do not exist.

- [x] **Step 3: Implement the portal module**

```rust
pub fn to_xdg_trigger(shortcut: &str) -> String { /* map Ctrl, Alt, Shift, Meta and main key */ }

pub async fn run_portal_session(...) -> Result<(), String> {
    // Create session, bind one `NewShortcut`, await response, emit registered.
    // Forward `receive_activated` as pressed and `receive_deactivated` as released.
}
```

Use `ashpd = { version = "0.13", default-features = false, features = ["tokio", "global_shortcuts"] }`. Keep the session task handle in `RuntimeState`. Abort and replace it before starting another session.

- [x] **Step 4: Register the Tauri commands and event payload**

```rust
#[tauri::command]
fn configure_wayland_hold_shortcut(...) -> Result<(), String> { ... }

#[tauri::command]
fn clear_wayland_hold_shortcut(...) -> Result<(), String> { ... }
```

Register both commands in `tauri::generate_handler![]`. Emit `wayland-hold-shortcut` with `registered`, `pressed`, `released`, or `error`.

- [x] **Step 5: Run the targeted Rust tests**

Run: `cargo test -q wayland_shortcut` from `src-tauri/`.

Expected: PASS.

- [x] **Step 6: Commit the backend task**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/wayland_shortcut.rs
git commit -m "feat: add Wayland hold shortcut portal"
```

### Task 2: Bridge y ciclo de vida del frontend

**Files:**
- Modify: `src/native/commands.ts`
- Modify: `src/components/AppShell.tsx`
- Modify: `src/components/AppShell.test.tsx`

**Interfaces:**
- Consumes: evento Tauri `wayland-hold-shortcut` con `status: "registered" | "pressed" | "released" | "error"`.
- Consumes: comandos `configureWaylandHoldShortcut(shortcut)` y `clearWaylandHoldShortcut()`.
- Produces: estado visible del portal y dictado controlado por presión/liberación.

- [x] **Step 1: Write the failing frontend test**

```tsx
it("starts on Wayland portal press and stops on release", async () => {
  render(<AppShell bridge={waylandBridge} />);
  await emitWaylandShortcut({ status: "pressed" });
  expect(waylandBridge.startDictation).toHaveBeenCalledOnce();
  await emitWaylandShortcut({ status: "released" });
  expect(waylandBridge.stopDictation).toHaveBeenCalledOnce();
});
```

Add a test that confirms the Tauri global-shortcut plugin is not registered in this case.

- [x] **Step 2: Run the frontend test to verify failure**

Run: `npm test -- AppShell`.

Expected: FAIL because the bridge does not expose portal events and `AppShell` does not subscribe to them.

- [x] **Step 3: Add bridge types and commands**

```ts
export interface PlatformDiagnosis { session: "windows" | "x11" | "wayland" | "unknown"; }
export interface WaylandHoldShortcutEvent { status: "registered" | "pressed" | "released" | "error"; message?: string; }
```

Expose `diagnosePlatform`, `configureWaylandHoldShortcut`, `clearWaylandHoldShortcut`, and `onWaylandHoldShortcut` in `ChamuBridge`. Use Tauri `listen` for the event and return its unlisten callback.

- [x] **Step 4: Select the backend in AppShell**

```tsx
const useWaylandHoldPortal = diagnosis?.session === "wayland" && currentSettings.mode === "hold";
```

When true, configure the portal and subscribe to its event. On `pressed`, call `handleDictation()`. On `released`, call `stopDictation()` after a start in progress has resolved. On cleanup, unlisten and clear the portal session. When false, retain the existing global-shortcut registration effect.

- [x] **Step 5: Show state in DictationTester**

Pass the status message to `DictationTester`. Render a status line such as `Atajo Wayland: registrado`, `Atajo Wayland: presionado`, `Atajo Wayland: soltado`, or the received error.

- [x] **Step 6: Run the frontend tests**

Run: `npm test -- AppShell DictationTester`.

Expected: PASS.

- [x] **Step 7: Commit the frontend task**

```bash
git add src/native/commands.ts src/components/AppShell.tsx src/components/AppShell.test.tsx src/components/DictationTester.tsx src/components/DictationTester.test.tsx
git commit -m "feat: use portal events for Wayland hold mode"
```

### Task 3: Validación integrada

**Files:**
- Modify: `docs/superpowers/specs/2026-08-13-wayland-hold-shortcut-design.md`
- Modify: `docs/superpowers/plans/2026-08-13-wayland-hold-shortcut.md`

- [x] **Step 1: Run validation de frontend**

Run: `npm test && npm run typecheck && npm run build`.

Expected: PASS.

- [x] **Step 2: Run validation Rust**

Run: `cargo test -q` from `src-tauri/`.

Expected: PASS.

- [ ] **Step 3: Manual local validation**

Run: `npm run tauri -- dev`.

Accept the portal dialog. Mantén pulsado el atajo. Habla. Suelta el atajo. Verify that the visible state changes from registered to pressed to released and that text appears in `Texto de prueba`.

- [x] **Step 4: Update the plan checks and commit**

```bash
git add docs/superpowers/specs/2026-08-13-wayland-hold-shortcut-design.md docs/superpowers/plans/2026-08-13-wayland-hold-shortcut.md
git commit -m "docs: document Wayland hold shortcut"
```
