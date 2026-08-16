#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State,
};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

mod core;
mod dictation;
mod audio_adapter;
mod audio_capture;
mod gnome_paste;
mod wayland_shortcut;

use core::{
    append_diagnostic, app_storage_paths, command_available,
    diagnose_platform as detect_platform, discover_models_in_dirs,
    finalize_model_download, is_model_path_allowed, load_diagnostics, load_settings_file,
    model_catalog, now_unix_millis, save_settings_file, validate_model_checksum, validate_settings,
    AppSettings, DiagnosticRecord, DownloadController, HistoryEntry, HistoryStore, LocalModel,
    ModelValidation,
    PlatformDiagnosis, PlatformSession, RecordingLifecycle, RecordingPhase,
};
use audio_capture::CaptureSessionHandle;

struct RuntimeState {
    settings: Mutex<AppSettings>,
    history: Mutex<Option<HistoryStore>>,
    recording: Mutex<RecordingLifecycle>,
    downloads: DownloadController,
    diagnostics: Mutex<Vec<DiagnosticRecord>>,
    capture: Mutex<Option<CaptureSessionHandle>>,
    wayland_shortcut_task: Mutex<Option<wayland_shortcut::WaylandShortcutTask>>,
    wayland_shortcut_operation: tauri::async_runtime::Mutex<()>,
    wayland_shortcut_lifecycle: Mutex<wayland_shortcut::ShortcutLifecycleState>,
    wayland_shortcut_cleanup: Arc<Mutex<wayland_shortcut::ShortcutCleanupState>>,
    whisper_context: Arc<(Mutex<CachedWhisperContext>, Condvar)>,
    model_activation: tauri::async_runtime::Mutex<()>,
}

static DOWNLOAD_TEMP_SEQUENCE: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelStatus {
    id: String,
    name: String,
    label: String,
    installed: bool,
    checksum_valid: bool,
    active: bool,
    #[serde(rename = "sizeMiB")]
    size_mib: f64,
    progress: Option<u8>,
    error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ModelDownloadPhase {
    Connecting,
    Downloading,
    Validating,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ModelDownloadProgress {
    model_id: String,
    phase: ModelDownloadPhase,
    downloaded_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    percent: Option<u8>,
    message: String,
}

impl ModelDownloadProgress {
    fn new(
        model_id: impl Into<String>,
        phase: ModelDownloadPhase,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
        percent: Option<u8>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            model_id: model_id.into(),
            phase,
            downloaded_bytes,
            total_bytes,
            percent,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MicrophoneCheck {
    ok: bool,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MicrophoneInfo {
    name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutCheck {
    ok: bool,
    captured: String,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardCheck {
    ok: bool,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeHistoryEntry {
    id: i64,
    text: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DictationResult {
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    history_entry: Option<BridgeHistoryEntry>,
    message: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pasted: bool,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            settings: Mutex::new(AppSettings::default()),
            history: Mutex::new(None),
            recording: Mutex::new(RecordingLifecycle::default()),
            downloads: DownloadController::default(),
            diagnostics: Mutex::new(Vec::new()),
            capture: Mutex::new(None),
            wayland_shortcut_task: Mutex::new(None),
            wayland_shortcut_operation: tauri::async_runtime::Mutex::new(()),
            wayland_shortcut_lifecycle: Mutex::new(wayland_shortcut::ShortcutLifecycleState::default()),
            wayland_shortcut_cleanup: Arc::new(Mutex::new(
                wayland_shortcut::ShortcutCleanupState::default(),
            )),
            whisper_context: Arc::new((
                Mutex::new(CachedWhisperContext::default()),
                Condvar::new(),
            )),
            model_activation: tauri::async_runtime::Mutex::new(()),
        }
    }
}

#[derive(Default)]
struct CachedWhisperContext {
    context: Option<Arc<WhisperContext>>,
    model_id: Option<String>,
    loading: bool,
    generation: u64,
    #[cfg(test)]
    test_ready: bool,
    #[cfg(test)]
    test_model_id: Option<String>,
}

#[cfg(test)]
fn model_operation_is_available(state: &RuntimeState) -> bool {
    state.model_activation.try_lock().is_ok()
}

impl CachedWhisperContext {
    fn active_model_id(&self) -> Option<&str> {
        if self.context.is_some() {
            return self.model_id.as_deref();
        }
        #[cfg(test)]
        if self.test_ready {
            return self.test_model_id.as_deref();
        }
        None
    }
}

#[cfg(test)]
impl CachedWhisperContext {
    fn is_ready(&self) -> bool {
        self.context.is_some() || self.test_ready
    }

    fn mark_ready_for_test(&mut self, model_id: &str) {
        self.generation = self.generation.wrapping_add(1);
        self.loading = false;
        self.test_ready = true;
        self.test_model_id = Some(model_id.into());
    }

    fn mark_failed_for_test(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.context = None;
        self.model_id = None;
        self.loading = false;
        self.test_ready = false;
        self.test_model_id = None;
    }

    fn is_ready_for_model(&self, model_id: &str) -> bool {
        (self.context.is_some() && self.model_id.as_deref() == Some(model_id))
            || (self.test_ready && self.test_model_id.as_deref() == Some(model_id))
    }

    #[cfg(test)]
    fn load_generation_for_test(&self) -> u64 {
        self.generation
    }

    #[cfg(test)]
    fn commit_test_context_for_generation(&mut self, model_id: &str, generation: u64) -> bool {
        if self.generation != generation {
            return false;
        }
        self.mark_ready_for_test(model_id);
        true
    }
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(app_storage_paths()?.config_dir.join("settings.json"))
}

fn history_path() -> Result<PathBuf, String> {
    Ok(app_storage_paths()?.data_dir.join("history.sqlite3"))
}

fn diagnostics_path() -> Result<PathBuf, String> {
    Ok(app_storage_paths()?.data_dir.join("diagnostics.jsonl"))
}

fn model_status(model_id: &str) -> Result<ModelStatus, String> {
    let metadata = model_catalog()
        .into_iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| "Modelo no disponible".to_string())?;
    let mut status = ModelStatus {
        id: metadata.id.clone(),
        name: if metadata.id == "base" {
            "Whisper base multilingüe".into()
        } else {
            format!("Whisper {}", metadata.id)
        },
        label: metadata.label.clone(),
        installed: false,
        checksum_valid: false,
        // The active status is assigned by the command after it reads the
        // validated context cache. The settings value alone is not sufficient.
        active: false,
        size_mib: metadata.size_bytes as f64 / (1024.0 * 1024.0),
        progress: None,
        error: None,
    };

    let paths = match app_storage_paths() {
        Ok(paths) => paths,
        Err(_) => return Ok(status),
    };
    let models = discover_models_in_dirs(&paths.model_dirs)?;
    if let Some(local) = models.into_iter().find(|model| model.id == model_id) {
        status.installed = true;
        status.checksum_valid = local.is_valid == Some(true);
        if !status.checksum_valid {
            status.error = Some("El checksum SHA-256 del modelo no coincide".into());
        }
    }
    Ok(status)
}

fn model_install_path(model: &core::ModelMetadata) -> Result<PathBuf, String> {
    let paths = app_storage_paths()?;
    let directory = paths
        .model_dirs
        .first()
        .cloned()
        .ok_or_else(|| "No se encontró un directorio para modelos".to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join(&model.filename))
}

fn model_metadata(model_id: &str) -> Result<core::ModelMetadata, String> {
    model_catalog()
        .into_iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| "Modelo no disponible".to_string())
}

fn installed_model_path(model_id: &str) -> Result<(core::ModelMetadata, PathBuf), String> {
    let model = model_metadata(model_id)?;
    let paths = app_storage_paths()?;
    let local = discover_models_in_dirs(&paths.model_dirs)?
        .into_iter()
        .find(|local| local.id == model_id)
        .ok_or_else(|| "El modelo no está instalado".to_string())?;
    if local.is_valid != Some(true) {
        return Err("El checksum SHA-256 del modelo no coincide".into());
    }
    Ok((model, PathBuf::from(local.path)))
}

fn model_download_temp_path(destination: &Path) -> PathBuf {
    let sequence = DOWNLOAD_TEMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let filename = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("model.bin");
    destination.with_file_name(format!(
        ".{filename}.part-{}-{sequence}",
        std::process::id()
    ))
}

const DOWNLOAD_CANCELLED_MESSAGE: &str = "Descarga cancelada";
const MODEL_OPERATION_BUSY_MESSAGE: &str = "El modelo está cambiando; inténtalo de nuevo";
const MODEL_DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(5);

fn model_download_percent(downloaded_bytes: u64, total_bytes: Option<u64>) -> Option<u8> {
    total_bytes
        .filter(|total| *total > 0)
        .map(|total| ((downloaded_bytes.saturating_mul(100) / total).min(100)) as u8)
}

fn emit_model_download_progress(
    app: &AppHandle,
    model_id: &str,
    phase: ModelDownloadPhase,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<u8>,
    message: impl Into<String>,
) {
    let payload = ModelDownloadProgress::new(
        model_id,
        phase,
        downloaded_bytes,
        total_bytes,
        percent,
        message,
    );
    let _ = app.emit("model-download-progress", payload);
}

fn history_entry_for_bridge(entry: HistoryEntry) -> BridgeHistoryEntry {
    let created_at = chrono_like_iso8601(entry.timestamp);
    BridgeHistoryEntry {
        id: entry.id,
        text: entry.text,
        created_at,
    }
}

fn chrono_like_iso8601(timestamp_millis: i64) -> String {
    // Keep the bridge dependency-free.  The civil-date conversion follows the
    // proleptic Gregorian algorithm and emits a JavaScript-compatible UTC value.
    let seconds = timestamp_millis.div_euclid(1_000);
    let millis = timestamp_millis.rem_euclid(1_000);
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;

    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }).div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524
        - day_of_era / 146_096)
        / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    )
}

fn user_visible_platform_message(ok: bool, success: &str, failure: &str) -> String {
    if ok {
        success.into()
    } else {
        failure.into()
    }
}

fn microphone_available() -> bool {
    if let Ok(value) = std::env::var("CHAMU_MICROPHONE_AVAILABLE") {
        return matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "si");
    }
    #[cfg(target_os = "linux")]
    {
        return Path::new("/dev/snd").exists()
            || command_available("pw-record")
            || command_available("parecord")
            || command_available("arecord");
    }
    #[cfg(windows)]
    {
        // Windows exposes capture devices through the OS multimedia APIs.  The
        // actual sample capture remains in the future audio adapter; this command
        // reports that the native platform is eligible without retaining samples.
        return true;
    }
    #[allow(unreachable_code)]
    false
}

