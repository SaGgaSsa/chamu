//! Privacy-oriented native services used by the Tauri command bridge.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MODEL_BASE_SHA256: &str =
    "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe";
pub const MODEL_BASE_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
pub const MODEL_BASE_SIZE_BYTES: u64 = 147_951_465;
pub const MODEL_SMALL_SHA256: &str =
    "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b";
pub const MODEL_SMALL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";
pub const MODEL_SMALL_SIZE_BYTES: u64 = 487_601_967;
pub const MODEL_LARGE_V3_TURBO_Q5_0_SHA256: &str =
    "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2";
pub const MODEL_LARGE_V3_TURBO_Q5_0_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin";
pub const MODEL_LARGE_V3_TURBO_Q5_0_SIZE_BYTES: u64 = 574_041_195;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub language: String,
    pub mode: String,
    pub shortcut: String,
    #[serde(default = "legacy_model_id")]
    pub model_id: String,
}

fn legacy_model_id() -> String {
    "base".into()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            language: "es".into(),
            mode: "hold".into(),
            shortcut: "CommandOrControl+Shift+Space".into(),
            model_id: "small".into(),
        }
    }
}

pub fn validate_settings(settings: &AppSettings) -> Result<(), String> {
    if !matches!(settings.language.as_str(), "es" | "en") {
        return Err("Idioma no válido".into());
    }
    if !matches!(settings.mode.as_str(), "hold" | "toggle") {
        return Err("Modo de grabación no válido".into());
    }
    if settings.shortcut.trim().is_empty() {
        return Err("El atajo no puede estar vacío".into());
    }
    if settings.shortcut.len() > 200 {
        return Err("El atajo es demasiado largo".into());
    }
    if !model_catalog().iter().any(|model| model.id == settings.model_id) {
        return Err("Modelo no disponible".into());
    }
    Ok(())
}

pub fn load_settings_file(path: &Path) -> Result<AppSettings, String> {
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let settings: AppSettings = serde_json::from_str(&contents)
        .map_err(|error| format!("No se pudo leer la configuración: {error}"))?;
    validate_settings(&settings)?;
    Ok(settings)
}

pub fn save_settings_file(path: &Path, settings: &AppSettings) -> Result<(), String> {
    validate_settings(settings)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let temporary = path.with_extension("json.tmp");
    let serialized = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("No se pudo serializar la configuración: {error}"))?;
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&serialized).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    set_private_permissions(&temporary);

    // Rename is atomic on the supported filesystems.  Windows does not replace an
    // existing file, so remove only this exact settings target before retrying.
    if let Err(rename_error) = fs::rename(&temporary, path) {
        if path.exists() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
            fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        } else {
            return Err(rename_error.to_string());
        }
    }
    set_private_permissions(path);
    Ok(())
}

fn set_private_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = fs::metadata(path) {
            let mut permissions = metadata.permissions();
            permissions.set_mode(0o600);
            let _ = fs::set_permissions(path, permissions);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub text: String,
    pub timestamp: i64,
}

pub struct HistoryStore {
    connection: Connection,
}

impl HistoryStore {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;
                 CREATE TABLE IF NOT EXISTS history (
                     id INTEGER PRIMARY KEY AUTOINCREMENT,
                     text TEXT NOT NULL,
                     timestamp INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS history_timestamp_idx
                     ON history(timestamp DESC, id DESC);",
            )
            .map_err(|error| error.to_string())?;
        Ok(Self { connection })
    }

    pub fn insert(&mut self, text: String, timestamp: i64) -> Result<i64, String> {
        if text.trim().is_empty() {
            return Err("El texto del historial no puede estar vacío".into());
        }
        if text.len() > 1_000_000 {
            return Err("El texto del historial es demasiado largo".into());
        }
        self.connection
            .execute(
                "INSERT INTO history(text, timestamp) VALUES (?1, ?2)",
                params![text, timestamp],
            )
            .map_err(|error| error.to_string())?;
        Ok(self.connection.last_insert_rowid())
    }

    pub fn list(&self, limit: usize) -> Result<Vec<HistoryEntry>, String> {
        let limit = limit.clamp(1, 500) as i64;
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, text, timestamp
                 FROM history
                 ORDER BY timestamp DESC, id DESC
                 LIMIT ?1",
            )
            .map_err(|error| error.to_string())?;
        let entries = statement
            .query_map(params![limit], |row| {
                Ok(HistoryEntry {
                    id: row.get(0)?,
                    text: row.get(1)?,
                    timestamp: row.get(2)?,
                })
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(entries)
    }

    pub fn delete(&mut self, id: i64) -> Result<bool, String> {
        let affected = self
            .connection
            .execute("DELETE FROM history WHERE id = ?1", params![id])
            .map_err(|error| error.to_string())?;
        Ok(affected == 1)
    }

    pub fn clear(&mut self) -> Result<(), String> {
        self.connection
            .execute("DELETE FROM history", [])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn contains_id(&self, id: i64) -> Result<bool, String> {
        self.connection
            .query_row(
                "SELECT 1 FROM history WHERE id = ?1 LIMIT 1",
                params![id],
                |_| Ok(()),
            )
            .optional()
            .map(|value| value.is_some())
            .map_err(|error| error.to_string())
    }

    pub fn text_by_id(&self, id: i64) -> Result<Option<String>, String> {
        self.connection
            .query_row(
                "SELECT text FROM history WHERE id = ?1 LIMIT 1",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())
    }
}

pub fn now_unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelMetadata {
    pub id: String,
    pub label: String,
    pub filename: String,
    pub language: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub download_url: String,
}

pub fn model_catalog() -> Vec<ModelMetadata> {
    vec![
        ModelMetadata {
            id: "base".into(),
            label: "Liviano".into(),
            filename: "ggml-base.bin".into(),
            language: "multilingual".into(),
            size_bytes: MODEL_BASE_SIZE_BYTES,
            sha256: MODEL_BASE_SHA256.into(),
            download_url: MODEL_BASE_URL.into(),
        },
        ModelMetadata {
            id: "small".into(),
            label: "Predeterminado".into(),
            filename: "ggml-small.bin".into(),
            language: "multilingual".into(),
            size_bytes: MODEL_SMALL_SIZE_BYTES,
            sha256: MODEL_SMALL_SHA256.into(),
            download_url: MODEL_SMALL_URL.into(),
        },
        ModelMetadata {
            id: "large-v3-turbo-q5_0".into(),
            label: "Calidad".into(),
            filename: "ggml-large-v3-turbo-q5_0.bin".into(),
            language: "multilingual".into(),
            size_bytes: MODEL_LARGE_V3_TURBO_Q5_0_SIZE_BYTES,
            sha256: MODEL_LARGE_V3_TURBO_Q5_0_SHA256.into(),
            download_url: MODEL_LARGE_V3_TURBO_Q5_0_URL.into(),
        },
    ]
}

fn model_metadata_for_filename(filename: &str) -> Option<ModelMetadata> {
    model_catalog()
        .into_iter()
        .find(|metadata| metadata.filename == filename)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelValidation {
    pub path: String,
    pub size_bytes: u64,
    pub actual_sha256: String,
    pub expected_sha256: String,
    pub is_valid: bool,
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_digest(&hasher.finalize()))
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(char::from_digit((byte >> 4) as u32, 16).unwrap_or('0'));
        result.push(char::from_digit((byte & 0x0f) as u32, 16).unwrap_or('0'));
    }
    result
}

