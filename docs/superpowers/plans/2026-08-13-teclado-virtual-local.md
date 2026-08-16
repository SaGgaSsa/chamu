# Teclado virtual local para Wayland Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pegar el dictado en la ventana activa de Wayland con `ydotoold`, sin solicitar permisos de escritorio remoto.

**Architecture:** `wayland_paste` deja de gestionar una sesión del portal y pasa a construir y ejecutar un único comando local `ydotool key`. `stop_dictation` conserva el orden transcripción, portapapeles y pegado. El resultado indica éxito solo si el comando termina correctamente. El portapapeles funciona aunque no exista un inyector de teclas.

**Tech Stack:** Rust, Tauri 2, `std::process::Command`, `wl-clipboard`, `ydotool`, Vitest.

## Global Constraints

- No usar `RemoteDesktop`, `ScreenCast` ni el portal para pegar.
- En Wayland, ejecutar `ydotool key 29:1 47:1 47:0 29:0`.
- No usar `wtype` en Unity Wayland.
- Si el daemon falta o falla, conservar el texto en portapapeles.
- No agregar una opción de interfaz. Detectar y usar el daemon automáticamente.
- No persistir audio ni texto fuera del historial existente.

---

### Task 1: Reemplazar el portal por el inyector local

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/wayland_paste.rs`
- Modify: `src-tauri/src/lib.rs:43-50, 750-795`
- Test: `src-tauri/src/wayland_paste.rs`

**Interfaces:**
- Consumes: `send_to_clipboard(text: &str) -> Result<(), String>`.
- Produces: `wayland_paste::paste_with_ydotool() -> Result<(), String>`.
- Consumes: `PlatformSession::Wayland` in `stop_dictation`.
- Produces: `DictationResult { pasted: true }` solo después de un comando exitoso.

- [ ] **Step 1: Escribir la prueba Rust que define el comando local**

```rust
#[test]
fn ydotool_command_presses_and_releases_control_v() {
    assert_eq!(ydotool_arguments(), [
        "key", "29:1", "47:1", "47:0", "29:0",
    ]);
}
```

- [ ] **Step 2: Ejecutar la prueba y confirmar que falla**

Run: `cargo test -q ydotool_command_presses_and_releases_control_v`

Expected: FAIL because `ydotool_arguments` does not exist.

- [ ] **Step 3: Implementar el inyector**

```rust
pub(crate) fn ydotool_arguments() -> [&'static str; 5] {
    ["key", "29:1", "47:1", "47:0", "29:0"]
}

