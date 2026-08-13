# Registro host de Chamu para Wayland Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identificar Chamu como aplicación host para que el portal XDG registre atajos globales en Wayland.

**Architecture:** Un archivo de escritorio usa el identificador `com.chamu.desktop`. El backend crea una conexión D-Bus, registra esa aplicación y construye GlobalShortcuts sobre la misma conexión antes de crear la sesión. El script de desarrollo copia la entrada al directorio de aplicaciones XDG del usuario sin modificar otras entradas.

**Tech Stack:** Rust, ashpd 0.13, Tauri 2, Node.js, Vitest.

## Global Constraints

- El ID de aplicación es `com.chamu.desktop`.
- El archivo de escritorio se llama `com.chamu.desktop.desktop`.
- Registrar el host antes de crear la sesión y antes de cualquier otra llamada a GlobalShortcuts.
- Usar la misma conexión D-Bus para registro host y GlobalShortcuts.
- El flujo local debe funcionar con `npm run tauri -- dev`.
- No instalar paquetes del sistema ni modificar archivos fuera de la entrada local de Chamu.
- Conservar los backends de atajo existentes para Windows, macOS y X11.

---

### Task 1: Entrada de escritorio y preparación local

**Files:**
- Create: `src-tauri/resources/com.chamu.desktop.desktop`
- Create: `scripts/install-dev-desktop-entry.mjs`
- Modify: `package.json`
- Test: `scripts/install-dev-desktop-entry.test.mjs`

**Interfaces:**
- Produces: `installDesktopEntry({ sourcePath, applicationsDir }) -> Promise<string>`.
- Produces: `npm run prepare:desktop-entry`, ejecutado antes de `tauri dev`.
- Consumes: `XDG_DATA_HOME`, o `$HOME/.local/share` cuando no existe.

- [ ] **Step 1: Write the failing Node test**

```js
it('copies only the Chamu desktop entry to the XDG applications directory', async () => {
  const target = await installDesktopEntry({
    sourcePath: fixtureEntryPath,
    applicationsDir: join(tempDir, 'applications'),
  });

  expect(target).toBe(join(tempDir, 'applications', 'com.chamu.desktop.desktop'));
  expect(await readFile(target, 'utf8')).toContain('Name=Chamu');
  await expect(stat(join(tempDir, 'applications', 'other.desktop'))).rejects.toThrow();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/install-dev-desktop-entry.test.mjs`

Expected: FAIL because the script and export do not exist.

- [ ] **Step 3: Add the desktop entry and installer**

```ini
[Desktop Entry]
Type=Application
Name=Chamu
Comment=Dictado local
Exec=chamu
Terminal=false
Categories=Utility;
StartupNotify=true
```

```js
export async function installDesktopEntry({ sourcePath, applicationsDir }) {
  await mkdir(applicationsDir, { recursive: true });
  const target = join(applicationsDir, 'com.chamu.desktop.desktop');
  await copyFile(sourcePath, target);
  return target;
}
```

Set `beforeDevCommand` to run `npm run prepare:desktop-entry && npm run dev -- --host 127.0.0.1`.

- [ ] **Step 4: Run the Node test to verify it passes**