fn parse_history_id(id: serde_json::Value) -> Result<i64, String> {
    match id {
        serde_json::Value::Number(number) => number
            .as_i64()
            .ok_or_else(|| "El identificador del historial no es válido".into()),
        serde_json::Value::String(value) => value
            .parse::<i64>()
            .map_err(|_| "El identificador del historial no es válido".into()),
        _ => Err("El identificador del historial no es válido".into()),
    }
}

fn send_to_clipboard(text: &str) -> Result<(), String> {
    let diagnosis = detect_platform();
    let command = match diagnosis.paste_method.as_str() {
        "wl-clipboard" | "Extensión GNOME Shell Chamu" => Some("wl-copy"),
        "clipboard+xclip" => Some("xclip"),
        "clipboard+xsel" => Some("xsel"),
        _ if cfg!(windows) => Some("powershell.exe"),
        _ => None,
    };
    let Some(command) = command else {
        return Err("No se encontró un mecanismo de portapapeles compatible".into());
    };

    let mut child = if command == "wl-copy" {
        Command::new(command)
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|error| error.to_string())?
    } else if command == "xclip" {
        Command::new(command)
            .args(["-selection", "clipboard"])
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|error| error.to_string())?
    } else if command == "xsel" {
        Command::new(command)
            .args(["--clipboard", "--input"])
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|error| error.to_string())?
    } else {
        Command::new(command)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$input | Set-Clipboard",
            ])
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|error| error.to_string())?
    };
    child
        .stdin
        .take()
        .ok_or_else(|| "No se pudo abrir la entrada del portapapeles".to_string())?
        .write_all(text.as_bytes())
        .map_err(|error| error.to_string())?;
    let status = child.wait().map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("El sistema no pudo actualizar el portapapeles".into())
    }
}

fn load_validated_whisper_context(
    model_path: &Path,
    expected_sha256: &str,
) -> Result<Arc<WhisperContext>, String> {
    let validation_started = Instant::now();
    let validation = validate_model_checksum(model_path, expected_sha256);
    eprintln!(
        "Whisper checksum validation took {} ms",
        validation_started.elapsed().as_millis()
    );
    let validation = validation?;
    if !validation.is_valid {
        return Err("El checksum SHA-256 del modelo no coincide; descárgalo otra vez.".into());
    }

    let context_started = Instant::now();
    let context = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|error| format!("No se pudo cargar el modelo local: {error}"))?;
    eprintln!(
        "Whisper context load took {} ms",
        context_started.elapsed().as_millis()
    );
    Ok(Arc::new(context))
}

fn load_or_reuse_whisper_context(
    cache: &Arc<(Mutex<CachedWhisperContext>, Condvar)>,
    model_id: &str,
    model_path: &Path,
    expected_sha256: &str,
) -> Result<Arc<WhisperContext>, String> {
    loop {
        let (cache_lock, cache_ready) = &**cache;
        let mut cached = cache_lock
            .lock()
            .map_err(|_| "No se pudo acceder a la caché del modelo".to_string())?;
        if let Some(context) = cached.context.as_ref() {
            if cached.model_id.as_deref() == Some(model_id) {
                return Ok(Arc::clone(context));
            }
        }
        #[cfg(test)]
        if cached.is_ready_for_model(model_id) && cached.context.is_none() {
            return Err("La caché de prueba no contiene un contexto Whisper real".into());
        }
        if cached.loading {
            cached = cache_ready
                .wait(cached)
                .map_err(|_| "No se pudo esperar la carga del modelo".to_string())?;
            drop(cached);
            continue;
        }
        cached.loading = true;
        let load_generation = cached.generation;
        drop(cached);

        let result = load_validated_whisper_context(model_path, expected_sha256);
        let mut cached = cache_lock
            .lock()
            .map_err(|_| "No se pudo actualizar la caché del modelo".to_string())?;
        if cached.generation == load_generation {
            cached.loading = false;
            if let Ok(context) = &result {
                cached.context = Some(Arc::clone(context));
                cached.model_id = Some(model_id.to_string());
                cached.generation = cached.generation.wrapping_add(1);
                #[cfg(test)]
                {
                    cached.test_ready = false;
                    cached.test_model_id = None;
                }
            }
        }
        cache_ready.notify_all();
        return result;
    }
}

