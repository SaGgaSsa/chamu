# Dictado rápido y pegado Wayland Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reutilizar el modelo Whisper validado y pegar el dictado en el campo activo de una aplicación Wayland.

**Architecture:** `RuntimeState` conserva un contexto Whisper validado y serializa la inferencia fuera del hilo principal. Un módulo Wayland abre una sesión de `RemoteDesktop` con teclado y envía `Ctrl+V` después de `wl-copy`; el probador solo refleja el resultado cuando era su campo activo al comenzar.

**Tech Stack:** Rust, Tauri 2, `whisper-rs`, `ashpd`, React, TypeScript, Vitest.

## Global Constraints

- Validar el SHA-256 antes de cargar el modelo, una vez por contexto cargado.
- Crear un `WhisperState` nuevo por dictado. No reutilizar audio ni estado.
- Mantener toda carga, captura e inferencia fuera del hilo principal de Tauri.
- No mantener un `MutexGuard` a través de `await`.
- En Wayland, `RemoteDesktop` es el método de pegado principal. No depender de `wtype` en Unity.
- Si el pegado falla, conservar el texto en el portapapeles y devolver un error visible.
- No persistir audio. Solo puede persistir el texto en el historial existente.
- Usar pruebas primero. Ejecutar `cargo test -q`, `npm test`, `npm run typecheck` y `npm run build`.

---

### Task 1: Contexto Whisper persistente y métricas

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/lib.rs` módulo `tests`

**Interfaces:**
- Consumes: `model_install_path`, `validate_model_checksum`, `WhisperContext`, `CaptureSessionHandle`.
- Produces: `RuntimeState` con una caché de contexto y `transcribe_work` que recibe `Arc<WhisperContext>`.

- [ ] **Step 1: Escribir pruebas que fallen**

Agregar una prueba para una caché vacía que acepta un contexto validado. Agregar una prueba para una caché con error que no conserva contexto. Extraer la decisión en una estructura testeable, por ejemplo:

```rust
#[derive(Default)]
struct CachedWhisperContext {
    context: Option<Arc<WhisperContext>>,
    loading: bool,
}

#[test]
fn cached_context_is_reused_after_a_successful_load() {
    let mut cache = CachedWhisperContext::default();
    cache.mark_ready_for_test();
    assert!(cache.is_ready());
}

#[test]
fn failed_context_load_leaves_no_ready_context() {
    let cache = CachedWhisperContext::default();
    assert!(!cache.is_ready());
}
```

- [ ] **Step 2: Ejecutar la prueba y verificar que falla**

Run: `cargo test -q cached_context_`

Expected: falla porque las funciones de caché no existen.

- [ ] **Step 3: Implementar la caché mínima**

Agregar a `RuntimeState` una caché protegida que conserva `Arc<WhisperContext>`. Crear una función que:

```rust
fn load_validated_whisper_context(
    model_path: &Path,
    expected_sha256: &str,
) -> Result<Arc<WhisperContext>, String>
```

Debe validar el checksum antes de crear el contexto. Debe registrar duraciones con `eprintln!` sin texto ni audio. Reemplazar la carga interna de `transcribe_with_embedded_whisper` por un argumento `&WhisperContext`. Crear `WhisperState` dentro de cada llamada.

En `stop_dictation`, detener la captura y cargar o reutilizar el contexto dentro de `spawn_blocking`. No mantener guardas de `Mutex` durante la carga ni la inferencia. La primera soltada puede esperar la carga. Las posteriores no deben volver a ejecutar el checksum ni `WhisperContext::new_with_params`.

- [ ] **Step 4: Ejecutar pruebas Rust**

Run: `cargo test -q`

Expected: todas las pruebas Rust pasan.

- [ ] **Step 5: Revisar alcance y crear un commit local**

Run: `git diff --check && git diff --stat`

Commit: `perf: reuse loaded Whisper model`

### Task 2: Pegado por portal Wayland y probador sin robo de foco

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/wayland_paste.rs`
- Modify: `src/components/DictationTester.tsx`
- Test: `src/components/DictationTester.test.tsx`
- Test: `src-tauri/src/wayland_paste.rs` módulo `tests`

