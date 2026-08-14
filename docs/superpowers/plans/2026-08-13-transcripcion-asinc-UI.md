# Transcripción sin bloqueo de interfaz Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ejecutar la transcripción local fuera del hilo de interfaz al soltar un dictado.

**Architecture:** `stop_dictation` pasa a ser un comando asíncrono. Extrae la captura y marca el ciclo como `Transcribing` antes de esperar. Una tarea bloqueante detiene CPAL, verifica el modelo y ejecuta Whisper. El comando asíncrono conserva el historial, el portapapeles y el resultado existente cuando la tarea termina.

**Tech Stack:** Tauri 2, Tokio mediante `tauri::async_runtime`, Rust, CPAL, whisper-rs, Vitest.

## Global Constraints

- El audio solo existe en memoria y se borra al terminar.
- No crear archivos temporales ni procesos externos para Whisper.
- Mantener el contrato `DictationResult` y los estados visibles existentes.
- Mantener el atajo Wayland, el modo y el modelo sin cambios funcionales.
- Usar frases españolas cortas para los errores visibles.

---

## Estructura de archivos

- `src-tauri/src/lib.rs`: prepara la tarea de transcripción, mueve el trabajo bloqueante fuera del hilo principal y conserva la finalización actual.
- `src-tauri/src/lib.rs` pruebas: verifica que el trabajo de transcripción tiene valores propios y no necesita el estado de Tauri durante la ejecución.
- `src/components/AppShell.test.tsx`: mantiene una prueba de interfaz que muestra `Transcribiendo…` hasta que el comando nativo responde.

### Task 1: Separar el trabajo bloqueante del comando de detención

**Files:**

- Modify: `src-tauri/src/lib.rs:406-575`
- Test: `src-tauri/src/lib.rs:1240-1300`
- Test: `src/components/AppShell.test.tsx:201-238`

**Interfaces:**

- Consumes: `CaptureSessionHandle::stop(self) -> Result<Vec<i16>, String>`, `RecordingLifecycle::stop_without_audio() -> Result<(), String>`, `transcribe_with_embedded_whisper(&Path, &str, &mut [i16]) -> Result<String, String>`.
- Produces: `#[tauri::command] async fn stop_dictation(state: State<'_, RuntimeState>) -> Result<DictationResult, String>`.
- Preserves: `stopDictation(): Promise<DictationResult>` in `src/native/commands.ts`.

- [ ] **Step 1: Write the failing Rust test**

Add a private input value that owns the model path, language and samples used by the blocking task. Add this test next to the existing `lib.rs` tests:

```rust
#[test]
fn transcription_work_owns_model_language_and_audio() {
    let work = TranscriptionWork {
        model_path: PathBuf::from("/tmp/base.bin"),
        language: "es".into(),
        samples: vec![1, -2, 3],
    };

    assert_eq!(work.model_path, PathBuf::from("/tmp/base.bin"));
    assert_eq!(work.language, "es");
    assert_eq!(work.samples, vec![1, -2, 3]);
}
```

- [ ] **Step 2: Run the Rust test and verify it fails**

Run: `cargo test -q transcription_work_owns_model_language_and_audio` from `src-tauri/`.

Expected: fallo de compilación porque `TranscriptionWork` no existe.

- [ ] **Step 3: Add the minimum owned worker input and worker function**

In `src-tauri/src/lib.rs`, add a private `TranscriptionWork` next to `DictationResult`. Add a private function that consumes it. It must validate the checksum, call `transcribe_with_embedded_whisper`, reject texto vacío and return the text. It must clear the sample vector on every error branch.

```rust
struct TranscriptionWork {
    model_path: PathBuf,
    language: String,
    samples: Vec<i16>,
}

fn transcribe_work(mut work: TranscriptionWork, expected_checksum: &str) -> Result<String, String> {
    let validation = validate_model_checksum(&work.model_path, expected_checksum)?;
    if !validation.is_valid {
        work.samples.fill(0);
        return Err("El checksum SHA-256 del modelo no coincide; descárgalo otra vez.".into());
    }
    let text = transcribe_with_embedded_whisper(&work.model_path, &work.language, &mut work.samples)?;
    if text.is_empty() {
        return Err("whisper.cpp no devolvió texto".into());
    }
    Ok(text)
}
```

- [ ] **Step 4: Make `stop_dictation` asynchronous and isolate blocking work**

Change only `stop_dictation`:

1. Take `CaptureSessionHandle` from `RuntimeState.capture`.
2. Call `RecordingLifecycle::stop_without_audio()` before the first `.await`.
3. Read the selected language and create `TranscriptionWork` after the capture stops.
4. Run both `capture.stop()` and `transcribe_work(...)` inside `tauri::async_runtime::spawn_blocking`.
5. Await the join result and map panic errors to `"La transcripción terminó inesperadamente"`.
6. Keep history insertion, clipboard copy, `mark_copied`, `recover_dictation_after_error` and the existing `DictationResult` shape unchanged.

The command must not hold `MutexGuard` across `.await`. It must not invoke Whisper or `CaptureSessionHandle::stop` directly on the command task.

- [ ] **Step 5: Run the Rust test and verify it passes**

Run: `cargo test -q transcription_work_owns_model_language_and_audio` from `src-tauri/`.

Expected: pasa.

- [ ] **Step 6: Verify the existing interface pending state**

Run: `npm test -- src/components/AppShell.test.tsx`.

Expected: pasa la prueba `runs the dictation lifecycle from recording through backend transcription result`. La prueba verifica que el botón permanece como `Transcribiendo…` mientras `stopDictation` está pendiente.

- [ ] **Step 7: Run complete validation**

Run these commands from the repository root:

```bash
npm test
npm run typecheck
npm run build
cd src-tauri && cargo test -q
```

Expected: todas las pruebas pasan. Las advertencias existentes de Rust no bloquean el resultado.

- [ ] **Step 8: Manual native validation**

Run `npm run tauri -- dev`. Mantén el atajo configurado. Suéltalo. Mueve y redimensiona la ventana mientras muestra `Transcribiendo…`. Confirma que el escritorio no muestra `Chamu is not responding` y que el texto llega al campo de prueba.

- [ ] **Step 9: Commit only with explicit user authorization**

Stage only `src-tauri/src/lib.rs`, its tests, and the approved design/plan documents. Use the subject:

```bash
git commit -m "fix: keep Chamu responsive during transcription"
```
