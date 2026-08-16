# Pegado automático con GNOME Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pegar dictados en GNOME Shell 46–50 sin portal ni privilegios de administrador.

**Architecture:** Una extensión de GNOME Shell recibe `Paste` por D-Bus de sesión y emite `Ctrl+V` mediante un dispositivo virtual de Clutter. El backend Rust instala y habilita la extensión para el usuario, actualiza el portapapeles y llama el método. Si no está disponible, conserva el portapapeles.

**Tech Stack:** GNOME Shell 46–50, GJS, Clutter, Gio D-Bus, Rust, Tauri 2, ashpd/zbus, Vitest.

## Global Constraints

- Soportar solo GNOME Shell/Mutter 46–50, incluido `XDG_CURRENT_DESKTOP=Unity`.
- No usar `RemoteDesktop`, `ScreenCast`, `ydotool`, `wtype` ni `sudo` para pegar.
- La extensión expone solo `app.chamu.Input.Paste` en `/app/chamu/Input`.
- La extensión emite solo Ctrl+V y no lee pantalla, audio, ventanas ni portapapeles.
- Si falla la extensión, el texto queda en portapapeles y el resultado es `pasted: false`.

---

### Task 1: Crear y empaquetar la extensión GNOME Shell

**Files:**
- Create: `src-tauri/resources/chamu@chamu.app/metadata.json`
- Create: `src-tauri/resources/chamu@chamu.app/extension.js`
- Modify: `src-tauri/tauri.conf.json`
- Test: `scripts/gnome-shell-extension.test.mjs`

**Interfaces:**
- Produces: extensión con UUID `chamu@chamu.app`.
- Produces: servicio D-Bus `app.chamu.Input`, objeto `/app/chamu/Input`, interfaz `app.chamu.Input`, método `Paste` sin argumentos.
- Consumes: `Clutter.Seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE)`.

- [ ] **Step 1: Escribir pruebas de metadatos y contrato D-Bus**

```js
expect(metadata.uuid).toBe('chamu@chamu.app');
expect(metadata['shell-version']).toEqual(['46', '47', '48', '49', '50']);
expect(extension).toContain('app.chamu.Input');
expect(extension).toContain('Ctrl+V');
```

- [ ] **Step 2: Ejecutar la prueba y confirmar rojo**

Run: `npm test -- scripts/gnome-shell-extension.test.mjs`

Expected: FAIL porque no existen los recursos.

- [ ] **Step 3: Crear la extensión mínima**

`metadata.json` define el UUID, el nombre, la descripción y las versiones de
Shell 46 a 50. `extension.js` exporta una clase `Extension`, registra el nombre
D-Bus al habilitarse, exporta el objeto y libera ambos al deshabilitarse.

El método `Paste` crea un teclado virtual y ejecuta esta secuencia:

```js
Control_L pressed
v pressed
v released
Control_L released
```

Usar `GLib.get_monotonic_time()` para las marcas de tiempo y
`Clutter.KeyState` para el estado.

Agregar el directorio a `bundle.resources` de `tauri.conf.json` para que esté
presente en el paquete Linux.

- [ ] **Step 4: Ejecutar la prueba y confirmar verde**

Run: `npm test -- scripts/gnome-shell-extension.test.mjs`

Expected: PASS.

- [ ] **Step 5: Crear commit**

```bash
git add src-tauri/resources/chamu@chamu.app src-tauri/tauri.conf.json scripts/gnome-shell-extension.test.mjs
git commit -m "feat: add GNOME Shell paste extension"
```

### Task 2: Instalar y llamar la extensión desde el backend Rust

**Files:**
- Create: `src-tauri/src/gnome_paste.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/core.rs`
- Test: `src-tauri/src/gnome_paste.rs`
- Test: `src-tauri/src/core.rs`

**Interfaces:**
- Produces: `gnome_paste::install_extension() -> Result<(), String>`.
- Produces: `gnome_paste::enable_extension() -> Result<(), String>`.
- Produces: `gnome_paste::paste() -> impl Future<Output = Result<(), String>>`.
- Consumes: recursos de `src-tauri/resources/chamu@chamu.app` en desarrollo y
  el directorio de recursos de Tauri en producción.
- Consumes: `Compositor::Gnome` y `PlatformSession::Wayland`.

- [ ] **Step 1: Escribir pruebas Rust**

```rust
#[test]
fn unity_is_recognized_as_gnome() {
    assert_eq!(detect_compositor(Some("Unity")), Compositor::Gnome);
}

#[test]
fn gnome_extension_contract_uses_only_paste() {
    assert_eq!(DBUS_NAME, "app.chamu.Input");
    assert_eq!(DBUS_PATH, "/app/chamu/Input");
    assert_eq!(DBUS_METHOD, "Paste");
}
```