/// Prepares a verified context without changing the active cache entry.
///
/// Activation uses this two-phase operation so a failed persistence step cannot
/// discard the previously active context. The cache's loading flag still
/// serializes this preparation with transcription loads.
fn prepare_whisper_context(
    cache: &Arc<(Mutex<CachedWhisperContext>, Condvar)>,
    model_id: &str,
    model_path: &Path,
    expected_sha256: &str,
) -> Result<Arc<WhisperContext>, String> {
    loop {
        let (cache_lock, cache_ready) = &**cache;
        let mut cached = cache_lock
            .lock()
            .map_err(|_| "No se pudo acceder a la caché del modelo".to_string())?;
        if let Some(context) = cached.context.as_ref() {
            if cached.model_id.as_deref() == Some(model_id) {
                return Ok(Arc::clone(context));
            }
        }
        if cached.loading {
            cached = cache_ready
                .wait(cached)
                .map_err(|_| "No se pudo esperar la carga del modelo".to_string())?;
            drop(cached);
            continue;
        }
        cached.loading = true;
        let load_generation = cached.generation;
        drop(cached);

        let result = load_validated_whisper_context(model_path, expected_sha256);
        let mut cached = cache_lock
            .lock()
            .map_err(|_| "No se pudo actualizar la caché del modelo".to_string())?;
        if cached.generation == load_generation {
            cached.loading = false;
        }
        cache_ready.notify_all();
        return result;
    }
}

fn replace_cached_whisper_context(
    cache: &Arc<(Mutex<CachedWhisperContext>, Condvar)>,
    model_id: &str,
    context: Arc<WhisperContext>,
) {
    let (cache_lock, cache_ready) = &**cache;
    let mut cached = match cache_lock.lock() {
        Ok(cached) => cached,
        Err(poisoned) => poisoned.into_inner(),
    };
    cached.context = Some(context);
    cached.model_id = Some(model_id.to_string());
    cached.generation = cached.generation.wrapping_add(1);
    cached.loading = false;
    #[cfg(test)]
    {
        cached.test_ready = false;
        cached.test_model_id = None;
    }
    cache_ready.notify_all();
}

fn cached_active_model_id(
    cache: &Arc<(Mutex<CachedWhisperContext>, Condvar)>,
) -> Result<Option<String>, String> {
    let (cache_lock, _) = &**cache;
    let cached = cache_lock
        .lock()
        .map_err(|_| "No se pudo leer la caché del modelo".to_string())?;
    Ok(cached.active_model_id().map(str::to_owned))
}

/// Loads the installed model outside the UI thread. A missing model is normal
/// during onboarding, so it does not prevent the application from starting.
fn warm_whisper_context(
    cache: &Arc<(Mutex<CachedWhisperContext>, Condvar)>,
    model_id: &str,
) -> Result<(), String> {
    let model = model_metadata(model_id)?;
    let paths = app_storage_paths()?;
    let local = discover_models_in_dirs(&paths.model_dirs)?
        .into_iter()
        .find(|local| local.id == model_id);
    let Some(local) = local else {
        return Ok(());
    };
    load_or_reuse_whisper_context(cache, model_id, Path::new(&local.path), &model.sha256)
        .map(|_| ())
}

/// Runs whisper.cpp in-process. The context is a verified local model shared
/// by dictations, while each call creates a fresh state. The captured PCM is
/// converted only to an ephemeral f32 buffer required by the engine; neither
/// representation is written to disk or sent over the network.
fn transcribe_with_embedded_whisper(
    context: &WhisperContext,
    language: &str,
    samples: &mut [i16],
) -> Result<String, String> {
    let mut audio: Vec<f32> = samples
        .iter()
        .map(|sample| f32::from(*sample) / f32::from(i16::MAX))
        .collect();
    let inference_started = Instant::now();
    let result = (|| {
        let mut state = context
            .create_state()
            .map_err(|error| format!("No se pudo preparar whisper.cpp: {error}"))?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 5 });
        params.set_language(Some(language));
        params.set_translate(false);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        state
            .full(params, &audio)
            .map_err(|error| format!("whisper.cpp no pudo transcribir el audio: {error}"))?;
        let mut text = String::new();
        for segment in state.as_iter() {
            text.push_str(&segment.to_str_lossy().map_err(|error| error.to_string())?);
        }
        Ok(text.trim().to_owned())
    })();
    eprintln!(
        "Whisper inference took {} ms",
        inference_started.elapsed().as_millis()
    );
    audio.fill(0.0);
    samples.fill(0);
    result
}

struct TranscriptionWork {
    model_id: String,
    model_path: PathBuf,
    language: String,
    samples: Vec<i16>,
}

impl Drop for TranscriptionWork {
    fn drop(&mut self) {
        self.samples.fill(0);
    }
}

fn transcribe_work(
    mut work: TranscriptionWork,
    context: Arc<WhisperContext>,
) -> Result<String, String> {
    let result = (|| {
        if work.samples.is_empty() {
            return Err("No se capturó audio; revisa el permiso del micrófono".into());
        }
        let text = transcribe_with_embedded_whisper(&context, &work.language, &mut work.samples)?;
        if text.is_empty() {
            return Err("whisper.cpp no devolvió texto".into());
        }
        Ok(text)
    })();
    if result.is_err() {
        work.samples.fill(0);
    }
    result
}

#[tauri::command]
fn get_settings(state: State<'_, RuntimeState>) -> Result<AppSettings, String> {
    let _model_operation = state
        .model_activation
        .try_lock()
        .map_err(|_| MODEL_OPERATION_BUSY_MESSAGE.to_string())?;
    let path = settings_path()?;
    let settings = match load_settings_file(&path) {
        Ok(settings) => settings,
        Err(_error) if !path.exists() => AppSettings::default(),
        Err(error) => return Err(error),
    };
    *state
        .settings
        .lock()
        .map_err(|_| "No se pudo leer la configuración".to_string())? = settings.clone();
    Ok(settings)
}

#[tauri::command]
fn set_settings(settings: AppSettings, state: State<'_, RuntimeState>) -> Result<(), String> {
    let _model_operation = state
        .model_activation
        .try_lock()
        .map_err(|_| MODEL_OPERATION_BUSY_MESSAGE.to_string())?;
    validate_settings(&settings)?;
    let active_model_id = state
        .settings
        .lock()
        .map_err(|_| "No se pudo leer la configuración actual".to_string())?
        .model_id
        .clone();
    if settings.model_id != active_model_id {
        return Err("El modelo se cambia con activate_model".into());
    }
    save_settings_file(&settings_path()?, &settings)?;
    *state
        .settings
        .lock()
        .map_err(|_| "No se pudo actualizar la configuración".to_string())? = settings;
    Ok(())
}

#[tauri::command]
fn set_recording_active(active: bool, state: State<'_, RuntimeState>) -> Result<(), String> {
    let _model_operation = state
        .model_activation
        .try_lock()
        .map_err(|_| MODEL_OPERATION_BUSY_MESSAGE.to_string())?;
    let mut recording = state
        .recording
        .lock()
        .map_err(|_| "No se pudo actualizar el estado de grabación".to_string())?;
    if active {
        if recording.phase() != RecordingPhase::Recording {
            recording.start()?;
        }
    } else {
        recording.stop_without_audio()?;
    }
    Ok(())
}