fn normalized_sha256(value: &str) -> Option<String> {
    let value = value.trim().strip_prefix("sha256:").unwrap_or(value.trim());
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(value.to_ascii_lowercase())
}

pub fn validate_model_checksum(path: &Path, expected_sha256: &str) -> Result<ModelValidation, String> {
    let expected = normalized_sha256(expected_sha256)
        .ok_or_else(|| "El checksum SHA-256 debe tener 64 caracteres hexadecimales".to_string())?;
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("La ruta del modelo no es un archivo".into());
    }
    let actual = sha256_file(path)?;
    Ok(ModelValidation {
        path: path.to_string_lossy().into_owned(),
        size_bytes: metadata.len(),
        is_valid: actual == expected,
        actual_sha256: actual,
        expected_sha256: expected,
    })
}

/// Finalize a downloaded model only after its complete contents have been checked.
///
/// The temporary file must live beside the destination so that the final rename is an
/// atomic filesystem operation on Unix.  Every failed validation removes the temporary
/// file, ensuring that an interrupted or tampered download cannot be discovered as a
/// usable model later.
pub fn finalize_model_download(
    temporary: &Path,
    destination: &Path,
    expected_sha256: &str,
) -> Result<ModelValidation, String> {
    let result = (|| {
        let validation = validate_model_checksum(temporary, expected_sha256)?;
        if !validation.is_valid {
            return Err("El checksum SHA-256 del modelo descargado no coincide".into());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        atomic_install_file(temporary, destination)?;
        validate_model_checksum(destination, expected_sha256)
    })();

    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn atomic_install_file(source: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        // Windows does not replace an existing file with rename.  Keep the old
        // destination recoverable until the new, already-validated file is in place.
        let backup = destination.with_extension("bin.previous");
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| error.to_string())?;
        }
        let had_destination = destination.exists();
        if had_destination {
            fs::rename(destination, &backup).map_err(|error| error.to_string())?;
        }
        if let Err(error) = fs::rename(source, destination) {
            if had_destination {
                let _ = fs::rename(&backup, destination);
            }
            return Err(error.to_string());
        }
        if had_destination {
            let _ = fs::remove_file(backup);
        }
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        fs::rename(source, destination).map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub id: String,
    pub filename: String,
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub expected_sha256: Option<String>,
    pub is_valid: Option<bool>,
}

pub fn discover_models_in_dirs(directories: &[PathBuf]) -> Result<Vec<LocalModel>, String> {
    let mut seen = BTreeSet::new();
    let mut models = Vec::new();
    for directory in directories {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|extension| extension.to_str()) != Some("bin") {
                continue;
            }
            let filename = match path.file_name().and_then(|name| name.to_str()) {
                Some(filename) if filename.starts_with("ggml-") => filename.to_string(),
                _ => continue,
            };
            let canonical = fs::canonicalize(&path).unwrap_or(path.clone());
            if !seen.insert(canonical.clone()) {
                continue;
            }
            let metadata = fs::metadata(&canonical).map_err(|error| error.to_string())?;
            let actual = sha256_file(&canonical)?;
            let known = model_metadata_for_filename(&filename);
            if known.is_none() {
                continue;
            }
            let expected = known.as_ref().map(|model| model.sha256.clone());
            let is_valid = expected.as_ref().map(|value| value == &actual);
            let id = known
                .as_ref()
                .map(|model| model.id.clone())
                .unwrap_or_else(|| filename.trim_start_matches("ggml-").trim_end_matches(".bin").to_string());
            models.push(LocalModel {
                id,
                filename,
                path: canonical.to_string_lossy().into_owned(),
                size_bytes: metadata.len(),
                sha256: actual,
                expected_sha256: expected,
                is_valid,
            });
        }
    }
    models.sort_by(|left, right| left.filename.cmp(&right.filename));
    Ok(models)
}