pub(crate) fn paste_with_ydotool() -> Result<(), String> {
    let output = Command::new("ydotool")
        .args(ydotool_arguments())
        .output()
        .map_err(|error| format!("No se pudo ejecutar ydotool: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err("El teclado virtual local no está disponible. Inicia ydotoold; el texto sigue en el portapapeles.".into())
}
```

Eliminar `WaylandPasteSession`, `registered_portal_connection` como dependencia de pegado y el campo `RuntimeState::wayland_paste`. Eliminar las funciones y tipos `ashpd` que solo usaba el pegado. Mantener el portal de atajos globales.

Cambiar el bloque Wayland de `stop_dictation` para llamar a `paste_with_ydotool()` sin `await`. Mantener `pasted = false` y el mensaje de copia manual cuando retorna `Err`.

Eliminar las características `remote_desktop` y `screencast` de `ashpd` porque GlobalShortcuts sigue usando solo `tokio` y `global_shortcuts`.

- [ ] **Step 4: Ejecutar la prueba Rust y confirmar que pasa**

Run: `cargo test -q ydotool_command_presses_and_releases_control_v`

Expected: PASS.

- [ ] **Step 5: Ejecutar las pruebas nativas**

Run: `cargo test -q`

Expected: PASS sin errores de compilación por `ashpd` ni referencias al portal de pegado.

- [ ] **Step 6: Crear el commit de la tarea**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/wayland_paste.rs src-tauri/src/lib.rs
git commit -m "fix: use local Wayland keyboard paste"
```

### Task 2: Conservar el portapapeles y corregir el diagnóstico

**Files:**
- Modify: `src-tauri/src/lib.rs:374-430, 1320-1335`
- Modify: `src-tauri/src/core.rs:927-990`
- Test: `src-tauri/src/core.rs`

**Interfaces:**
- Consumes: `PlatformDiagnosis { clipboard_available, paste_available, paste_method }`.
- Produces: `send_to_clipboard` que usa `wl-copy` cuando `clipboard_available` es verdadero.
- Produces: diagnóstico Wayland que informa `wl-clipboard+ydotool` solo como pegado automático disponible por comando, sin tratar `wtype` como alternativa para Unity.

- [ ] **Step 1: Escribir la prueba que separa portapapeles e inyector**

```rust
#[test]
fn wayland_keeps_clipboard_when_ydotool_is_missing() {
    let diagnosis = diagnose_platform_with(
        wayland_environment(),
        |command| matches!(command, "wl-copy" | "wl-paste"),
    );
    assert!(diagnosis.clipboard_available);
    assert!(!diagnosis.paste_available);
}
```

- [ ] **Step 2: Ejecutar la prueba y confirmar que falla o expone el contrato actual**

Run: `cargo test -q wayland_keeps_clipboard_when_ydotool_is_missing`

Expected: FAIL if the current diagnosis still treats an injector as a clipboard prerequisite.

- [ ] **Step 3: Implementar diagnóstico y copia independientes**

En `core.rs`, para Wayland:

```rust
let wl_clipboard = wl_copy && wl_paste;
let ydotool = command_exists("ydotool");
let method = if wl_clipboard && ydotool {
    "wl-clipboard+ydotool"
} else if wl_clipboard {
    "wl-clipboard"
} else {
    "unavailable"
};
(wl_clipboard, wl_clipboard && ydotool, method.into())
```

Quitar la comprobación y la sugerencia de instalación de `wtype`. En `send_to_clipboard`, seleccionar `wl-copy` para ambos métodos `wl-clipboard` y `wl-clipboard+ydotool`. En `test_paste`, informar que `ydotoold` debe estar activo cuando el inyector no puede pegar.

- [ ] **Step 4: Ejecutar la prueba y confirmar que pasa**

Run: `cargo test -q wayland_keeps_clipboard_when_ydotool_is_missing`

Expected: PASS.

- [ ] **Step 5: Ejecutar la validación completa**

Run: `cargo test -q && npm test && npm run typecheck && npm run build`

Expected: Todas las pruebas pasan. `npm test` informa 14 archivos y al menos 101 pruebas.

- [ ] **Step 6: Crear el commit de la tarea**

```bash
git add src-tauri/src/core.rs src-tauri/src/lib.rs
git commit -m "fix: preserve Wayland clipboard without ydotool"
```

### Task 3: Prueba manual en Unity Wayland

**Files:**
- Modify: none

**Interfaces:**
- Consumes: aplicación iniciada con `npm run tauri -- dev` y el daemon `ydotoold` activo.
- Produces: evidencia de pegado en una aplicación externa sin ventana del portal.

- [ ] **Step 1: Iniciar el daemon local**

Run: `ydotoold`

Expected: el proceso queda activo y crea su socket. El proceso necesita acceso local a `/dev/uinput`.

- [ ] **Step 2: Iniciar Chamu**

Run: `npm run tauri -- dev`

Expected: la ventana de Chamu abre sin solicitud de escritorio remoto.

- [ ] **Step 3: Verificar el pegado externo**

1. Abrir un campo de texto en otra aplicación.
2. Dar foco a ese campo.
3. Mantener y soltar el atajo de Chamu.
4. Verificar que aparece el texto dictado en ese campo.

Expected: no aparece una ventana de compartir escritorio. El resultado indica que pegó el texto.

- [ ] **Step 4: Verificar la degradación segura**

1. Detener `ydotoold`.
2. Repetir el dictado.
3. Pegar manualmente con el teclado físico.

Expected: Chamu no falla. El texto sigue disponible en el portapapeles y el mensaje indica que debe iniciar `ydotoold`.