#[tauri::command]
fn start_dictation(state: State<'_, RuntimeState>) -> Result<DictationResult, String> {
    let _model_operation = state
        .model_activation
        .try_lock()
        .map_err(|_| MODEL_OPERATION_BUSY_MESSAGE.to_string())?;
    let mut capture = state.capture.lock().map_err(|_| "No se pudo iniciar el micrófono".to_string())?;
    if capture.is_some() {
        return Err("Ya hay un dictado en curso".into());
    }
    *capture = Some(CaptureSessionHandle::start()?);
    if let Err(error) = state
        .recording
        .lock()
        .map_err(|_| "No se pudo actualizar el estado".to_string())?
        .start()
    {
        capture.take();
        return Err(error);
    }
    Ok(DictationResult {
        status: "recording".into(),
        text: None,
        history_entry: None,
        message: None,
        pasted: false,
    })
}

fn recover_dictation_after_error(state: &RuntimeState) {
    if let Ok(mut recording) = state.recording.lock() {
        recording.mark_error();
    }
}

#[tauri::command]
async fn stop_dictation(state: State<'_, RuntimeState>) -> Result<DictationResult, String> {
    let mut capture_extracted = false;
    let result = async {
        let (capture, model_id, language) = {
            let _model_operation = state
                .model_activation
                .try_lock()
                .map_err(|_| MODEL_OPERATION_BUSY_MESSAGE.to_string())?;
            let capture = state
                .capture
                .lock()
                .map_err(|_| "No se pudo detener el micrófono".to_string())?
                .take()
                .ok_or_else(|| "No hay un dictado en curso".to_string())?;
            capture_extracted = true;

            let (model_id, language) = state
                .settings
                .lock()
                .map_err(|_| "No se pudo leer la configuración".to_string())
                .map(|settings| {
                    let language = match settings.language.as_str() {
                        "en" => "en",
                        _ => "es",
                    }
                    .to_string();
                    (settings.model_id.clone(), language)
                })?;
            state
                .recording
                .lock()
                .map_err(|_| "No se pudo actualizar el estado".to_string())?
                .stop_without_audio()?;
            (capture, model_id, language)
        };

        let whisper_context = Arc::clone(&state.whisper_context);
        let text = tauri::async_runtime::spawn_blocking(move || {
            let (model, model_path) = installed_model_path(&model_id)?;
            let samples = capture.stop()?;
            if samples.is_empty() {
                return Err("No se capturó audio; revisa el permiso del micrófono".into());
            }
            let work = TranscriptionWork {
                model_id,
                model_path,
                language,
                samples,
            };
            let expected_sha256 = model.sha256.clone();
            let context = load_or_reuse_whisper_context(
                &whisper_context,
                &work.model_id,
                &work.model_path,
                &expected_sha256,
            )?;
            transcribe_work(work, context)
        })
        .await
        .map_err(|_| "La transcripción terminó inesperadamente".to_string())??;

        let timestamp = now_unix_millis();
        let history_entry = {
            let mut history = state
                .history
                .lock()
                .map_err(|_| "No se pudo abrir el historial".to_string())?;
            if history.is_none() {
                *history = Some(HistoryStore::open(history_path()?)?);
            }
            let history_id = history
                .as_mut()
                .expect("history initialized")
                .insert(text.clone(), timestamp)?;
            history_entry_for_bridge(HistoryEntry {
                id: history_id,
                text: text.clone(),
                timestamp,
            })
        };
        let clipboard_started = Instant::now();
        send_to_clipboard(&text)?;
        eprintln!(
            "Dictation clipboard update took {} ms",
            clipboard_started.elapsed().as_millis()
        );
        let mut message = "Texto copiado al portapapeles local".to_string();
        let mut pasted = false;
        let diagnosis = detect_platform();
        if diagnosis.session == PlatformSession::Wayland
            && diagnosis.compositor == core::Compositor::Gnome
        {
            let paste_started = Instant::now();
            match gnome_paste::paste().await {
                Ok(()) => {
                    eprintln!(
                        "Dictation Wayland paste took {} ms",
                        paste_started.elapsed().as_millis()
                    );
                    message = "Texto pegado en la ventana activa".into();
                    pasted = true;
                }
                Err(error) => {
                    message = format!(
                        "Texto copiado al portapapeles local. Pégalo manualmente: {error}"
                    );
                }
            }
        }
        state
            .recording
            .lock()
            .map_err(|_| "No se pudo actualizar el estado".to_string())?
            .mark_copied();
        Ok(DictationResult {
            status: "copied".into(),
            text: Some(text),
            history_entry: Some(history_entry),
            message: Some(message),
            pasted,
        })
    }
    .await;
    if capture_extracted && result.is_err() {
        recover_dictation_after_error(&state);
    }
    result
}

#[tauri::command]
fn get_recording_phase(state: State<'_, RuntimeState>) -> Result<RecordingPhase, String> {
    Ok(state
        .recording
        .lock()
        .map_err(|_| "No se pudo leer el estado de grabación".to_string())?
        .phase())
}

#[tauri::command]
fn mark_recording_copied(state: State<'_, RuntimeState>) -> Result<(), String> {
    let _model_operation = state
        .model_activation
        .try_lock()
        .map_err(|_| MODEL_OPERATION_BUSY_MESSAGE.to_string())?;
    state
        .recording
        .lock()
        .map_err(|_| "No se pudo actualizar el estado de grabación".to_string())?
        .mark_copied();
    Ok(())
}

#[tauri::command]
fn mark_recording_ready(state: State<'_, RuntimeState>) -> Result<(), String> {
    let _model_operation = state
        .model_activation
        .try_lock()
        .map_err(|_| MODEL_OPERATION_BUSY_MESSAGE.to_string())?;
    state
        .recording
        .lock()
        .map_err(|_| "No se pudo actualizar el estado de grabación".to_string())?
        .mark_ready();
    Ok(())
}

#[tauri::command]
fn mark_recording_error(state: State<'_, RuntimeState>) -> Result<(), String> {
    let _model_operation = state
        .model_activation
        .try_lock()
        .map_err(|_| MODEL_OPERATION_BUSY_MESSAGE.to_string())?;
    state
        .recording
        .lock()
        .map_err(|_| "No se pudo actualizar el estado de grabación".to_string())?
        .mark_error();
    Ok(())
}

#[tauri::command]
fn get_history(state: State<'_, RuntimeState>) -> Result<Vec<BridgeHistoryEntry>, String> {
    let mut history = state
        .history
        .lock()
        .map_err(|_| "No se pudo abrir el historial".to_string())?;
    if history.is_none() {
        *history = Some(HistoryStore::open(history_path()?)?);
    }
    history
        .as_ref()
        .expect("history store initialized")
        .list(100)
        .map(|entries| entries.into_iter().map(history_entry_for_bridge).collect())
}

#[tauri::command]
fn add_history_entry(text: String, state: State<'_, RuntimeState>) -> Result<HistoryEntry, String> {
    let timestamp = now_unix_millis();
    let mut history = state
        .history
        .lock()
        .map_err(|_| "No se pudo abrir el historial".to_string())?;
    if history.is_none() {
        *history = Some(HistoryStore::open(history_path()?)?);
    }
    let store = history.as_mut().expect("history store initialized");
    let id = store.insert(text, timestamp)?;
    store
        .list(100)?
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| "No se pudo recuperar la entrada guardada".to_string())
}