#[derive(Debug, Clone)]
pub struct AppStoragePaths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub model_dirs: Vec<PathBuf>,
}

fn user_dir(primary: &str, fallback: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
    std::env::var_os(primary).map(PathBuf::from).or_else(fallback)
}

pub fn app_storage_paths() -> Result<AppStoragePaths, String> {
    #[cfg(windows)]
    let config_base = user_dir("APPDATA", || std::env::var_os("USERPROFILE").map(PathBuf::from));
    #[cfg(not(windows))]
    let config_base = user_dir("XDG_CONFIG_HOME", || {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config"))
    });

    #[cfg(windows)]
    let data_base = user_dir("LOCALAPPDATA", || std::env::var_os("APPDATA").map(PathBuf::from));
    #[cfg(not(windows))]
    let data_base = user_dir("XDG_DATA_HOME", || {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("share"))
    });

    let config_dir = config_base
        .map(|path| path.join("Chamu"))
        .ok_or_else(|| "No se encontró un directorio de configuración del usuario".to_string())?;
    let data_dir = data_base
        .map(|path| path.join("Chamu"))
        .ok_or_else(|| "No se encontró un directorio de datos del usuario".to_string())?;
    let mut model_dirs = vec![data_dir.join("models"), config_dir.join("models")];
    if let Ok(model_dir) = std::env::var("CHAMU_MODEL_DIR") {
        model_dirs.insert(0, PathBuf::from(model_dir));
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            model_dirs.push(parent.join("models"));
        }
    }
    Ok(AppStoragePaths {
        config_dir,
        data_dir,
        model_dirs,
    })
}