**Interfaces:**
- Consumes: el texto transcrito y copiado por `send_to_clipboard`, `ashpd::desktop::remote_desktop::RemoteDesktop` y la caché de Task 1.
- Produces: `wayland_paste::WaylandPasteSession` y `paste_to_active_target(text, ...) -> Result<(), String>`.

- [ ] **Step 1: Escribir pruebas que fallen**

En el probador, agregar una prueba que inicia el dictado sin foco en el `textarea`, recibe `resultText`, y verifica que el valor no cambia ni se llama a `focus`.

En `wayland_paste.rs`, extraer la secuencia de teclas para probar que el pegado genera, en este orden, `Ctrl` abajo, `V` abajo, `V` arriba y `Ctrl` arriba:

```rust
#[test]
fn paste_shortcut_releases_v_before_control() {
    assert_eq!(paste_key_sequence(), [
        (KEY_LEFTCTRL, true),
        (KEY_V, true),
        (KEY_V, false),
        (KEY_LEFTCTRL, false),
    ]);
}
```

- [ ] **Step 2: Ejecutar las pruebas y verificar que fallan**

Run: `npm test -- DictationTester.test.tsx`

Run: `cargo test -q paste_shortcut_releases_v_before_control`

Expected: ambas fallan porque el comportamiento todavía no existe.

- [ ] **Step 3: Implementar portal y cambiar el probador**

Activar la feature `remote_desktop` de `ashpd`. Crear `wayland_paste.rs` que solicita una sesión persistente de `RemoteDesktop`, selecciona `DeviceType::Keyboard`, inicia la sesión y usa `notify_keyboard_keycode` para enviar la secuencia `Ctrl+V`. Usar una única sesión serializada. Si la sesión falla o se rechaza, devolver un mensaje que indique que el texto quedó copiado y que el usuario debe pegarlo manualmente.

Después de `send_to_clipboard(&text)`, llamar al pegado por portal solo cuando la sesión actual sea Wayland. Mantener los tiempos de portapapeles y pegado en el diagnóstico sin texto ni audio. En otros sistemas, conservar el comportamiento de solo copiar.

En `DictationTester`, conservar la posición de selección solo si el `textarea` tenía foco al comenzar. Al recibir un resultado para ese caso, actualizar el valor sin llamar a `focus` ni `requestAnimationFrame`. Si el probador no tenía foco, no modificar `text`; mostrar el mensaje de texto copiado/pegado.

- [ ] **Step 4: Ejecutar pruebas de componente y Rust**

Run: `npm test -- DictationTester.test.tsx`

Run: `cargo test -q`

Expected: todas las pruebas indicadas pasan.

- [ ] **Step 5: Ejecutar validación de integración y crear un commit local**

Run: `npm test && npm run typecheck && npm run build && (cd src-tauri && cargo test -q)`

Commit: `fix: paste dictation into active Wayland app`

### Task 3: Prueba manual local

**Files:**
- Modify: ninguno

**Interfaces:**
- Consumes: aplicación desarrollada con las tareas 1 y 2.
- Produces: confirmación de comportamiento nativo en la sesión Wayland/Unity del usuario.

- [ ] **Step 1: Ejecutar Chamu en modo desarrollo**

Run: `npm run tauri -- dev`

- [ ] **Step 2: Autorizar el portal de escritorio**

Aceptar el permiso de control de teclado cuando el escritorio lo solicite.

- [ ] **Step 3: Probar el destino activo**

Abrir un campo de texto de otra aplicación. Darle foco. Mantener el atajo, hablar y soltarlo. Verificar que el texto aparece en ese campo y que Chamu no recupera foco.

- [ ] **Step 4: Probar latencia**

Repetir el dictado. Verificar que el segundo resultado no muestra los logs `whisper_init_from_file_with_params_no_state` y que la espera previa a la inferencia desaparece.

- [ ] **Step 5: Informar resultado**

Registrar cualquier mensaje del portal, fallo de pegado o tiempo observado. No cambiar código durante esta tarea.