#[tauri::command]
fn delete_history_entry(id: i64, state: State<'_, RuntimeState>) -> Result<bool, String> {
    let mut history = state
        .history
        .lock()
        .map_err(|_| "No se pudo abrir el historial".to_string())?;
    if history.is_none() {
        *history = Some(HistoryStore::open(history_path()?)?);
    }
    history
        .as_mut()
        .expect("history store initialized")
        .delete(id)
}

#[tauri::command]
fn clear_history(state: State<'_, RuntimeState>) -> Result<(), String> {
    let mut history = state
        .history
        .lock()
        .map_err(|_| "No se pudo abrir el historial".to_string())?;
    if history.is_none() {
        *history = Some(HistoryStore::open(history_path()?)?);
    }
    history
        .as_mut()
        .expect("history store initialized")
        .clear()
}

#[tauri::command]
fn copy_history_entry(
    id: serde_json::Value,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    let id = parse_history_id(id)?;
    let mut history = state
        .history
        .lock()
        .map_err(|_| "No se pudo abrir el historial".to_string())?;
    if history.is_none() {
        *history = Some(HistoryStore::open(history_path()?)?);
    }
    let text = history
        .as_ref()
        .expect("history store initialized")
        .text_by_id(id)?
        .ok_or_else(|| "No se encontró la entrada del historial".to_string())?;
    if text.trim().is_empty() {
        return Err("La entrada del historial está vacía".into());
    }
    send_to_clipboard(&text)
}

#[tauri::command]
fn delete_history(id: serde_json::Value, state: State<'_, RuntimeState>) -> Result<(), String> {
    let id = parse_history_id(id)?;
    let mut history = state
        .history
        .lock()
        .map_err(|_| "No se pudo abrir el historial".to_string())?;
    if history.is_none() {
        *history = Some(HistoryStore::open(history_path()?)?);
    }
    let _ = history
        .as_mut()
        .expect("history store initialized")
        .delete(id)?;
    Ok(())
}

fn validate_model_activation_request(
    model_id: &str,
    phase: RecordingPhase,
    download_active: bool,
    status: &ModelStatus,
) -> Result<(), String> {
    validate_model_activation_light(model_id, phase, download_active)?;
    if !status.installed {
        return Err("El modelo no está instalado".into());
    }
    if !status.checksum_valid {
        return Err("El checksum SHA-256 del modelo no coincide".into());
    }
    Ok(())
}

fn validate_model_activation_light(
    model_id: &str,
    phase: RecordingPhase,
    download_active: bool,
) -> Result<(), String> {
    model_metadata(model_id)?;
    if matches!(phase, RecordingPhase::Recording | RecordingPhase::Transcribing) {
        return Err("No se puede cambiar el modelo durante la grabación o la transcripción".into());
    }
    if download_active {
        return Err("No se puede cambiar el modelo mientras hay una descarga en curso".into());
    }
    Ok(())
}

#[tauri::command]
fn get_model_catalog() -> Vec<core::ModelMetadata> {
    model_catalog()
}

#[tauri::command]
async fn inspect_model(
    model_id: Option<String>,
    state: State<'_, RuntimeState>,
) -> Result<ModelStatus, String> {
    let _model_operation = state
        .model_activation
        .try_lock()
        .map_err(|_| MODEL_OPERATION_BUSY_MESSAGE.to_string())?;
    let settings_model_id = state
        .settings
        .lock()
        .map_err(|_| "No se pudo leer la configuración actual".to_string())?
        .model_id
        .clone();
    let requested_model_id = model_id.unwrap_or(settings_model_id);
    let mut status = tauri::async_runtime::spawn_blocking(move || model_status(&requested_model_id))
        .await
        .map_err(|_| "La inspección del modelo terminó inesperadamente".to_string())??;
    let active_model_id = cached_active_model_id(&state.whisper_context)?;
    status.active = status.checksum_valid
        && active_model_id.as_deref() == Some(status.id.as_str());
    Ok(status)
}

#[tauri::command]
async fn activate_model(
    model_id: String,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    let _activation_guard = state.model_activation.lock().await;
    let phase = state
        .recording
        .lock()
        .map_err(|_| "No se pudo leer el estado de grabación".to_string())?
        .phase();
    let download_active = state.downloads.is_active();
    validate_model_activation_light(&model_id, phase, download_active)?;

    let cache = Arc::clone(&state.whisper_context);
    let preparation_model_id = model_id.clone();
    let prepared_context = tauri::async_runtime::spawn_blocking(move || {
        let status = model_status(&preparation_model_id)?;
        validate_model_activation_request(
            &preparation_model_id,
            phase,
            download_active,
            &status,
        )?;
        let (model, model_path) = installed_model_path(&preparation_model_id)?;
        let expected_sha256 = model.sha256.clone();
        prepare_whisper_context(
            &cache,
            &preparation_model_id,
            &model_path,
            &expected_sha256,
        )
    })
    .await
    .map_err(|_| "La preparación del modelo terminó inesperadamente".to_string())??;

    let post_phase = state
        .recording
        .lock()
        .map_err(|_| "No se pudo leer el estado de grabación".to_string())?
        .phase();
    validate_model_activation_light(&model_id, post_phase, state.downloads.is_active())?;

    let settings_path = settings_path()?;
    let previous_settings = state
        .settings
        .lock()
        .map_err(|_| "No se pudo leer la configuración actual".to_string())?
        .clone();
    let mut next_settings = previous_settings.clone();
    next_settings.model_id = model_id.clone();
    save_settings_file(&settings_path, &next_settings)?;

    replace_cached_whisper_context(&state.whisper_context, &model_id, prepared_context);
    *state
        .settings
        .lock()
        .map_err(|_| "No se pudo actualizar la configuración".to_string())? = next_settings;
    Ok(())
}

#[tauri::command]
async fn start_model_download(
    model_id: String,
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    let _model_operation = state
        .model_activation
        .try_lock()
        .map_err(|_| MODEL_OPERATION_BUSY_MESSAGE.to_string())?;
    let model = model_catalog()
        .into_iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| "Modelo no disponible".to_string())?;
    let status_model_id = model_id.clone();
    let current_status = tauri::async_runtime::spawn_blocking(move || model_status(&status_model_id))
        .await
        .map_err(|_| "La inspección del modelo terminó inesperadamente".to_string())??;
    if current_status.installed && current_status.checksum_valid {
        emit_model_download_progress(
            &app,
            &model_id,
            ModelDownloadPhase::Completed,
            model.size_bytes,
            Some(model.size_bytes),
            Some(100),
            "El modelo ya está instalado",
        );
        return Ok(());
    }

    let destination = model_install_path(&model)?;
    let temporary = model_download_temp_path(&destination);
    let plan = state.downloads.begin(&model_id)?;
    if let Err(error) = state.downloads.set_temporary_path(temporary.clone()) {
        state.downloads.finish(&model_id);
        let phase = if error == DOWNLOAD_CANCELLED_MESSAGE {
            ModelDownloadPhase::Cancelled
        } else {
            ModelDownloadPhase::Failed
        };
        emit_model_download_progress(
            &app,
            &model_id,
            phase,
            0,
            Some(model.size_bytes),
            (phase == ModelDownloadPhase::Cancelled).then_some(0),
            error.clone(),
        );
        return Err(error);
    }

    emit_model_download_progress(
        &app,
        &model_id,
        ModelDownloadPhase::Connecting,
        0,
        None,
        None,
        "Conectando con el servidor",
    );

    let controller = state.downloads.clone();
    let worker_app = app.clone();
    let worker_model = plan.model;
    let worker_model_id = model_id.clone();
    let worker_destination = destination;
    let worker_temporary = temporary.clone();
    thread::Builder::new()
        .name(format!("chamu-model-download-{worker_model_id}"))
        .spawn(move || {
            run_model_download(
                worker_app,
                controller,
                worker_model,
                worker_model_id,
                worker_destination,
                worker_temporary,
            );
        })
        .map(|_| ())
        .map_err(|error| {
            let message = format!("No se pudo iniciar la descarga: {error}");
            let _ = fs::remove_file(&temporary);
            state.downloads.finish(&model_id);
            emit_model_download_progress(
                &app,
                &model_id,
                ModelDownloadPhase::Failed,
                0,
                Some(model.size_bytes),
                None,
                message.clone(),
            );
            message
        })
}

