#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

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

use core::{
    append_diagnostic, app_storage_paths, command_available,
    diagnose_platform as detect_platform, discover_models_in_dirs,
    finalize_model_download, load_diagnostics, load_settings_file, model_catalog, now_unix_millis,
    save_settings_file, validate_model_checksum, validate_settings, AppSettings, DiagnosticRecord,
    DownloadController, HistoryEntry, HistoryStore, LocalModel, ModelValidation,
    PlatformDiagnosis, RecordingLifecycle, RecordingPhase,
};
use audio_capture::CaptureSessionHandle;

struct RuntimeState {
    settings: Mutex<AppSettings>,
    history: Mutex<Option<HistoryStore>>,
    recording: Mutex<RecordingLifecycle>,
    downloads: DownloadController,
    diagnostics: Mutex<Vec<DiagnosticRecord>>,
    capture: Mutex<Option<CaptureSessionHandle>>,
}

static DOWNLOAD_TEMP_SEQUENCE: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelStatus {
    id: String,
    name: String,
    installed: bool,
    checksum_valid: bool,
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
        }
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
        name: "Whisper base multilingüe".into(),
        installed: false,
        checksum_valid: false,
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
        "wl-clipboard+wtype" | "wl-clipboard+ydotool" => Some("wl-copy"),
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

/// Runs whisper.cpp in-process. The model is a verified local file and the
/// captured PCM is converted only to an ephemeral f32 buffer required by the
/// engine; neither representation is written to disk or sent over the network.
fn transcribe_with_embedded_whisper(
    model_path: &Path,
    language: &str,
    samples: &mut [i16],
) -> Result<String, String> {
    let mut audio: Vec<f32> = samples
        .iter()
        .map(|sample| f32::from(*sample) / f32::from(i16::MAX))
        .collect();
    let result = (|| {
        let model_path = model_path
            .to_str()
            .ok_or_else(|| "La ruta del modelo contiene caracteres no compatibles".to_string())?;
        let context = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
            .map_err(|error| format!("No se pudo cargar el modelo local: {error}"))?;
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
    audio.fill(0.0);
    samples.fill(0);
    result
}

#[tauri::command]
fn get_settings(state: State<'_, RuntimeState>) -> Result<AppSettings, String> {
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
    validate_settings(&settings)?;
    save_settings_file(&settings_path()?, &settings)?;
    *state
        .settings
        .lock()
        .map_err(|_| "No se pudo actualizar la configuración".to_string())? = settings;
    Ok(())
}

#[tauri::command]
fn set_recording_active(active: bool, state: State<'_, RuntimeState>) -> Result<(), String> {
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
    })
}

fn recover_dictation_after_error(state: &RuntimeState) {
    if let Ok(mut recording) = state.recording.lock() {
        recording.mark_error();
    }
}

#[tauri::command]
fn stop_dictation(state: State<'_, RuntimeState>) -> Result<DictationResult, String> {
    let mut capture_extracted = false;
    let result = (|| -> Result<DictationResult, String> {
        let capture = state.capture.lock().map_err(|_| "No se pudo detener el micrófono".to_string())?.take()
            .ok_or_else(|| "No hay un dictado en curso".to_string())?;
        capture_extracted = true;
        let mut samples = capture.stop()?;
        state.recording.lock().map_err(|_| "No se pudo actualizar el estado".to_string())?.stop_without_audio()?;
        if samples.is_empty() {
            return Err("No se capturó audio; revisa el permiso del micrófono".into());
        }
        let model = model_catalog().into_iter().find(|model| model.id == "base")
            .ok_or_else(|| "No se encontró el modelo base".to_string())?;
        let model_path = model_install_path(&model)?;
        let validation = validate_model_checksum(&model_path, &model.sha256)?;
        if !validation.is_valid {
            samples.fill(0);
            return Err("El checksum SHA-256 del modelo no coincide; descárgalo otra vez.".into());
        }
        let language = match state
            .settings
            .lock()
            .map_err(|_| "No se pudo leer la configuración".to_string())?
            .language
            .as_str()
        {
            "en" => "en",
            _ => "es",
        };
        let text = transcribe_with_embedded_whisper(&model_path, language, &mut samples)?;
        if text.is_empty() { return Err("whisper.cpp no devolvió texto".into()); }
        let timestamp = now_unix_millis();
        let mut history = state.history.lock().map_err(|_| "No se pudo abrir el historial".to_string())?;
        if history.is_none() { *history = Some(HistoryStore::open(history_path()?)?); }
        let history_id = history
            .as_mut()
            .expect("history initialized")
            .insert(text.clone(), timestamp)?;
        let history_entry = history_entry_for_bridge(HistoryEntry {
            id: history_id,
            text: text.clone(),
            timestamp,
        });
        send_to_clipboard(&text)?;
        state.recording.lock().map_err(|_| "No se pudo actualizar el estado".to_string())?.mark_copied();
        Ok(DictationResult {
            status: "copied".into(),
            text: Some(text),
            history_entry: Some(history_entry),
            message: Some("Texto copiado al portapapeles local".into()),
        })
    })();
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
    state
        .recording
        .lock()
        .map_err(|_| "No se pudo actualizar el estado de grabación".to_string())?
        .mark_copied();
    Ok(())
}

#[tauri::command]
fn mark_recording_ready(state: State<'_, RuntimeState>) -> Result<(), String> {
    state
        .recording
        .lock()
        .map_err(|_| "No se pudo actualizar el estado de grabación".to_string())?
        .mark_ready();
    Ok(())
}

#[tauri::command]
fn mark_recording_error(state: State<'_, RuntimeState>) -> Result<(), String> {
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

#[tauri::command]
fn get_model_catalog() -> Vec<core::ModelMetadata> {
    model_catalog()
}

#[tauri::command]
fn inspect_model(model_id: Option<String>) -> Result<ModelStatus, String> {
    model_status(model_id.as_deref().unwrap_or("base"))
}

#[tauri::command]
fn start_model_download(
    model_id: String,
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    let model = model_catalog()
        .into_iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| "Modelo no disponible".to_string())?;
    let current_status = model_status(&model_id)?;
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
fn discover_models() -> Result<Vec<LocalModel>, String> {
    let paths = app_storage_paths()?.model_dirs;
    discover_models_in_dirs(&paths)
}

#[tauri::command]
fn validate_model(
    path: String,
    expected_sha256: Option<String>,
) -> Result<ModelValidation, String> {
    let path = PathBuf::from(path);
    let expected = match expected_sha256 {
        Some(expected) => expected,
        None => path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|filename| {
                model_catalog()
                    .into_iter()
                    .find(|model| model.filename == filename)
                    .map(|model| model.sha256)
            })
            .ok_or_else(|| "Se requiere el checksum SHA-256 del modelo".to_string())?,
    };
    validate_model_checksum(&path, &expected)
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
fn diagnose_platform() -> PlatformDiagnosis {
    detect_platform()
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
    ClipboardCheck {
        ok,
        message: user_visible_platform_message(
            ok,
            "El método local de pegado está disponible.",
            "No se pudo detectar un método local para pegar en la aplicación activa.",
        ),
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
}