Run: `node --test scripts/install-dev-desktop-entry.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the task**

```bash
git add package.json scripts/install-dev-desktop-entry.mjs scripts/install-dev-desktop-entry.test.mjs src-tauri/resources/com.chamu.desktop.desktop src-tauri/tauri.conf.json
git commit -m "feat: add desktop entry for Wayland portal"
```

### Task 2: Registro host antes de GlobalShortcuts

**Files:**
- Modify: `src-tauri/src/wayland_shortcut.rs`
- Test: `src-tauri/src/wayland_shortcut.rs`

**Interfaces:**
- Produces: `register_host_for_global_shortcuts() -> Result<GlobalShortcuts, String>`.
- Uses: `ashpd::register_host_app_with_connection`, `ashpd::AppID`, `ashpd::zbus::Connection`, y `GlobalShortcuts::with_connection`.
- Consumes: la constante `CHAMU_APP_ID: &str = "com.chamu.desktop"`.

- [ ] **Step 1: Write the failing Rust test**

```rust
#[test]
fn formats_host_registration_error_with_application_id() {
    let message = host_registration_error("portal rejected");
    assert_eq!(
        message,
        "No se pudo registrar Chamu ante el portal Wayland (com.chamu.desktop): portal rejected"
    );
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -q wayland_shortcut::tests::formats_host_registration_error_with_application_id`

Expected: FAIL because `host_registration_error` does not exist.

- [ ] **Step 3: Implement host registration on the portal connection**

```rust
const CHAMU_APP_ID: &str = "com.chamu.desktop";

async fn register_host_for_global_shortcuts() -> Result<GlobalShortcuts, String> {
    let connection = ashpd::zbus::Connection::session()
        .await
        .map_err(|error| format!("No se pudo conectar al bus de sesión Wayland: {error}"))?;
    let app_id = AppID::new(CHAMU_APP_ID)
        .map_err(|error| format!("El identificador de Chamu es inválido: {error}"))?;
    register_host_app_with_connection(connection.clone(), app_id)
        .await
        .map_err(|error| host_registration_error(&error.to_string()))?;
    GlobalShortcuts::with_connection(connection)
        .await
        .map_err(|error| format!("No se encontró el portal de atajos globales: {error}"))
}
```

Call it in `run_portal_session_inner` in place of `GlobalShortcuts::new()`. Keep cancellation behavior and current error event handling.

- [ ] **Step 4: Run the Rust test to verify it passes**

Run: `cargo test -q wayland_shortcut::tests::formats_host_registration_error_with_application_id`

Expected: PASS.

- [ ] **Step 5: Commit the task**

```bash
git add src-tauri/src/wayland_shortcut.rs
git commit -m "fix: register Chamu with Wayland portal"
```

### Task 3: Validación integrada

**Files:**
- Modify: `docs/superpowers/specs/2026-08-13-wayland-host-registration-design.md`
- Modify: `docs/superpowers/plans/2026-08-13-wayland-host-registration.md`

- [x] **Step 1: Run frontend validation**

Run: `npm test && npm run typecheck && npm run build`

Result: PASS. Vitest informó 12 archivos y 96 pruebas sin fallos. `typecheck`
y `build` terminaron con salida 0.

- [x] **Step 2: Run Rust validation**

Run: `cargo test -q`

Result: PASS. 54 pruebas sin fallos. La salida conserva warnings `dead_code`.

- [x] **Step 3: Run development preparation**

Run: `npm run prepare:desktop-entry && gdbus call --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop --method org.freedesktop.host.portal.Registry.Register com.chamu.desktop "{}"`

Result: PASS. La entrada se copió a
`~/.local/share/applications/com.chamu.desktop.desktop`. `Registry.Register`
devolvió `()` sin `App info not found`.

Limitación: la llamada `gdbus` usa una conexión D-Bus independiente. Prueba
que el portal acepta el ID con la entrada instalada, pero no prueba que la
conexión del proceso Tauri sea la misma que usa `GlobalShortcuts`.

- [ ] **Step 4: Manual Wayland validation**

Run: `npm run tauri -- dev`

Resultado parcial: el frontend quedó listo, el binario se compiló y se ejecutó,
y `xwininfo` mostró `Chamu · Dictado local`. El límite de 90 segundos terminó
la ejecución. No hay evidencia de aceptar el diálogo, seleccionar mantener
pulsado, pulsar y liberar el atajo, ni recibir transcripción. La casilla queda
sin marcar.

- [x] **Step 5: Update documentation and commit**

```bash
git add docs/superpowers/specs/2026-08-13-wayland-host-registration-design.md docs/superpowers/plans/2026-08-13-wayland-host-registration.md
git commit -m "docs: document Wayland host registration"
```