fn run_model_download(
    app: AppHandle,
    controller: DownloadController,
    model: core::ModelMetadata,
    model_id: String,
    destination: PathBuf,
    temporary: PathBuf,
) {
    let result = perform_model_download(
        &app,
        &controller,
        &model,
        &model_id,
        &destination,
        &temporary,
    );

    match result {
        Ok((downloaded_bytes, total_bytes)) => emit_model_download_progress(
            &app,
            &model_id,
            ModelDownloadPhase::Completed,
            downloaded_bytes,
            total_bytes.or(Some(model.size_bytes)),
            Some(100),
            "Modelo descargado y validado",
        ),
        Err(error) => {
            let cancelled = controller.is_cancelled() || error == DOWNLOAD_CANCELLED_MESSAGE;
            let _ = fs::remove_file(&temporary);
            emit_model_download_progress(
                &app,
                &model_id,
                if cancelled {
                    ModelDownloadPhase::Cancelled
                } else {
                    ModelDownloadPhase::Failed
                },
                0,
                None,
                None,
                if cancelled {
                    DOWNLOAD_CANCELLED_MESSAGE.to_string()
                } else {
                    format!("Error al descargar el modelo: {error}")
                },
            );
        }
    }
    controller.finish(&model_id);
}

fn perform_model_download(
    app: &AppHandle,
    controller: &DownloadController,
    model: &core::ModelMetadata,
    model_id: &str,
    destination: &Path,
    temporary: &Path,
) -> Result<(u64, Option<u64>), String> {
    if controller.is_cancelled() {
        return Err(DOWNLOAD_CANCELLED_MESSAGE.into());
    }

    let client_builder: reqwest::blocking::ClientBuilder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(MODEL_DOWNLOAD_READ_TIMEOUT)
        .timeout(Duration::from_secs(60))
        .into();
    let client = client_builder
        .build()
        .map_err(|error| format!("No se pudo preparar la descarga: {error}"))?;
    let mut response = client
        .get(&model.download_url)
        .send()
        .map_err(|error| format!("No se pudo descargar el modelo: {error}"))?
        .error_for_status()
        .map_err(|error| format!("El servidor rechazó la descarga: {error}"))?;
    let total_bytes = response.content_length();

    if controller.is_cancelled() {
        return Err(DOWNLOAD_CANCELLED_MESSAGE.into());
    }

    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(temporary)
        .map_err(|error| error.to_string())?;
    let mut downloaded_bytes = 0_u64;
    emit_model_download_progress(
        app,
        model_id,
        ModelDownloadPhase::Downloading,
        downloaded_bytes,
        total_bytes,
        model_download_percent(downloaded_bytes, total_bytes),
        "Descargando modelo",
    );

    let mut buffer = [0_u8; 128 * 1024];
    loop {
        if controller.is_cancelled() {
            return Err(DOWNLOAD_CANCELLED_MESSAGE.into());
        }
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("No se pudo leer el modelo descargado: {error}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("No se pudo guardar el modelo descargado: {error}"))?;
        downloaded_bytes = downloaded_bytes.saturating_add(read as u64);
        emit_model_download_progress(
            app,
            model_id,
            ModelDownloadPhase::Downloading,
            downloaded_bytes,
            total_bytes,
            model_download_percent(downloaded_bytes, total_bytes),
            "Descargando modelo",
        );
    }
    if controller.is_cancelled() {
        return Err(DOWNLOAD_CANCELLED_MESSAGE.into());
    }
    file.flush().map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    emit_model_download_progress(
        app,
        model_id,
        ModelDownloadPhase::Validating,
        downloaded_bytes,
        total_bytes,
        model_download_percent(downloaded_bytes, total_bytes),
        "Validando modelo descargado",
    );
    if controller.is_cancelled() {
        return Err(DOWNLOAD_CANCELLED_MESSAGE.into());
    }
    finalize_model_download(temporary, destination, &model.sha256).map(|_| ())?;
    Ok((downloaded_bytes, total_bytes))
}

#[tauri::command]
async fn discover_models() -> Result<Vec<LocalModel>, String> {
    let paths = app_storage_paths()?.model_dirs;
    tauri::async_runtime::spawn_blocking(move || discover_models_in_dirs(&paths))
        .await
        .map_err(|_| "El descubrimiento de modelos terminó inesperadamente".to_string())?
}

#[tauri::command]
async fn validate_model(
    path: String,
    expected_sha256: Option<String>,
) -> Result<ModelValidation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        let paths = app_storage_paths()?;
        if !is_model_path_allowed(&path, &paths.model_dirs)? {
            return Err("La ruta del modelo está fuera de los directorios permitidos".into());
        }
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Modelo no disponible".to_string())?;
        let model = model_catalog()
            .into_iter()
            .find(|model| model.filename == filename)
            .ok_or_else(|| "Modelo no disponible".to_string())?;
        let expected = match expected_sha256 {
            Some(expected) => {
                let normalized = expected
                    .trim()
                    .strip_prefix("sha256:")
                    .unwrap_or(expected.trim());
                if !normalized.eq_ignore_ascii_case(&model.sha256) {
                    return Err("El checksum no corresponde a un modelo del catálogo".into());
                }
                model.sha256
            }
            None => model.sha256,
        };
        validate_model_checksum(&path, &expected)
    })
    .await
    .map_err(|_| "La validación del modelo terminó inesperadamente".to_string())?
}

#[tauri::command]
fn cancel_model_download(
    model_id: Option<String>,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    let _ = model_id;
    state.downloads.cancel();
    Ok(())
}

#[tauri::command]
async fn diagnose_platform() -> PlatformDiagnosis {
    let mut diagnosis = detect_platform();
    if diagnosis.session == PlatformSession::Wayland {
        let available = wayland_shortcut::probe_portal().await.is_ok();
        diagnosis.wayland_portal_available = Some(available);
        diagnosis.shortcut_method = if available {
            "xdg-global-shortcuts-portal".into()
        } else {
            "xdg-global-shortcuts-portal (no disponible)".into()
        };
        diagnosis.hold_mode_supported = available;
        diagnosis.dependencies.push(core::DependencyCheck {
            name: "Portal XDG GlobalShortcuts".into(),
            available,
            required: false,
            install_hint: None,
        });
    }
    diagnosis
}

