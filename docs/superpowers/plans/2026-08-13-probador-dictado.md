# Probador de dictado Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar un probador de dictado en onboarding y en la pantalla principal; insertar allí la transcripción; corregir el atajo global; y simplificar Configuración.

**Architecture:** El backend devuelve el texto y la entrada de historial al terminar el dictado. Un componente React de probador concentra el área de texto, atajo, modo, estado y control. `App` conserva la marca de onboarding y permite restablecerla sin modificar el almacenamiento nativo.

**Tech Stack:** React 19, TypeScript estricto, Vitest, Tauri 2 y Rust.

## Global Constraints

- Usar español técnico, frases cortas y términos consistentes.
- No guardar audio ni rutas de audio.
- No borrar el modelo, el historial ni `settings.json` al reiniciar onboarding.
- Guardar `CommandOrControl` como formato de configuración.
- Convertir ese alias antes de registrar o validar el atajo global.
- No insertar texto en una aplicación externa. Copiarlo al portapapeles sigue siendo responsabilidad nativa.
- Ejecutar `npm test`, `npm run typecheck`, `npm run build` y `cargo test -q` desde `src-tauri/` antes de declarar finalizada la tarea.

---

## Estructura de archivos

- Modificar `src-tauri/src/lib.rs`: devolver `text` y `historyEntry` cuando termina el dictado.
- Modificar `src/native/commands.ts`: alinear `DictationResult` con el resultado nativo.
- Crear `src/components/DictationTester.tsx`: área de prueba, atajo, modo y control de dictado reutilizables.
- Crear `src/components/DictationTester.test.tsx`: prueba de inserción y guardado de configuración.
- Modificar `src/components/OnboardingFlow.tsx`: sustituir botones de prueba por el probador del segundo paso.
- Modificar `src/components/AppShell.tsx`: usar el probador como pantalla principal; dejar Configuración con idioma y reinicio.
- Modificar `src/App.tsx`: restablecer sólo la marca local de onboarding.
- Modificar pruebas de `App`, `AppShell`, `OnboardingFlow`, `ShortcutField` y estilos para el nuevo contrato.
- Modificar `src/components/ShortcutField.tsx`: normalizar el alias por plataforma antes de registrar o validar.
- Modificar `src/styles.css` y `src-tauri/tauri.conf.json`: ajustar altura, área flexible y diseño compacto.
- Modificar `README.md`: documentar inicio y prueba local.
- Modificar `src/components/ShortcutField.tsx`: conservar modificadores durante la captura y mostrar una vista previa.
- Modificar `src/components/AppShell.tsx`: pausar el registro global durante la captura y mostrar la preparación del micrófono.
- Modificar `src-tauri/src/audio_capture.rs`, `src-tauri/src/lib.rs` y `src/native/commands.ts`: devolver el nombre del micrófono predeterminado.