pub fn is_model_path_allowed(path: &Path, directories: &[PathBuf]) -> Result<bool, String> {
    let canonical_path = fs::canonicalize(path).map_err(|error| error.to_string())?;
    for directory in directories {
        let canonical_directory = match fs::canonicalize(directory) {
            Ok(directory) => directory,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        if canonical_path.starts_with(canonical_directory) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadPlan {
    pub model: ModelMetadata,
    pub status: String,
    pub network_required: bool,
    pub cancellation_supported: bool,
}

#[derive(Default, Clone)]
pub struct DownloadController {
    current: Arc<Mutex<Option<Arc<DownloadSession>>>>,
}

#[derive(Debug)]
struct DownloadSession {
    model_id: String,
    cancelled: AtomicBool,
    temporary_path: Mutex<Option<PathBuf>>,
}

impl DownloadController {
    pub fn begin(&self, model_id: &str) -> Result<ModelDownloadPlan, String> {
        let model = model_catalog()
            .into_iter()
            .find(|model| model.id == model_id)
            .ok_or_else(|| "Modelo no disponible".to_string())?;
        let mut current = self
            .current
            .lock()
            .map_err(|_| "No se pudo iniciar la descarga".to_string())?;
        if current.is_some() {
            return Err("Ya hay una descarga en curso".into());
        }
        *current = Some(Arc::new(DownloadSession {
            model_id: model.id.clone(),
            cancelled: AtomicBool::new(false),
            temporary_path: Mutex::new(None),
        }));
        Ok(ModelDownloadPlan {
            model,
            status: "planned".into(),
            network_required: true,
            cancellation_supported: true,
        })
    }

    pub fn cancel(&self) -> bool {
        let session = self.current.lock().ok().and_then(|current| current.clone());
        let Some(session) = session else {
            return false;
        };
        let was_cancelled = session.cancelled.swap(true, Ordering::AcqRel);
        if let Ok(mut temporary_path) = session.temporary_path.lock() {
            if let Some(path) = temporary_path.take() {
                let _ = fs::remove_file(path);
            }
        }
        !was_cancelled
    }

    pub fn is_cancelled(&self) -> bool {
        self.current
            .lock()
            .ok()
            .and_then(|current| current.clone())
            .map(|session| session.cancelled.load(Ordering::Acquire))
            .unwrap_or(false)
    }

    pub fn is_active(&self) -> bool {
        self.current
            .lock()
            .map(|current| current.is_some())
            .unwrap_or(true)
    }

    pub fn finish(&self, model_id: &str) {
        let session = self.current.lock().ok().and_then(|mut current| {
            if current
                .as_ref()
                .map(|session| session.model_id.as_str())
                == Some(model_id)
            {
                current.take()
            } else {
                None
            }
        });
        if let Some(session) = session {
            if let Ok(mut temporary_path) = session.temporary_path.lock() {
                if let Some(path) = temporary_path.take() {
                    let _ = fs::remove_file(path);
                }
            }
        }
    }

    pub fn set_temporary_path(&self, path: PathBuf) -> Result<(), String> {
        let session = self
            .current
            .lock()
            .map_err(|_| "No se pudo preparar la descarga".to_string())?
            .clone()
            .ok_or_else(|| "No hay una descarga en curso".to_string())?;
        if session.cancelled.load(Ordering::Acquire) {
            let _ = fs::remove_file(path);
            return Err("Descarga cancelada".into());
        }
        *session
            .temporary_path
            .lock()
            .map_err(|_| "No se pudo preparar la descarga".to_string())? = Some(path);
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordingPhase {
    Ready,
    Recording,
    Transcribing,
    Copied,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecordingToken(u64);

struct EphemeralAudioBuffer {
    samples: Vec<i16>,
}

impl Default for EphemeralAudioBuffer {
    fn default() -> Self {
        Self { samples: Vec::new() }
    }
}

impl EphemeralAudioBuffer {
    fn clear(&mut self) {
        for sample in &mut self.samples {
            *sample = 0;
        }
        self.samples.clear();
    }
}

impl Drop for EphemeralAudioBuffer {
    fn drop(&mut self) {
        self.clear();
    }
}

/// A short-lived owner for samples handed to the local transcription engine.
///
/// It is intentionally not serializable and is never reachable from a Tauri command.
/// Dropping it overwrites and releases the samples so recording cannot become a file or
/// history entry by accident.
pub struct AudioLease {
    samples: Vec<i16>,
}

impl AudioLease {
    pub fn len(&self) -> usize {
        self.samples.len()
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    pub fn as_slice(&self) -> &[i16] {
        &self.samples
    }
}

impl Drop for AudioLease {
    fn drop(&mut self) {
        for sample in &mut self.samples {
            *sample = 0;
        }
        self.samples.clear();
    }
}

pub struct RecordingLifecycle {
    phase: RecordingPhase,
    next_token: u64,
    active_token: Option<RecordingToken>,
    buffer: EphemeralAudioBuffer,
}

impl Default for RecordingLifecycle {
    fn default() -> Self {
        Self {
            phase: RecordingPhase::Ready,
            next_token: 0,
            active_token: None,
            buffer: EphemeralAudioBuffer::default(),
        }
    }
}

impl RecordingLifecycle {
    pub fn phase(&self) -> RecordingPhase {
        self.phase
    }

    pub fn start(&mut self) -> Result<RecordingToken, String> {
        if matches!(self.phase, RecordingPhase::Recording | RecordingPhase::Transcribing) {
            return Err("Ya hay un dictado en curso".into());
        }
        self.buffer.clear();
        self.next_token = self.next_token.wrapping_add(1).max(1);
        let token = RecordingToken(self.next_token);
        self.active_token = Some(token);
        self.phase = RecordingPhase::Recording;
        Ok(token)
    }

    pub fn append_samples(&mut self, token: RecordingToken, samples: &[i16]) -> Result<(), String> {
        if self.phase != RecordingPhase::Recording || self.active_token != Some(token) {
            return Err("La grabación ya no está activa".into());
        }
        self.buffer.samples.extend_from_slice(samples);
        Ok(())
    }

    pub fn finish(&mut self, token: RecordingToken) -> Result<AudioLease, String> {
        if self.phase != RecordingPhase::Recording || self.active_token != Some(token) {
            return Err("La grabación ya no está activa".into());
        }
        let samples = std::mem::take(&mut self.buffer.samples);
        self.active_token = None;
        self.phase = RecordingPhase::Transcribing;
        Ok(AudioLease { samples })
    }

    pub fn stop_without_audio(&mut self) -> Result<(), String> {
        if self.phase == RecordingPhase::Recording {
            let token = self
                .active_token
                .ok_or_else(|| "La grabación no tiene una sesión activa".to_string())?;
            let lease = self.finish(token)?;
            drop(lease);
        }
        Ok(())
    }

    pub fn mark_copied(&mut self) {
        self.buffer.clear();
        self.active_token = None;
        self.phase = RecordingPhase::Copied;
    }

    pub fn mark_ready(&mut self) {
        self.buffer.clear();
        self.active_token = None;
        self.phase = RecordingPhase::Ready;
    }

    pub fn mark_error(&mut self) {
        self.buffer.clear();
        self.active_token = None;
        self.phase = RecordingPhase::Error;
    }

    pub fn buffered_samples(&self) -> usize {
        self.buffer.samples.len()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PlatformEnvironment<'a> {
    pub os: &'a str,
    pub session_type: Option<&'a str>,
    pub current_desktop: Option<&'a str>,
    pub wayland_display: Option<&'a str>,
    pub x_display: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlatformSession {
    Windows,
    X11,
    Wayland,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Compositor {
    Gnome,
    Kde,
    Hyprland,
    Other,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DependencyCheck {
    pub name: String,
    pub available: bool,
    pub required: bool,
    pub install_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformDiagnosis {
    pub os: String,
    pub session: PlatformSession,
    pub compositor: Compositor,
    pub shortcut_method: String,
    pub paste_method: String,
    pub clipboard_available: bool,
    pub paste_available: bool,
    pub hold_mode_supported: bool,
    pub toggle_mode_supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wayland_portal_available: Option<bool>,
    pub dependencies: Vec<DependencyCheck>,
}

fn detect_compositor(desktop: Option<&str>) -> Compositor {
    let desktop = desktop.unwrap_or_default().to_ascii_lowercase();
    if desktop.contains("gnome") || desktop.split(':').any(|name| name == "unity") {
        Compositor::Gnome
    } else if desktop.contains("kde") || desktop.contains("plasma") {
        Compositor::Kde
    } else if desktop.contains("hyprland") {
        Compositor::Hyprland
    } else if desktop.is_empty() {
        Compositor::Unknown
    } else {
        Compositor::Other
    }
}

fn detect_session(environment: PlatformEnvironment<'_>) -> PlatformSession {
    if environment.os.eq_ignore_ascii_case("windows") {
        return PlatformSession::Windows;
    }
    let session = environment.session_type.unwrap_or_default().to_ascii_lowercase();
    if session == "wayland" || environment.wayland_display.is_some() {
        PlatformSession::Wayland
    } else if session == "x11" || environment.x_display.is_some() {
        PlatformSession::X11
    } else {
        PlatformSession::Unknown
    }
}

fn distro_install_hint(commands: &[&str]) -> Option<String> {
    if commands.is_empty() {
        return None;
    }
    let release = fs::read_to_string("/etc/os-release").unwrap_or_default().to_ascii_lowercase();
    let packages = commands.join(" ");
    if release.contains("debian") || release.contains("ubuntu") || release.contains("mint") {
        Some(format!("sudo apt install {packages}"))
    } else if release.contains("fedora") || release.contains("rhel") || release.contains("centos") {
        Some(format!("sudo dnf install {packages}"))
    } else if release.contains("arch") || release.contains("manjaro") {
        Some(format!("sudo pacman -S {packages}"))
    } else if release.contains("opensuse") || release.contains("suse") {
        Some(format!("sudo zypper install {packages}"))
    } else {
        Some(format!("Instala los paquetes: {packages}"))
    }
}

fn path_has_command(command: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(command);
        if candidate.is_file() {
            return true;
        }
        #[cfg(windows)]
        for extension in [".exe", ".cmd", ".bat"] {
            if directory.join(format!("{command}{extension}")).is_file() {
                return true;
            }
        }
    }
    false
}

pub fn command_available(command: &str) -> bool {
    path_has_command(command)
}

pub fn diagnose_platform() -> PlatformDiagnosis {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(unix) {
        "linux"
    } else {
        "unknown"
    };
    let session_type = std::env::var("XDG_SESSION_TYPE").ok();
    let current_desktop = std::env::var("XDG_CURRENT_DESKTOP")
        .ok()
        .or_else(|| std::env::var("DESKTOP_SESSION").ok())
        .or_else(|| std::env::var("GDMSESSION").ok())
        .or_else(|| std::env::var("KDE_FULL_SESSION").ok().map(|_| "KDE".into()))
        .or_else(|| {
            std::env::var("HYPRLAND_INSTANCE_SIGNATURE")
                .ok()
                .map(|_| "Hyprland".into())
        });
    let wayland_display = std::env::var("WAYLAND_DISPLAY").ok();
    let x_display = std::env::var("DISPLAY").ok();
    diagnose_platform_with(
        PlatformEnvironment {
            os,
            session_type: session_type.as_deref(),
            current_desktop: current_desktop.as_deref(),
            wayland_display: wayland_display.as_deref(),
            x_display: x_display.as_deref(),
        },
        path_has_command,
    )
}

pub fn diagnose_platform_with<F>(
    environment: PlatformEnvironment<'_>,
    command_exists: F,
) -> PlatformDiagnosis
where
    F: Fn(&str) -> bool,
{
    diagnose_platform_with_portal(environment, command_exists, None)
}

pub fn diagnose_platform_with_portal<F>(
    environment: PlatformEnvironment<'_>,
    command_exists: F,
    wayland_portal_available: Option<bool>,
) -> PlatformDiagnosis
where
    F: Fn(&str) -> bool,
{
    let session = detect_session(environment);
    let compositor = detect_compositor(environment.current_desktop);
    let mut dependencies = Vec::new();
    let (clipboard_available, paste_available, paste_method) = match session {
        PlatformSession::Windows => (true, true, "clipboard+send-input".into()),
        PlatformSession::X11 => {
            let xclip = command_exists("xclip");
            let xsel = command_exists("xsel");
            let clipboard = environment.x_display.is_some() && (xclip || xsel);
            dependencies.push(DependencyCheck {
                name: "xclip o xsel".into(),
                available: xclip || xsel,
                required: true,
                install_hint: (!xclip && !xsel)
                    .then(|| distro_install_hint(&["xclip"]).unwrap_or_default()),
            });
            let method = if xclip {
                "clipboard+xclip"
            } else if xsel {
                "clipboard+xsel"
            } else {
                "unavailable"
            };
            (clipboard, clipboard, method.into())
        }
        PlatformSession::Wayland => {
            let wl_copy = command_exists("wl-copy");
            let wl_paste = command_exists("wl-paste");
            let wl_clipboard = wl_copy && wl_paste;
            dependencies.push(DependencyCheck {
                name: "wl-clipboard (wl-copy/wl-paste)".into(),
                available: wl_clipboard,
                required: true,
                install_hint: if compositor == Compositor::Gnome {
                    None
                } else {
                    (!wl_clipboard)
                        .then(|| distro_install_hint(&["wl-clipboard"]).unwrap_or_default())
                },
            });
            if compositor == Compositor::Gnome {
                (
                    wl_clipboard,
                    wl_clipboard,
                    "Extensión GNOME Shell Chamu".into(),
                )
            } else {
                let method = if wl_clipboard {
                    "wl-clipboard"
                } else {
                    "unavailable"
                };
                (wl_clipboard, false, method.into())
            }
        }
        PlatformSession::Unknown => (false, false, "unavailable".into()),
    };

    let (shortcut_method, hold_mode_supported, toggle_mode_supported) = match session {
        PlatformSession::Windows => ("windows-global-hook".into(), true, true),
        PlatformSession::X11 => ("x11-global-hook".into(), true, true),
        PlatformSession::Wayland => match wayland_portal_available {
            Some(true) => ("xdg-global-shortcuts-portal".into(), true, true),
            Some(false) => ("xdg-global-shortcuts-portal (no disponible)".into(), false, true),
            None => ("xdg-global-shortcuts-portal".into(), false, true),
        },
        PlatformSession::Unknown => ("unavailable".into(), false, false),
    };

    PlatformDiagnosis {
        os: environment.os.to_ascii_lowercase(),
        session,
        compositor,
        shortcut_method,
        paste_method,
        clipboard_available,
        paste_available,
        hold_mode_supported,
        toggle_mode_supported,
        wayland_portal_available,
        dependencies,
    }
}

static DIAGNOSTIC_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticRecord {
    pub session_id: String,
    pub recorded_at: i64,
    pub shortcut: String,
    pub platform_session: PlatformSession,
    pub compositor: Compositor,
    pub capture_method: String,
    pub paste_method: String,
    pub clipboard_available: bool,
    pub paste_available: bool,
    pub dependencies: Vec<DependencyCheck>,
}

impl DiagnosticRecord {
    pub fn from_diagnosis(shortcut: String, session_id: String, diagnosis: &PlatformDiagnosis) -> Self {
        Self {
            session_id,
            recorded_at: now_unix_millis(),
            shortcut,
            platform_session: diagnosis.session,
            compositor: diagnosis.compositor,
            capture_method: diagnosis.shortcut_method.clone(),
            paste_method: diagnosis.paste_method.clone(),
            clipboard_available: diagnosis.clipboard_available,
            paste_available: diagnosis.paste_available,
            dependencies: diagnosis.dependencies.clone(),
        }
    }

    pub fn new_session_id() -> String {
        let sequence = DIAGNOSTIC_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        format!("{}-{sequence}", now_unix_millis())
    }
}

pub fn append_diagnostic(path: &Path, record: &DiagnosticRecord) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let line = serde_json::to_string(record)
        .map_err(|error| format!("No se pudo serializar el diagnóstico: {error}"))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(line.as_bytes()).map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    file.sync_data().map_err(|error| error.to_string())?;
    set_private_permissions(path);
    Ok(())
}

pub fn load_diagnostics(path: &Path) -> Result<Vec<DiagnosticRecord>, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    contents
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(|error| error.to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("chamu-native-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create test root");
        root
    }

    #[test]
    fn settings_round_trip_persists_only_valid_values() {
        let root = test_root("settings");
        let path = root.join("settings.json");
        let expected = AppSettings {
            language: "en".into(),
            mode: "toggle".into(),
            shortcut: "Ctrl+Space".into(),
            model_id: "small".into(),
        };

        save_settings_file(&path, &expected).expect("save settings");
        assert_eq!(load_settings_file(&path).expect("load settings"), expected);
        assert!(validate_settings(&AppSettings {
            language: "fr".into(),
            ..expected
        })
        .is_err());
    }

    #[test]
    fn model_catalog_exposes_the_closed_whisper_selection() {
        let catalog = serde_json::to_value(model_catalog()).expect("serialize model catalog");
        assert_eq!(catalog.as_array().expect("catalog array").len(), 3);

        assert_eq!(catalog[0]["id"], "base");
        assert_eq!(catalog[0]["label"], "Liviano");
        assert_eq!(catalog[0]["filename"], "ggml-base.bin");
        assert_eq!(catalog[0]["sizeBytes"], 147_951_465_u64);
        assert_eq!(
            catalog[0]["downloadUrl"],
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
        );
        assert_eq!(
            catalog[0]["sha256"],
            "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"
        );

        assert_eq!(catalog[1]["id"], "small");
        assert_eq!(catalog[1]["label"], "Predeterminado");
        assert_eq!(catalog[1]["filename"], "ggml-small.bin");
        assert_eq!(catalog[1]["sizeBytes"], 487_601_967_u64);
        assert_eq!(
            catalog[1]["downloadUrl"],
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
        );
        assert_eq!(
            catalog[1]["sha256"],
            "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"
        );

        assert_eq!(catalog[2]["id"], "large-v3-turbo-q5_0");
        assert_eq!(catalog[2]["label"], "Calidad");
        assert_eq!(catalog[2]["filename"], "ggml-large-v3-turbo-q5_0.bin");
        assert_eq!(catalog[2]["sizeBytes"], 574_041_195_u64);
        assert_eq!(
            catalog[2]["downloadUrl"],
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
        );
        assert_eq!(
            catalog[2]["sha256"],
            "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"
        );
    }

    #[test]
    fn old_settings_without_model_id_migrate_to_base() {
        let root = test_root("settings-migration");
        let path = root.join("settings.json");
        fs::write(
            &path,
            r#"{"language":"es","mode":"hold","shortcut":"Ctrl+Space"}"#,
        )
        .expect("write old settings");

        let settings = load_settings_file(&path).expect("load old settings");
        let json = serde_json::to_value(settings).expect("serialize migrated settings");
        assert_eq!(json["modelId"], "base");
    }

    #[test]
    fn new_settings_default_to_small_model() {
        let json = serde_json::to_value(AppSettings::default()).expect("serialize defaults");
        assert_eq!(json["modelId"], "small");
    }

    #[test]
    fn model_path_policy_rejects_catalog_named_files_outside_model_dirs() {
        let root = test_root("model-path-policy");
        let allowed = root.join("allowed");
        let outside = root.join("outside");
        fs::create_dir_all(&allowed).expect("create allowed directory");
        fs::create_dir_all(&outside).expect("create outside directory");
        let allowed_model = allowed.join("ggml-small.bin");
        let outside_model = outside.join("ggml-small.bin");
        fs::write(&allowed_model, b"model").expect("write allowed model");
        fs::write(&outside_model, b"model").expect("write outside model");

        assert!(is_model_path_allowed(&allowed_model, &[allowed]).expect("check allowed path"));
        assert!(!is_model_path_allowed(&outside_model, &[root.join("allowed")])
            .expect("check outside path"));
    }

    #[test]
    fn history_keeps_text_and_timestamp_and_supports_deletion() {
        let root = test_root("history");
        let mut history = HistoryStore::open(root.join("history.sqlite3")).expect("open db");
        let id = history
            .insert("texto local".into(), 1_700_000_000_000)
            .expect("insert");
        let entries = history.list(10).expect("list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].text, "texto local");
        assert_eq!(entries[0].timestamp, 1_700_000_000_000);
        assert_eq!(history.text_by_id(id).expect("lookup"), Some("texto local".into()));
        assert_eq!(history.text_by_id(id + 1).expect("missing lookup"), None);
        history.delete(id).expect("delete");
        assert!(history.list(10).expect("list after delete").is_empty());
    }

    #[test]
    fn model_checksum_accepts_expected_sha256_and_rejects_tampering() {
        let root = test_root("model");
        let path = root.join("ggml-base.bin");
        fs::write(&path, b"model bytes").expect("write model");
        let expected = sha256_file(&path).expect("hash");
        assert!(validate_model_checksum(&path, &expected).expect("validate").is_valid);
        assert!(!validate_model_checksum(
            &path,
            "0000000000000000000000000000000000000000000000000000000000000000"
        )
        .expect("validate")
        .is_valid);
    }

    #[test]
    fn model_discovery_reports_known_models_without_persisting_audio() {
        let root = test_root("discovery");
        fs::write(root.join("ggml-base.bin"), b"not the model").expect("write model");
        fs::write(root.join("recording.wav"), b"audio").expect("write unrelated file");
        let models = discover_models_in_dirs(&[root]).expect("discover models");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "base");
        assert_eq!(models[0].expected_sha256.as_deref(), Some(MODEL_BASE_SHA256));
        assert_eq!(models[0].is_valid, Some(false));
    }

    #[test]
    fn model_download_controller_only_plans_and_can_cancel() {
        let controller = DownloadController::default();
        let plan = controller.begin("base").expect("plan model download");
        assert_eq!(plan.status, "planned");
        assert!(plan.network_required);
        assert!(plan.cancellation_supported);
        assert!(controller.cancel());
        assert!(controller.is_cancelled());
        assert!(!controller.cancel());
    }

    #[test]
    fn model_download_controller_rejects_overlapping_downloads() {
        let controller = DownloadController::default();
        controller.begin("base").expect("begin first download");

        let error = controller
            .begin("base")
            .expect_err("same model cannot be downloaded twice");
        assert!(error.contains("curso"));
    }

    #[test]
    fn cancelling_model_download_removes_partial_temp_file() {
        let root = test_root("model-cancel");
        let temporary = root.join("ggml-base.bin.part");
        fs::write(&temporary, b"partial model").expect("write partial model");
        let controller = DownloadController::default();
        controller.begin("base").expect("begin model download");
        controller
            .set_temporary_path(temporary.clone())
            .expect("track temporary model");

        assert!(controller.cancel());
        assert!(!temporary.exists());
    }

    #[test]
    fn finalize_model_download_validates_then_atomically_installs_and_removes_temp() {
        let root = test_root("model-finalize");
        let temporary = root.join("ggml-base.bin.part");
        let destination = root.join("ggml-base.bin");
        fs::write(&temporary, b"complete model").expect("write temporary model");
        let expected = sha256_file(&temporary).expect("hash temporary model");

        let validation = finalize_model_download(&temporary, &destination, &expected)
            .expect("finalize model download");

        assert!(validation.is_valid);
        assert!(!temporary.exists());
        assert_eq!(fs::read(&destination).expect("read installed model"), b"complete model");
    }

    #[test]
    fn finalize_model_download_rejects_bad_checksum_without_installing_partial_file() {
        let root = test_root("model-finalize-bad-checksum");
        let temporary = root.join("ggml-base.bin.part");
        let destination = root.join("ggml-base.bin");
        fs::write(&temporary, b"tampered model").expect("write temporary model");

        let error = finalize_model_download(
            &temporary,
            &destination,
            "0000000000000000000000000000000000000000000000000000000000000000",
        )
        .expect_err("tampered model must be rejected");

        assert!(error.contains("checksum"));
        assert!(!temporary.exists());
        assert!(!destination.exists());
    }

    #[test]
    fn recording_lifecycle_drops_audio_when_transcription_begins() {
        let mut lifecycle = RecordingLifecycle::default();
        let token = lifecycle.start().expect("start");
        lifecycle.append_samples(token, &[1, 2, 3]).expect("append");
        let lease = lifecycle.finish(token).expect("finish");
        assert_eq!(lease.len(), 3);
        assert_eq!(lifecycle.buffered_samples(), 0);
        drop(lease);
        assert_eq!(lifecycle.phase(), RecordingPhase::Transcribing);
    }

    #[test]
    fn wayland_diagnosis_requires_clipboard_and_one_injector() {
        let diagnosis = diagnose_platform_with(
            PlatformEnvironment {
                os: "linux",
                session_type: Some("wayland"),
                current_desktop: Some("GNOME"),
                wayland_display: Some("wayland-0"),
                x_display: None,
            },
            |_command| false,
        );
        assert_eq!(diagnosis.session, PlatformSession::Wayland);
        assert_eq!(diagnosis.compositor, Compositor::Gnome);
        assert!(!diagnosis.clipboard_available);
        assert!(!diagnosis.paste_available);
        assert!(!diagnosis.hold_mode_supported);
    }

    #[test]
    fn gnome_wayland_does_not_require_ydotool() {
        let diagnosis = diagnose_platform_with(
            PlatformEnvironment {
                os: "linux",
                session_type: Some("wayland"),
                current_desktop: Some("GNOME"),
                wayland_display: Some("wayland-0"),
                x_display: None,
            },
            |_command| false,
        );

        assert_eq!(diagnosis.compositor, Compositor::Gnome);
        assert_eq!(diagnosis.paste_method, "Extensión GNOME Shell Chamu");
        assert!(!diagnosis
            .dependencies
            .iter()
            .any(|item| item.name == "ydotool"));
        assert!(diagnosis.dependencies.iter().all(|item| {
            item.install_hint
                .as_deref()
                .map_or(true, |hint| !hint.contains("sudo"))
        }));
    }

    #[test]
    fn unity_is_recognized_as_gnome() {
        assert_eq!(detect_compositor(Some("Unity")), Compositor::Gnome);
    }

    #[test]
    fn wayland_keeps_clipboard_when_ydotool_is_missing() {
        let diagnosis = diagnose_platform_with(
            PlatformEnvironment {
                os: "linux",
                session_type: Some("wayland"),
                current_desktop: Some("Sway"),
                wayland_display: Some("wayland-0"),
                x_display: None,
            },
            |command| matches!(command, "wl-copy" | "wl-paste"),
        );

        assert!(diagnosis.clipboard_available);
        assert!(!diagnosis.paste_available);
        assert_eq!(diagnosis.paste_method, "wl-clipboard");
    }

    #[test]
    fn wayland_diagnosis_reports_portal_backend_only_when_probe_succeeds() {
        let environment = PlatformEnvironment {
            os: "linux",
            session_type: Some("wayland"),
            current_desktop: Some("GNOME"),
            wayland_display: Some("wayland-0"),
            x_display: None,
        };
        let available = diagnose_platform_with_portal(environment, |_command| false, Some(true));
        assert_eq!(available.shortcut_method, "xdg-global-shortcuts-portal");
        assert!(available.hold_mode_supported);
        assert_eq!(available.wayland_portal_available, Some(true));

        let unavailable = diagnose_platform_with_portal(environment, |_command| false, Some(false));
        assert_eq!(unavailable.shortcut_method, "xdg-global-shortcuts-portal (no disponible)");
        assert!(!unavailable.hold_mode_supported);
        assert_eq!(unavailable.wayland_portal_available, Some(false));
    }

    #[test]
    fn diagnostic_record_contains_no_text_or_audio_fields() {
        let diagnosis = diagnose_platform_with(
            PlatformEnvironment {
                os: "linux",
                session_type: Some("x11"),
                current_desktop: Some("KDE"),
                wayland_display: None,
                x_display: Some(":0"),
            },
            |_command| true,
        );
        let record = DiagnosticRecord::from_diagnosis(
            "Ctrl+Super".into(),
            "session-1".into(),
            &diagnosis,
        );
        let json = serde_json::to_string(&record).expect("serialize diagnostic");
        assert!(!json.contains("audio"));
        assert!(!json.contains("texto"));
        assert!(json.contains("Ctrl+Super"));
    }

    #[test]
    fn diagnostic_records_round_trip_as_local_jsonl() {
        let root = test_root("diagnostics");
        let diagnosis = diagnose_platform_with(
            PlatformEnvironment {
                os: "windows",
                session_type: None,
                current_desktop: None,
                wayland_display: None,
                x_display: None,
            },
            |_command| false,
        );
        let record = DiagnosticRecord::from_diagnosis(
            "Ctrl+Space".into(),
            "session-2".into(),
            &diagnosis,
        );
        let path = root.join("diagnostics.jsonl");
        append_diagnostic(&path, &record).expect("append diagnostic");
        let records = load_diagnostics(&path).expect("load diagnostics");
        assert_eq!(records, vec![record]);
    }
}