#[tauri::command]
fn test_microphone() -> MicrophoneCheck {
    let ok = microphone_available();
    MicrophoneCheck {
        ok,
        message: user_visible_platform_message(
            ok,
            "Se detectó un dispositivo de captura; Chamu descartará el audio al terminar.",
            "No se detectó un dispositivo de captura. Revisa el permiso y vuelve a probar.",
        ),
    }
}

#[tauri::command]
fn get_microphone_info() -> MicrophoneInfo {
    MicrophoneInfo {
        name: audio_capture::default_input_device_name(),
    }
}

#[tauri::command]
fn test_shortcut(shortcut: String) -> ShortcutCheck {
    let diagnosis = detect_platform();
    let trimmed = shortcut.trim();
    if trimmed.is_empty() {
        return ShortcutCheck {
            ok: false,
            captured: String::new(),
            message: Some("El atajo no puede estar vacío".into()),
        };
    }
    let single_ctrl = trimmed.eq_ignore_ascii_case("Ctrl");
    let ok = diagnosis.toggle_mode_supported
        && !(single_ctrl && diagnosis.session == core::PlatformSession::Wayland);
    ShortcutCheck {
        ok,
        captured: ok.then(|| trimmed.to_string()).unwrap_or_default(),
        message: (!ok).then(|| {
            if single_ctrl {
                "Ctrl solo no está disponible en esta sesión; prueba Ctrl + Space.".into()
            } else {
                format!(
                    "No se pudo probar {trimmed} con el método {}.",
                    diagnosis.shortcut_method
                )
            }
        }),
    }
}

#[tauri::command]
fn test_clipboard() -> ClipboardCheck {
    let diagnosis = detect_platform();
    let ok = diagnosis.clipboard_available;
    ClipboardCheck {
        ok,
        message: user_visible_platform_message(
            ok,
            "El portapapeles local está disponible.",
            "Falta un mecanismo de portapapeles. Revisa las dependencias de tu sesión gráfica.",
        ),
    }
}

#[tauri::command]
fn test_paste() -> ClipboardCheck {
    let diagnosis = detect_platform();
    let ok = diagnosis.paste_available;
    let message = if ok {
        "El teclado virtual local está disponible.".into()
    } else if diagnosis.session == PlatformSession::Wayland && diagnosis.clipboard_available {
        "El texto se copiará al portapapeles. Pégalo manualmente en la ventana activa.".into()
    } else {
        "No se pudo detectar un método local para pegar en la aplicación activa.".into()
    };
    ClipboardCheck {
        ok,
        message,
    }
}

#[tauri::command]
fn record_diagnostic(
    shortcut: String,
    state: State<'_, RuntimeState>,
) -> Result<DiagnosticRecord, String> {
    if shortcut.trim().is_empty() {
        return Err("El atajo no puede estar vacío".into());
    }
    let diagnosis = detect_platform();
    let record = DiagnosticRecord::from_diagnosis(
        shortcut,
        DiagnosticRecord::new_session_id(),
        &diagnosis,
    );
    append_diagnostic(&diagnostics_path()?, &record)?;
    state
        .diagnostics
        .lock()
        .map_err(|_| "No se pudo guardar el diagnóstico".to_string())?
        .push(record.clone());
    Ok(record)
}

#[tauri::command]
fn get_diagnostics(state: State<'_, RuntimeState>) -> Result<Vec<DiagnosticRecord>, String> {
    let mut diagnostics = state
        .diagnostics
        .lock()
        .map_err(|_| "No se pudieron leer los diagnósticos".to_string())?;
    if diagnostics.is_empty() {
        *diagnostics = load_diagnostics(&diagnostics_path()?)?;
    }
    Ok(diagnostics.clone())
}

#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "No se encontró la ventana principal".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Abrir Chamu", true, None::<&str>)?;
    let close = MenuItem::with_id(app, "close", "Cerrar Chamu", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &close])?;

    TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Chamu · Dictado local")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                let _ = show_main_window(app.clone());
            }
            "close" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