### Task 1: Resultado nativo completo de dictado

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/native/commands.ts`
- Test: `src-tauri/src/lib.rs` tests or the módulo Rust que contiene las pruebas del resultado

**Interfaces:**
- Produces: `DictationResult { status, text?: string, historyEntry?: HistoryEntry, message?: string }` con nombres camelCase serializados.
- Consumes: `HistoryStore::insert(text, timestamp) -> Result<i64, String>` y `history_entry_for_bridge`.

- [ ] **Step 1: Escribir una prueba Rust que exija texto y entrada de historial en un resultado copiado.**

```rust
assert_eq!(result.status, "copied");
assert_eq!(result.text.as_deref(), Some("texto de prueba"));
assert_eq!(result.history_entry.as_ref().map(|entry| entry.text.as_str()), Some("texto de prueba"));
```

- [ ] **Step 2: Ejecutar la prueba y confirmar que falla por los campos ausentes.**

Run: `cargo test -q dictation_result --manifest-path src-tauri/Cargo.toml`

- [ ] **Step 3: Añadir los campos opcionales y construir la entrada insertada.**

```rust
#[serde(skip_serializing_if = "Option::is_none")]
text: Option<String>,
#[serde(skip_serializing_if = "Option::is_none")]
history_entry: Option<BridgeHistoryEntry>,
```

Guardar el identificador que devuelve `insert`. Crear `HistoryEntry { id, text, timestamp }`. Convertirlo con `history_entry_for_bridge`. Devolver ambos campos sólo al finalizar correctamente.

- [ ] **Step 4: Alinear el tipo TypeScript.**

```ts
export interface DictationResult {
  status: 'ready' | 'recording' | 'transcribing' | 'copied' | 'error';
  text?: string;
  historyEntry?: HistoryEntry;
  message?: string;
}
```

- [ ] **Step 5: Ejecutar la prueba Rust y el chequeo TypeScript.**

Run: `cargo test -q --manifest-path src-tauri/Cargo.toml && npm run typecheck`

### Task 2: Componente reutilizable del probador

**Files:**
- Create: `src/components/DictationTester.tsx`
- Create: `src/components/DictationTester.test.tsx`
- Modify: `src/components/ShortcutField.tsx`
- Modify: `src/components/ShortcutField.test.tsx`

**Interfaces:**
- Consumes: `AppSettings`, `RecordingState`, `DictationControl`, `ShortcutField` y `DictationResult`.
- Produces: `DictationTester` que recibe `settings`, `onSettingsChange`, `state`, `pending`, `onDictationClick`, `resultText`, `shortcutRegistrationError` y `onShortcutRegistrationError`.
- Produces: `normalizeShortcutForPlatform(shortcut, platform)` para el registro y la sonda.

- [ ] **Step 1: Escribir pruebas fallidas del probador.**

```tsx
fireEvent.focus(screen.getByRole('textbox', { name: /texto de prueba/i }));
rerender(<DictationTester resultText="hola" {...props} />);
expect(screen.getByRole('textbox', { name: /texto de prueba/i })).toHaveValue('hola');

fireEvent.click(screen.getByRole('button', { name: /capturar atajo/i }));
fireEvent.keyDown(screen.getByRole('button', { name: /pulsa el atajo/i }), {
  code: 'KeyA', key: 'a', ctrlKey: true, shiftKey: true,
});
expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ shortcut: 'CommandOrControl+Shift+A' }));
```

- [ ] **Step 2: Ejecutar las pruebas y confirmar que fallan por el componente ausente.**

Run: `npm test -- src/components/DictationTester.test.tsx src/components/ShortcutField.test.tsx`

- [ ] **Step 3: Implementar el probador sin efectos nativos.**

El área debe ser un `textarea` controlado. Añadir `resultText` una vez por resultado. Insertar en la selección del área sólo si era el elemento enfocado cuando comenzó el dictado. Mostrar un mensaje claro si el resultado sólo se copió al portapapeles. Actualizar modo y atajo con `onSettingsChange`.

- [ ] **Step 4: Implementar la normalización de plataforma.**

```ts
export function normalizeShortcutForPlatform(
  shortcut: string,
  platform = navigator.platform,
): string {
  const modifier = /mac/i.test(platform) ? 'Command' : 'Ctrl';
  return shortcut.replace('CommandOrControl', modifier);
}
```

Usar el valor normalizado en `probeGlobalShortcut`. Mantener el valor original en `ShortcutField` y en la configuración.

- [ ] **Step 5: Ejecutar las pruebas del componente.**

Run: `npm test -- src/components/DictationTester.test.tsx src/components/ShortcutField.test.tsx`

### Task 3: Integrar el probador, el reinicio y el atajo activo

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/components/OnboardingFlow.tsx`
- Modify: `src/components/OnboardingFlow.test.tsx`
- Modify: `src/components/AppShell.tsx`
- Modify: `src/components/AppShell.test.tsx`

**Interfaces:**
- Consumes: `DictationTester` y el resultado nativo enriquecido de Task 1.
- Produces: `onRestartOnboarding(): void` desde `AppShell` hacia `App`.

- [ ] **Step 1: Escribir pruebas fallidas de integración.**