- [ ] **Step 2: Ejecutar pruebas y confirmar rojo**

Run: `cargo test -q unity_is_recognized_as_gnome gnome_extension_contract_uses_only_paste`

Expected: FAIL porque todavía no existe el módulo ni Unity se detecta como GNOME.

- [ ] **Step 3: Implementar el puente**

En `gnome_paste.rs`, definir constantes de D-Bus, copiar recursivamente los
archivos de extensión al directorio de extensiones del usuario y ejecutar
`gnome-extensions enable chamu@chamu.app`. El instalador debe devolver un error
concreto, sin bloquear el inicio de la aplicación.

Usar `ashpd::zbus::Connection::session()` y una llamada D-Bus al método `Paste`.
La llamada debe devolver error si el nombre de servicio no está activo.

En `core.rs`, considerar `unity` como `Compositor::Gnome`.

En `lib.rs`, instalar y habilitar la extensión al iniciar solo en GNOME
Wayland. Tras copiar el texto, llamar `gnome_paste::paste().await` solo en
GNOME Wayland. Quitar el uso de `wayland_paste::paste_with_ydotool`. Mantener
el fallback de portapapeles y `pasted: false` si falla.

- [ ] **Step 4: Ejecutar pruebas Rust y confirmar verde**

Run: `cargo test -q unity_is_recognized_as_gnome gnome_extension_contract_uses_only_paste`

Expected: PASS.

- [ ] **Step 5: Ejecutar pruebas nativas**

Run: `cargo test -q`

Expected: PASS.

- [ ] **Step 6: Crear commit**

```bash
git add src-tauri/src/gnome_paste.rs src-tauri/src/lib.rs src-tauri/src/core.rs
git commit -m "feat: paste dictation through GNOME Shell"
```

### Task 3: Validar la integración y el fallback

**Files:**
- Modify: `src-tauri/src/core.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/core.rs`
- Test: `scripts/gnome-shell-extension.test.mjs`

**Interfaces:**
- Consumes: extensión instalada y método `gnome_paste::paste()`.
- Produces: diagnóstico que no anuncia `ydotool` como requisito de GNOME Wayland.

- [ ] **Step 1: Escribir una prueba de diagnóstico GNOME**

```rust
#[test]
fn gnome_wayland_does_not_require_ydotool() {
    let diagnosis = diagnose_platform_with(gnome_wayland_environment(), |_| false);
    assert_eq!(diagnosis.compositor, Compositor::Gnome);
    assert!(!diagnosis.dependencies.iter().any(|item| item.name == "ydotool"));
}
```

- [ ] **Step 2: Ejecutar la prueba y confirmar rojo**

Run: `cargo test -q gnome_wayland_does_not_require_ydotool`

Expected: FAIL mientras el diagnóstico anuncie ydotool.

- [ ] **Step 3: Implementar el diagnóstico específico**

Para GNOME Wayland, presentar “Extensión GNOME Shell Chamu” como método de
pegado. No incluir `ydotool` ni una sugerencia de `sudo`. Para otros Wayland,
mantener solo el portapapeles como fallback.

- [ ] **Step 4: Ejecutar la prueba y confirmar verde**

Run: `cargo test -q gnome_wayland_does_not_require_ydotool`

Expected: PASS.

- [ ] **Step 5: Ejecutar validación completa**

Run: `cargo test -q && npm test && npm run typecheck && npm run build`

Expected: Todas las pruebas pasan.

- [ ] **Step 6: Crear commit**

```bash
git add src-tauri/src/core.rs src-tauri/src/lib.rs scripts/gnome-shell-extension.test.mjs
git commit -m "fix: use GNOME paste fallback"
```

### Task 4: Prueba manual en GNOME Shell 46

**Files:**
- Modify: none

- [ ] **Step 1: Detener ydotoold**

Run: `sudo pkill ydotoold`

Expected: no queda un daemon ydotool activo.

- [ ] **Step 2: Ejecutar Chamu**

Run: `npm run tauri -- dev`

Expected: Chamu instala y habilita `chamu@chamu.app` sin solicitar `sudo` ni
un portal de escritorio remoto.

- [ ] **Step 3: Confirmar extensión**

Run: `gnome-extensions list --enabled | rg '^chamu@chamu\.app$'`

Expected: muestra `chamu@chamu.app`.

- [ ] **Step 4: Confirmar pegado externo**

1. Dar foco a un campo de texto de otra aplicación.
2. Mantener y soltar el atajo de Chamu.

Expected: el texto aparece en ese campo. No aparece un portal. No hay daemon
ni privilegio de `ydotool`.