fn spawn_gnome_extension_setup<F>(resource_dir: Option<PathBuf>, setup: F)
where
    F: FnOnce(Option<PathBuf>) + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || setup(resource_dir));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(RuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            set_recording_active,
            start_dictation,
            stop_dictation,
            get_recording_phase,
            mark_recording_copied,
            mark_recording_ready,
            mark_recording_error,
            get_history,
            add_history_entry,
            delete_history_entry,
            clear_history,
            copy_history_entry,
            delete_history,
            get_model_catalog,
            inspect_model,
            activate_model,
            start_model_download,
            discover_models,
            validate_model,
            cancel_model_download,
            diagnose_platform,
            test_microphone,
            get_microphone_info,
            test_shortcut,
            test_clipboard,
            test_paste,
            record_diagnostic,
            get_diagnostics,
            wayland_shortcut::configure_wayland_hold_shortcut,
            wayland_shortcut::clear_wayland_hold_shortcut,
            show_main_window
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            setup_tray(app)?;
            let diagnosis = detect_platform();
            if diagnosis.session == PlatformSession::Wayland
                && diagnosis.compositor == core::Compositor::Gnome
            {
                let resource_dir = app.path().resource_dir().ok();
                spawn_gnome_extension_setup(resource_dir, |resource_dir| {
                    if let Some(resource_dir) = resource_dir {
                        gnome_paste::configure_resource_dir(resource_dir);
                    }
                    match gnome_paste::install_extension() {
                        Ok(()) => {
                            if let Err(error) = gnome_paste::enable_extension() {
                                eprintln!("GNOME Shell extension enable skipped: {error}");
                            }
                        }
                        Err(error) => {
                            eprintln!("GNOME Shell extension install skipped: {error}");
                        }
                    }
                });
            }
            let whisper_context = Arc::clone(&app.state::<RuntimeState>().whisper_context);
            if let Ok(path) = settings_path() {
                if let Ok(settings) = load_settings_file(&path) {
                    if let Ok(mut current) = app.state::<RuntimeState>().settings.lock() {
                        *current = settings;
                    }
                }
            }
            let model_id = app
                .state::<RuntimeState>()
                .settings
                .lock()
                .map(|settings| settings.model_id.clone())
                .unwrap_or_else(|_| AppSettings::default().model_id);
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = warm_whisper_context(&whisper_context, &model_id) {
                    eprintln!("Whisper context warmup skipped: {error}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Chamu");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_download_progress_serializes_wire_contract() {
        let progress = ModelDownloadProgress::new(
            "base",
            ModelDownloadPhase::Downloading,
            512,
            Some(1_024),
            Some(50),
            "Descargando modelo",
        );

        let json = serde_json::to_value(progress).expect("serialize progress");
        assert_eq!(json["modelId"], "base");
        assert_eq!(json["phase"], "downloading");
        assert_eq!(json["downloadedBytes"], 512);
        assert_eq!(json["totalBytes"], 1_024);
        assert_eq!(json["percent"], 50);
        assert_eq!(json["message"], "Descargando modelo");

        let unknown_total = ModelDownloadProgress::new(
            "base",
            ModelDownloadPhase::Connecting,
            0,
            None,
            None,
            "Conectando",
        );
        let json = serde_json::to_value(unknown_total).expect("serialize progress");
        assert!(json.get("totalBytes").is_none());
        assert!(json.get("percent").is_none());
    }

    #[test]
    fn gnome_extension_setup_runs_in_background() {
        let caller_thread = std::thread::current().id();
        let (sender, receiver) = std::sync::mpsc::channel();

        spawn_gnome_extension_setup(None, move |_| {
            sender
                .send(std::thread::current().id())
                .expect("send worker thread id");
        });

        let worker_thread = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("background setup should run");
        assert_ne!(caller_thread, worker_thread);
    }

    #[test]
    fn model_download_read_timeout_is_shorter_than_total_timeout() {
        assert_eq!(MODEL_DOWNLOAD_READ_TIMEOUT, Duration::from_secs(5));
        assert!(MODEL_DOWNLOAD_READ_TIMEOUT < Duration::from_secs(60));
    }

    #[test]
    fn copied_dictation_result_contains_transcribed_text_and_history_entry() {
        let result = DictationResult {
            status: "copied".into(),
            text: Some("texto de prueba".into()),
            history_entry: Some(history_entry_for_bridge(HistoryEntry {
                id: 42,
                text: "texto de prueba".into(),
                timestamp: 1_700_000_000_000,
            })),
            message: Some("Texto copiado al portapapeles local".into()),
            pasted: false,
        };

        assert_eq!(result.status, "copied");
        assert_eq!(result.text.as_deref(), Some("texto de prueba"));
        assert_eq!(
            result
                .history_entry
                .as_ref()
                .map(|entry| entry.text.as_str()),
            Some("texto de prueba")
        );

        let json = serde_json::to_value(result).expect("serialize dictation result");
        assert!(json.get("historyEntry").is_some());
        assert!(json.get("history_entry").is_none());
    }

    #[test]
    fn dictation_error_after_capture_allows_a_new_dictation() {
        let state = RuntimeState::default();
        {
            let mut recording = state.recording.lock().expect("lock recording");
            recording.start().expect("start recording");
            recording
                .stop_without_audio()
                .expect("begin transcription");
            assert_eq!(recording.phase(), RecordingPhase::Transcribing);
        }

        recover_dictation_after_error(&state);

        let mut recording = state.recording.lock().expect("lock recording");
        assert_eq!(recording.phase(), RecordingPhase::Error);
        recording
            .start()
            .expect("a failed dictation must allow retry");
        assert_eq!(recording.phase(), RecordingPhase::Recording);
    }

    #[test]
    fn transcription_work_owns_model_language_and_audio() {
        let work = TranscriptionWork {
            model_id: "base".to_string(),
            model_path: PathBuf::from("/tmp/ggml-base.bin"),
            language: "es".to_string(),
            samples: vec![1, -2, 3],
        };

        assert_eq!(work.model_id, "base");
        assert_eq!(work.model_path, PathBuf::from("/tmp/ggml-base.bin"));
        assert_eq!(work.language, "es");
        assert_eq!(work.samples, vec![1, -2, 3]);
    }

    #[test]
    fn cached_context_is_reused_after_a_successful_load() {
        let mut cache = CachedWhisperContext::default();
        cache.mark_ready_for_test("base");

        assert!(cache.is_ready());
    }

    #[test]
    fn failed_context_load_leaves_no_ready_context() {
        let mut cache = CachedWhisperContext::default();
        cache.mark_failed_for_test();

        assert!(!cache.is_ready());
        assert!(cache.context.is_none());
    }

    fn test_model_status(installed: bool, checksum_valid: bool) -> ModelStatus {
        ModelStatus {
            id: "small".into(),
            name: "Whisper small".into(),
            label: "Predeterminado".into(),
            installed,
            checksum_valid,
            active: false,
            size_mib: 466.0,
            progress: None,
            error: None,
        }
    }

    #[test]
    fn activation_rejects_recording_phase() {
        let status = test_model_status(true, true);
        let error = validate_model_activation_request(
            "small",
            RecordingPhase::Recording,
            false,
            &status,
        )
        .expect_err("activation must reject recording");
        assert!(error.contains("grabación"));
    }

    #[test]
    fn activation_rejects_transcribing_phase() {
        let status = test_model_status(true, true);
        let error = validate_model_activation_request(
            "small",
            RecordingPhase::Transcribing,
            false,
            &status,
        )
        .expect_err("activation must reject transcription");
        assert!(error.contains("transcripción"));
    }

    #[test]
    fn activation_rejects_active_download() {
        let status = test_model_status(true, true);
        let error = validate_model_activation_request(
            "small",
            RecordingPhase::Ready,
            true,
            &status,
        )
        .expect_err("activation must reject active download");
        assert!(error.contains("descarga"));
    }

    #[test]
    fn activation_rejects_missing_model() {
        let status = test_model_status(false, false);
        let error = validate_model_activation_request(
            "small",
            RecordingPhase::Ready,
            false,
            &status,
        )
        .expect_err("activation must reject missing model");
        assert!(error.contains("instalado"));
    }

    #[test]
    fn activation_rejects_invalid_checksum() {
        let status = test_model_status(true, false);
        let error = validate_model_activation_request(
            "small",
            RecordingPhase::Ready,
            false,
            &status,
        )
        .expect_err("activation must reject invalid checksum");
        assert!(error.contains("checksum"));
    }

    #[test]
    fn activation_rejects_unknown_model_id() {
        let status = test_model_status(true, true);
        let error = validate_model_activation_request(
            "external-model",
            RecordingPhase::Ready,
            false,
            &status,
        )
        .expect_err("activation must reject unknown model");
        assert!(error.contains("disponible"));
    }

    #[test]
    fn cached_context_requires_matching_model_identity() {
        let mut cache = CachedWhisperContext::default();
        cache.mark_ready_for_test("base");

        assert!(cache.is_ready_for_model("base"));
        assert!(!cache.is_ready_for_model("small"));
    }

    #[test]
    fn settings_model_id_does_not_mark_model_active_without_a_validated_context() {
        let status = model_status("small").expect("inspect model status");

        assert!(!status.active);
    }

    #[test]
    fn stale_model_load_cannot_replace_a_newer_cached_activation() {
        let mut cache = CachedWhisperContext::default();
        let stale_generation = cache.load_generation_for_test();
        cache.mark_ready_for_test("small");

        assert!(!cache.commit_test_context_for_generation("base", stale_generation));
        assert!(cache.is_ready_for_model("small"));
        assert!(!cache.is_ready_for_model("base"));
    }

    #[test]
    fn model_operation_gate_is_busy_during_activation() {
        let state = RuntimeState::default();
        let _activation_guard = state
            .model_activation
            .try_lock()
            .expect("acquire activation gate");

        assert!(!model_operation_is_available(&state));
    }

    #[test]
    fn model_operation_gate_serializes_activation_and_download_start() {
        let state = RuntimeState::default();
        let activation_guard = state
            .model_activation
            .try_lock()
            .expect("acquire activation gate");
        assert!(!model_operation_is_available(&state));
        drop(activation_guard);

        let download_guard = state
            .model_activation
            .try_lock()
            .expect("acquire download gate");
        assert!(!model_operation_is_available(&state));
        drop(download_guard);
    }

    #[test]
    fn model_operation_busy_message_is_literal() {
        assert_eq!(
            MODEL_OPERATION_BUSY_MESSAGE,
            "El modelo está cambiando; inténtalo de nuevo"
        );
    }
}