```tsx
fireEvent.click(screen.getByRole('button', { name: /reiniciar onboarding/i }));
expect(window.localStorage.getItem('chamu:onboarding-complete')).toBeNull();
expect(screen.getByRole('heading', { name: /prepara el modelo/i })).toBeVisible();

expect(screen.queryByRole('button', { name: /probar micrófono|probar pegado|probar atajo/i })).toBeNull();
expect(screen.getByRole('textbox', { name: /texto de prueba/i })).toBeVisible();
```

- [ ] **Step 2: Ejecutar las pruebas y confirmar que fallan.**

Run: `npm test -- src/App.test.tsx src/components/AppShell.test.tsx src/components/OnboardingFlow.test.tsx`

- [ ] **Step 3: Integrar el componente en onboarding y pantalla principal.**

Eliminar la prueba del sistema, el historial y sus acciones de la pantalla principal. Pasar el resultado `text` al probador. Mantener el control de dictado y su gestión de errores. Guardar cambios de modo y atajo desde el probador mediante `bridge.saveSettings`.

- [ ] **Step 4: Simplificar Configuración y reiniciar onboarding.**

Dejar sólo radios de idioma y el botón «Reiniciar onboarding». Confirmar el idioma con `saveSettings`. Llamar `onRestartOnboarding`; este método elimina sólo `chamu:onboarding-complete` y cambia el estado React.

- [ ] **Step 5: Registrar el atajo normalizado.**

Usar `normalizeShortcutForPlatform(currentSettings.shortcut)` para `register` y `unregister`. Mostrar el valor guardado en la interfaz. No ejecutar un atajo mientras una acción de dictado está pendiente.

- [ ] **Step 6: Ejecutar las pruebas de integración.**

Run: `npm test -- src/App.test.tsx src/components/AppShell.test.tsx src/components/OnboardingFlow.test.tsx`

### Task 4: Ventana, estilos y guía de prueba local

**Files:**
- Modify: `src/styles.css`
- Modify: `src/styles.test.ts`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: clases emitidas por `DictationTester`.
- Produces: ventana inicial de `760 × 700` o mayor, contenido con área flexible y documentación de desarrollo.

- [ ] **Step 1: Escribir una prueba de estilos fallida.**

```ts
expect(cssBlock('.dictation-tester')).toMatch(/min-height:\s*0\s*;/i);
expect(cssBlock('.dictation-tester__text')).toMatch(/flex:\s*1\s*;/i);
expect(styles).toMatch(/@media\s*\(max-height:/i);
```

- [ ] **Step 2: Ejecutar la prueba y confirmar que falla.**

Run: `npm test -- src/styles.test.ts`

- [ ] **Step 3: Ajustar la ventana y las reglas de diseño.**

Configurar la altura inicial en `src-tauri/tauri.conf.json` a 700 o una altura que cubra el probador. Usar `min-height: 0` en contenedores flexibles. Limitar el scroll al `textarea`. Reducir espaciados y tamaño del control en alturas bajas. Mantener el fallback de una columna y scroll de página para pantallas pequeñas.

- [ ] **Step 4: Documentar ejecución y prueba manual.**

Añadir el bloque:

```bash
npm ci
npm run tauri -- dev
```

Describir: hacer foco en «Texto de prueba», iniciar y detener con botón, repetir con el atajo, comprobar la inserción y el portapapeles. Indicar que un atajo ocupado o la sesión gráfica pueden impedir el registro global.

- [ ] **Step 5: Ejecutar la prueba de estilos.**

Run: `npm test -- src/styles.test.ts`

### Task 5: Captura visible de atajo y micrófono predeterminado

**Files:**
- Modify: `src/components/ShortcutField.tsx`
- Modify: `src/components/ShortcutField.test.tsx`
- Modify: `src/components/DictationTester.tsx`
- Modify: `src/components/DictationTester.test.tsx`
- Modify: `src/components/AppShell.tsx`
- Modify: `src/components/AppShell.test.tsx`
- Modify: `src/native/commands.ts`
- Modify: `src-tauri/src/audio_capture.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `ShortcutFieldProps.onCapturingChange?: (capturing: boolean) => void`.
- Produces: `getMicrophoneInfo(): Promise<MicrophoneInfo>` con `{ name: string }`.
- Consumes: `cpal::Host::default_input_device()` y `DeviceTrait::name()`.

- [ ] **Step 1: Escribir pruebas fallidas de atajo y micrófono.**

```tsx
fireEvent.click(screen.getByRole('button', { name: /capturar atajo/i }));
fireEvent.keyDown(screen.getByRole('button', { name: /pulsa el atajo/i }), {
  code: 'ControlLeft', key: 'Control', ctrlKey: true,
});
expect(screen.getByText(/ctrl.*…/i)).toBeVisible();
expect(onError).not.toHaveBeenCalled();

fireEvent.keyDown(screen.getByRole('button', { name: /pulsa el atajo/i }), { key: 'Escape' });
expect(onChange).not.toHaveBeenCalled();

expect(screen.getByText('Micrófono activo: Micrófono USB')).toBeVisible();
```

La mutación que estas pruebas deben detectar es volver a terminar la captura al pulsar sólo `Ctrl`, aceptar un atajo después de `Esc`, u ocultar el nombre del micrófono.

- [ ] **Step 2: Ejecutar las pruebas y confirmar que fallan.**

Run: `npm test -- src/components/ShortcutField.test.tsx src/components/DictationTester.test.tsx src/components/AppShell.test.tsx`

- [ ] **Step 3: Implementar la captura no final con vista previa.**

En `keydown`, si no hay tecla principal y hay modificadores, conservar `capturing`, limpiar el error y mostrar la combinación con `…`. Si la tecla es `Escape`, cancelar, restaurar el valor visible existente y notificar `onCapturingChange(false)`. Al aceptar o cancelar, notificar el mismo cambio. Sólo aplicar `normalizeShortcutFromKeyboardEvent` como error final cuando haya una tecla principal.

- [ ] **Step 4: Pausar el registro global durante la captura.**

En `AppShell`, conservar `shortcutCaptureActive`. No registrar el atajo cuando es verdadero. La limpieza existente debe desregistrarlo al cambiar a verdadero. Volver a registrar el atajo guardado cuando cambie a falso. No cambiar el valor guardado mientras se captura.

- [ ] **Step 5: Devolver y mostrar el micrófono predeterminado.**

Crear una función pura en `audio_capture.rs` que reciba un nombre opcional y devuelva el nombre o `Micrófono predeterminado del sistema`. El comando Tauri debe leer el dispositivo predeterminado y su nombre. Exponerlo en el puente y cargarlo una vez en `AppShell`. Pasarlo a `DictationTester` y mostrar `Micrófono activo: <nombre>`.

- [ ] **Step 6: Mostrar la preparación del micrófono.**

Añadir un estado de interfaz `starting` o una bandera equivalente. Cambiarlo antes de esperar `startDictation`. Mostrar `Preparando micrófono…` y desactivar la acción duplicada. Volver a `recording` al resultado nativo. Volver a `error` si falla.

- [ ] **Step 7: Ejecutar pruebas frontend y Rust.**

Run: `npm test -- src/components/ShortcutField.test.tsx src/components/DictationTester.test.tsx src/components/AppShell.test.tsx && cargo test -q --manifest-path src-tauri/Cargo.toml`

### Task 6: Validación final

**Files:**
- Verify: archivos modificados en Tasks 1–5

- [ ] **Step 1: Revisar el alcance de archivos.**

Run: `git diff --check && git diff --stat && git status --short`

- [ ] **Step 2: Ejecutar validación frontend completa.**

Run: `npm test && npm run typecheck && npm run build`

- [ ] **Step 3: Ejecutar validación Rust completa.**

Run: `cargo test -q` desde `src-tauri/`

- [ ] **Step 4: Ejecutar la prueba manual local.**

Run: `npm run tauri -- dev`

Verificar el área de prueba con botón y atajo. Verificar que el segundo uso del botón no cierra la aplicación. Registrar cualquier limitación de la sesión gráfica.

- [ ] **Step 5: Informar resultados sin crear commit.**

No crear un commit, push, etiqueta o PR sin autorización explícita del usuario.
