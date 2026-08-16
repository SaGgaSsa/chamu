//! Bounded, local-only building blocks for the dictation pipeline.
//!
//! This module is deliberately independent from Tauri and third-party crates.  It
//! owns no native microphone or global shortcut implementation; callers provide
//! captured PCM frames and explicitly choose the platform adapters below.  Audio
//! is kept in memory and handed to whisper.cpp through stdin.

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

/// A supported PCM format for an in-memory capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioFormat {
    sample_rate: u32,
    channels: u16,
}

impl AudioFormat {
    pub fn new(sample_rate: u32, channels: u16) -> Result<Self, CaptureError> {
        if !(8_000..=384_000).contains(&sample_rate) {
            return Err(CaptureError::InvalidFormat {
                sample_rate,
                channels,
            });
        }
        if channels == 0 || channels > 8 {
            return Err(CaptureError::InvalidFormat {
                sample_rate,
                channels,
            });
        }
        Ok(Self {
            sample_rate,
            channels,
        })
    }

    pub fn sample_rate(self) -> u32 {
        self.sample_rate
    }

    pub fn channels(self) -> u16 {
        self.channels
    }
}

/// Errors from the intentionally small in-memory capture state machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureError {
    InvalidFormat { sample_rate: u32, channels: u16 },
    InvalidCapacity,
    AlreadyRecording,
    NotRecording,
    CapacityExceeded { requested: usize, available: usize },
    WavTooLarge,
}

impl fmt::Display for CaptureError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFormat {
                sample_rate,
                channels,
            } => write!(formatter, "formato PCM no válido ({sample_rate} Hz, {channels} canales)"),
            Self::InvalidCapacity => write!(formatter, "la capacidad de captura debe ser mayor que cero"),
            Self::AlreadyRecording => write!(formatter, "ya hay una captura en curso"),
            Self::NotRecording => write!(formatter, "no hay una captura en curso"),
            Self::CapacityExceeded {
                requested,
                available,
            } => write!(
                formatter,
                "la captura excedería su límite ({requested} muestras solicitadas, {available} disponibles)"
            ),
            Self::WavTooLarge => write!(formatter, "la captura es demasiado grande para un WAV PCM"),
        }
    }
}

impl std::error::Error for CaptureError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureState {
    Idle,
    Recording,
}

/// An audio owner that never writes samples to disk.
pub struct InMemoryAudioCapture {
    format: AudioFormat,
    max_samples: usize,
    state: CaptureState,
    samples: Vec<i16>,
}

impl InMemoryAudioCapture {
    pub fn new(format: AudioFormat, max_samples: usize) -> Result<Self, CaptureError> {
        if max_samples == 0 {
            return Err(CaptureError::InvalidCapacity);
        }
        Ok(Self {
            format,
            max_samples,
            state: CaptureState::Idle,
            samples: Vec::new(),
        })
    }

    pub fn format(&self) -> AudioFormat {
        self.format
    }

    pub fn state(&self) -> CaptureState {
        self.state
    }

    pub fn sample_count(&self) -> usize {
        self.samples.len()
    }

    pub fn start(&mut self) -> Result<(), CaptureError> {
        if self.state == CaptureState::Recording {
            return Err(CaptureError::AlreadyRecording);
        }
        self.clear_samples();
        self.state = CaptureState::Recording;
        Ok(())
    }

    pub fn push_samples(&mut self, samples: &[i16]) -> Result<(), CaptureError> {
        if self.state != CaptureState::Recording {
            return Err(CaptureError::NotRecording);
        }
        let available = self.max_samples.saturating_sub(self.samples.len());
        if samples.len() > available {
            return Err(CaptureError::CapacityExceeded {
                requested: samples.len(),
                available,
            });
        }
        self.samples.extend_from_slice(samples);
        Ok(())
    }

    /// Ends the capture and transfers the samples to another short-lived owner.
    pub fn finish(&mut self) -> Result<AudioBuffer, CaptureError> {
        if self.state != CaptureState::Recording {
            return Err(CaptureError::NotRecording);
        }
        self.state = CaptureState::Idle;
        Ok(AudioBuffer {
            format: self.format,
            samples: std::mem::take(&mut self.samples),
        })
    }

    /// Cancelling is idempotent so error paths can always call it.
    pub fn cancel(&mut self) -> Result<(), CaptureError> {
        self.clear_samples();
        self.state = CaptureState::Idle;
        Ok(())
    }

    fn clear_samples(&mut self) {
        for sample in &mut self.samples {
            *sample = 0;
        }
        self.samples.clear();
    }
}

impl Drop for InMemoryAudioCapture {
    fn drop(&mut self) {
        self.clear_samples();
    }
}

/// Captured PCM handed to a local process.  It is not serializable and is cleared
/// when dropped, so it cannot accidentally become history or a diagnostic record.
pub struct AudioBuffer {
    format: AudioFormat,
    samples: Vec<i16>,
}

impl AudioBuffer {
    /// Creates a short-lived PCM owner from an in-memory capture adapter.
    pub fn from_pcm(format: AudioFormat, samples: Vec<i16>) -> Self {
        Self { format, samples }
    }

    pub fn format(&self) -> AudioFormat {
        self.format
    }

    pub fn samples(&self) -> &[i16] {
        &self.samples
    }

    pub fn sample_count(&self) -> usize {
        self.samples.len()
    }

    /// Encodes PCM16 WAV bytes in memory for whisper.cpp stdin.
    pub fn to_wav_bytes(&self) -> Result<Vec<u8>, CaptureError> {
        let data_size = self
            .samples
            .len()
            .checked_mul(2)
            .and_then(|size| u32::try_from(size).ok())
            .ok_or(CaptureError::WavTooLarge)?;
        let riff_size = 36_u32
            .checked_add(data_size)
            .ok_or(CaptureError::WavTooLarge)?;
        let block_align = self
            .format
            .channels
            .checked_mul(2)
            .ok_or(CaptureError::WavTooLarge)?;
        let byte_rate = self
            .format
            .sample_rate
            .checked_mul(u32::from(block_align))
            .ok_or(CaptureError::WavTooLarge)?;

        let mut wav = Vec::with_capacity(44 + data_size as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&riff_size.to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes()); // PCM fmt chunk length
        wav.extend_from_slice(&1_u16.to_le_bytes()); // PCM format
        wav.extend_from_slice(&self.format.channels.to_le_bytes());
        wav.extend_from_slice(&self.format.sample_rate.to_le_bytes());
        wav.extend_from_slice(&byte_rate.to_le_bytes());
        wav.extend_from_slice(&block_align.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes()); // bits per sample
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());
        for sample in &self.samples {
            wav.extend_from_slice(&sample.to_le_bytes());
        }
        Ok(wav)
    }
}

impl Drop for AudioBuffer {
    fn drop(&mut self) {
        for sample in &mut self.samples {
            *sample = 0;
        }
        self.samples.clear();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    Spanish,
    English,
}

impl Language {
    pub fn whisper_code(self) -> &'static str {
        match self {
            Self::Spanish => "es",
            Self::English => "en",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WhisperConfigError {
    ModelNotFound(PathBuf),
    ModelNotFile(PathBuf),
    ModelChecksumNotValidated(PathBuf),
    ModelCanonicalize { path: PathBuf, error: String },
    ExecutableNotFound(PathBuf),
    ExecutableNotFile(PathBuf),
    ExecutableNotExecutable(PathBuf),
    ExecutableCanonicalize { path: PathBuf, error: String },
}

impl fmt::Display for WhisperConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ModelNotFound(path) => {
                write!(formatter, "no se encontró el modelo: {}", path.display())
            }
            Self::ModelNotFile(path) => {
                write!(formatter, "el modelo no es un archivo: {}", path.display())
            }
            Self::ModelChecksumNotValidated(path) => write!(
                formatter,
                "el modelo no fue validado con SHA-256: {}",
                path.display()
            ),
            Self::ModelCanonicalize { path, error } => {
                write!(
                    formatter,
                    "no se pudo validar el modelo {}: {error}",
                    path.display()
                )
            }
            Self::ExecutableNotFound(path) => {
                write!(
                    formatter,
                    "no se encontró el ejecutable local: {}",
                    path.display()
                )
            }
            Self::ExecutableNotFile(path) => {
                write!(
                    formatter,
                    "el ejecutable no es un archivo: {}",
                    path.display()
                )
            }
            Self::ExecutableNotExecutable(path) => {
                write!(
                    formatter,
                    "el archivo no se puede ejecutar: {}",
                    path.display()
                )
            }
            Self::ExecutableCanonicalize { path, error } => {
                write!(
                    formatter,
                    "no se pudo validar el ejecutable {}: {error}",
                    path.display()
                )
            }
        }
    }
}

impl std::error::Error for WhisperConfigError {}

/// A path that has been checked to be a regular local file.  The caller should
/// create it only after the model checksum has been verified by `core`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedModelPath {
    path: PathBuf,
}

impl ValidatedModelPath {
    pub fn new(path: impl AsRef<Path>) -> Result<Self, WhisperConfigError> {
        let path = path.as_ref().to_path_buf();
        if !path.exists() {
            return Err(WhisperConfigError::ModelNotFound(path));
        }
        if !path.is_file() {
            return Err(WhisperConfigError::ModelNotFile(path));
        }
        let canonical =
            fs::canonicalize(&path).map_err(|error| WhisperConfigError::ModelCanonicalize {
                path: path.clone(),
                error: error.to_string(),
            })?;
        Ok(Self { path: canonical })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Bridges the checksum result from `core::validate_model_checksum` without
    /// pulling a hashing dependency into this module.  A false result is rejected
    /// before whisper.cpp can be started.
    pub fn from_checksum_validation(
        path: impl AsRef<Path>,
        checksum_valid: bool,
    ) -> Result<Self, WhisperConfigError> {
        let path = path.as_ref();
        if !checksum_valid {
            return Err(WhisperConfigError::ModelChecksumNotValidated(
                path.to_path_buf(),
            ));
        }
        Self::new(path)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WhisperTranscriberConfig {
    executable: PathBuf,
    model: ValidatedModelPath,
    language: Language,
}

impl WhisperTranscriberConfig {
    pub fn new(
        executable: impl AsRef<Path>,
        model_path: impl AsRef<Path>,
        language: Language,
    ) -> Result<Self, WhisperConfigError> {
        Self::from_validated_model(executable, ValidatedModelPath::new(model_path)?, language)
    }

    pub fn from_validated_model(
        executable: impl AsRef<Path>,
        model: ValidatedModelPath,
        language: Language,
    ) -> Result<Self, WhisperConfigError> {
        Ok(Self {
            executable: resolve_executable(executable.as_ref())?,
            model,
            language,
        })
    }

    pub fn executable(&self) -> &Path {
        &self.executable
    }

    pub fn model(&self) -> &ValidatedModelPath {
        &self.model
    }

    pub fn language(&self) -> Language {
        self.language
    }

    pub fn invocation(&self) -> CommandInvocation {
        CommandInvocation {
            program: self.executable.clone(),
            args: vec![
                OsString::from("-m"),
                self.model.path.clone().into_os_string(),
                OsString::from("-l"),
                OsString::from(self.language.whisper_code()),
                OsString::from("-f"),
                OsString::from("-"),
                OsString::from("--no-timestamps"),
            ],
            stdin_required: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandInvocation {
    program: PathBuf,
    args: Vec<OsString>,
    stdin_required: bool,
}

impl CommandInvocation {
    pub fn program(&self) -> &Path {
        &self.program
    }

    pub fn args(&self) -> &[OsString] {
        &self.args
    }

    pub fn stdin_required(&self) -> bool {
        self.stdin_required
    }
}

fn resolve_executable(path: &Path) -> Result<PathBuf, WhisperConfigError> {
    if path.is_file() {
        return canonical_executable(path);
    }
    // A command without a directory is allowed when it resolves through PATH.
    if path.components().count() == 1 {
        if let Some(path) = find_command(path.as_os_str()) {
            return canonical_executable(&path);
        }
        return Err(WhisperConfigError::ExecutableNotFound(path.to_path_buf()));
    }
    if path.exists() {
        return Err(WhisperConfigError::ExecutableNotFile(path.to_path_buf()));
    }
    Err(WhisperConfigError::ExecutableNotFound(path.to_path_buf()))
}

fn canonical_executable(path: &Path) -> Result<PathBuf, WhisperConfigError> {
    if !path.is_file() {
        return Err(WhisperConfigError::ExecutableNotFile(path.to_path_buf()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)
            .map_err(|error| WhisperConfigError::ExecutableCanonicalize {
                path: path.to_path_buf(),
                error: error.to_string(),
            })?
            .permissions()
            .mode();
        if mode & 0o111 == 0 {
            return Err(WhisperConfigError::ExecutableNotExecutable(
                path.to_path_buf(),
            ));
        }
    }
    fs::canonicalize(path).map_err(|error| WhisperConfigError::ExecutableCanonicalize {
        path: path.to_path_buf(),
        error: error.to_string(),
    })
}

fn find_command(command: &OsStr) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(command);
        if candidate.is_file() && is_executable_file(&candidate) {
            return Some(candidate);
        }
        #[cfg(windows)]
        for extension in [".exe", ".cmd", ".bat"] {
            let candidate = directory.join(format!("{}{}", command.to_string_lossy(), extension));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return fs::metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranscriptionError {
    Audio(CaptureError),
    StdinUnavailable,
    Spawn { executable: PathBuf, error: String },
    WriteStdin(String),
    Wait(String),
    ProcessFailed { code: Option<i32>, stderr: String },
    EmptyOutput,
}

impl fmt::Display for TranscriptionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Audio(error) => write!(formatter, "no se pudo preparar el audio: {error}"),
            Self::StdinUnavailable => write!(formatter, "whisper.cpp no abrió stdin para el audio"),
            Self::Spawn { executable, error } => {
                write!(
                    formatter,
                    "no se pudo iniciar {}: {error}",
                    executable.display()
                )
            }
            Self::WriteStdin(error) => write!(
                formatter,
                "no se pudo entregar el audio a whisper.cpp: {error}"
            ),
            Self::Wait(error) => write!(formatter, "no se pudo esperar a whisper.cpp: {error}"),
            Self::ProcessFailed { code, stderr } => {
                write!(
                    formatter,
                    "whisper.cpp terminó con código {code:?}: {stderr}"
                )
            }
            Self::EmptyOutput => write!(formatter, "whisper.cpp no devolvió texto"),
        }
    }
}

impl std::error::Error for TranscriptionError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transcription {
    text: String,
}

impl Transcription {
    pub fn text(&self) -> &str {
        &self.text
    }
}

pub struct WhisperTranscriber {
    config: WhisperTranscriberConfig,
}

impl WhisperTranscriber {
    pub fn new(config: WhisperTranscriberConfig) -> Result<Self, WhisperConfigError> {
        // Revalidate both files at the boundary: onboarding can remove or replace
        // a model between selecting it and starting a dictation.
        let config = WhisperTranscriberConfig::new(
            &config.executable,
            config.model.path(),
            config.language,
        )?;
        Ok(Self { config })
    }

    pub fn config(&self) -> &WhisperTranscriberConfig {
        &self.config
    }

    pub fn transcribe(&self, audio: &AudioBuffer) -> Result<Transcription, TranscriptionError> {
        let wav = audio.to_wav_bytes().map_err(TranscriptionError::Audio)?;
        let invocation = self.config.invocation();
        let mut process = Command::new(&invocation.program);
        process
            .args(&invocation.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = process.spawn().map_err(|error| TranscriptionError::Spawn {
            executable: invocation.program.clone(),
            error: error.to_string(),
        })?;
        let write_result = child
            .stdin
            .as_mut()
            .ok_or(TranscriptionError::StdinUnavailable)
            .and_then(|stdin| {
                stdin
                    .write_all(&wav)
                    .map_err(|error| TranscriptionError::WriteStdin(error.to_string()))
            });
        if let Err(error) = write_result {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        // Closing stdin signals end-of-audio to readers that consume stdin.
        child.stdin.take();
        let output = child
            .wait_with_output()
            .map_err(|error| TranscriptionError::Wait(error.to_string()))?;
        if !output.status.success() {
            return Err(TranscriptionError::ProcessFailed {
                code: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if text.is_empty() {
            return Err(TranscriptionError::EmptyOutput);
        }
        Ok(Transcription { text })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    program: PathBuf,
    args: Vec<OsString>,
    stdin_required: bool,
}

impl CommandSpec {
    pub fn new(program: impl Into<PathBuf>, args: Vec<OsString>, stdin_required: bool) -> Self {
        Self {
            program: program.into(),
            args,
            stdin_required,
        }
    }

    pub fn program(&self) -> &Path {
        &self.program
    }

    pub fn args(&self) -> &[OsString] {
        &self.args
    }

    pub fn stdin_required(&self) -> bool {
        self.stdin_required
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PastePlatform {
    Windows,
    X11,
    Wayland,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardProvider {
    WindowsClip,
    Xclip,
    Xsel,
    WlClipboard,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteInjector {
    WindowsSendKeys,
    Xdotool,
    Wtype,
    Ydotool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PasteError {
    UnsupportedPlatform(PastePlatform),
    MissingDependency {
        command: String,
        operation: String,
        hint: String,
    },
    ClipboardSpawn {
        command: String,
        error: String,
    },
    ClipboardWrite {
        command: String,
        error: String,
    },
    ClipboardFailed {
        command: String,
        code: Option<i32>,
        stderr: String,
    },
    InjectorSpawn {
        command: String,
        error: String,
    },
    InjectorFailed {
        command: String,
        code: Option<i32>,
        stderr: String,
    },
}

impl fmt::Display for PasteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedPlatform(platform) => {
                write!(formatter, "plataforma no soportada: {platform:?}")
            }
            Self::MissingDependency {
                command,
                operation,
                hint,
            } => write!(formatter, "falta {command} para {operation}. {hint}"),
            Self::ClipboardSpawn { command, error } => {
                write!(
                    formatter,
                    "no se pudo iniciar el portapapeles {command}: {error}"
                )
            }
            Self::ClipboardWrite { command, error } => {
                write!(
                    formatter,
                    "no se pudo escribir en el portapapeles {command}: {error}"
                )
            }
            Self::ClipboardFailed {
                command,
                code,
                stderr,
            } => write!(
                formatter,
                "el portapapeles {command} terminó con código {code:?}: {stderr}"
            ),
            Self::InjectorSpawn { command, error } => {
                write!(formatter, "no se pudo iniciar el pegado {command}: {error}")
            }
            Self::InjectorFailed {
                command,
                code,
                stderr,
            } => write!(
                formatter,
                "el pegado {command} terminó con código {code:?}: {stderr}"
            ),
        }
    }
}

impl std::error::Error for PasteError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PasteOutcome {
    pub clipboard: ClipboardProvider,
    pub injector: PasteInjector,
}

#[derive(Debug)]
pub struct PastePipeline {
    platform: PastePlatform,
    clipboard: CommandSpec,
    injector: CommandSpec,
    clipboard_kind: ClipboardProvider,
    injector_kind: PasteInjector,
}

impl PastePipeline {
    pub fn detect(platform: PastePlatform) -> Result<Self, PasteError> {
        Self::detect_with(platform, |command| {
            find_command(OsStr::new(command)).is_some()
        })
    }

    pub fn detect_with<F>(platform: PastePlatform, available: F) -> Result<Self, PasteError>
    where
        F: Fn(&str) -> bool,
    {
        let require = |command: &str, operation: &str| {
            if available(command) {
                Ok(())
            } else {
                Err(PasteError::MissingDependency {
                    command: command.to_owned(),
                    operation: operation.to_owned(),
                    hint: installation_hint(platform, command),
                })
            }
        };

        match platform {
            PastePlatform::Windows => {
                require("clip.exe", "copiar al portapapeles")?;
                let injector = if available("powershell.exe") {
                    "powershell.exe"
                } else if available("pwsh.exe") {
                    "pwsh.exe"
                } else {
                    require("powershell.exe", "pegar en la ventana activa")?;
                    unreachable!();
                };
                Ok(Self::with_parts(
                    platform,
                    CommandSpec::new("clip.exe", Vec::new(), true),
                    CommandSpec::new(
                        injector,
                        vec![
                            OsString::from("-NoProfile"),
                            OsString::from("-NonInteractive"),
                            OsString::from("-Command"),
                            OsString::from(
                                "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
                            ),
                        ],
                        false,
                    ),
                    ClipboardProvider::WindowsClip,
                    PasteInjector::WindowsSendKeys,
                ))
            }
            PastePlatform::X11 => {
                let clipboard = if available("xclip") {
                    (
                        ClipboardProvider::Xclip,
                        CommandSpec::new(
                            "xclip",
                            vec![OsString::from("-selection"), OsString::from("clipboard")],
                            true,
                        ),
                    )
                } else if available("xsel") {
                    (
                        ClipboardProvider::Xsel,
                        CommandSpec::new(
                            "xsel",
                            vec![OsString::from("--clipboard"), OsString::from("--input")],
                            true,
                        ),
                    )
                } else {
                    require("xclip o xsel", "copiar al portapapeles")?;
                    unreachable!();
                };
                require("xdotool", "pegar en la ventana activa")?;
                Ok(Self::with_parts(
                    platform,
                    clipboard.1,
                    CommandSpec::new(
                        "xdotool",
                        vec![
                            OsString::from("key"),
                            OsString::from("--clearmodifiers"),
                            OsString::from("ctrl+v"),
                        ],
                        false,
                    ),
                    clipboard.0,
                    PasteInjector::Xdotool,
                ))
            }
            PastePlatform::Wayland => {
                require("wl-copy", "copiar al portapapeles")?;
                require("wl-paste", "verificar el portapapeles")?;
                let (injector_kind, injector) = if available("wtype") {
                    (
                        PasteInjector::Wtype,
                        CommandSpec::new(
                            "wtype",
                            vec![
                                OsString::from("-M"),
                                OsString::from("ctrl"),
                                OsString::from("-k"),
                                OsString::from("v"),
                                OsString::from("-m"),
                                OsString::from("ctrl"),
                            ],
                            false,
                        ),
                    )
                } else if available("ydotool") {
                    (
                        PasteInjector::Ydotool,
                        CommandSpec::new(
                            "ydotool",
                            vec![
                                OsString::from("key"),
                                OsString::from("29:1"),
                                OsString::from("47:1"),
                                OsString::from("47:0"),
                                OsString::from("29:0"),
                            ],
                            false,
                        ),
                    )
                } else {
                    require("wtype o ydotool", "pegar en la ventana activa")?;
                    unreachable!();
                };
                Ok(Self::with_parts(
                    platform,
                    CommandSpec::new("wl-copy", Vec::new(), true),
                    injector,
                    ClipboardProvider::WlClipboard,
                    injector_kind,
                ))
            }
        }
    }

    /// Builds a pipeline for a test or a host-specific adapter.  Commands are
    /// still executed directly; no shell is ever inserted between these specs.
    pub fn with_commands(
        platform: PastePlatform,
        clipboard: CommandSpec,
        injector: CommandSpec,
    ) -> Self {
        let (clipboard_kind, injector_kind) = match platform {
            PastePlatform::Windows => (
                ClipboardProvider::WindowsClip,
                PasteInjector::WindowsSendKeys,
            ),
            PastePlatform::X11 => (ClipboardProvider::Xclip, PasteInjector::Xdotool),
            PastePlatform::Wayland => (ClipboardProvider::WlClipboard, PasteInjector::Wtype),
        };
        Self::with_parts(platform, clipboard, injector, clipboard_kind, injector_kind)
    }

    fn with_parts(
        platform: PastePlatform,
        clipboard: CommandSpec,
        injector: CommandSpec,
        clipboard_kind: ClipboardProvider,
        injector_kind: PasteInjector,
    ) -> Self {
        Self {
            platform,
            clipboard,
            injector,
            clipboard_kind,
            injector_kind,
        }
    }

    pub fn platform(&self) -> PastePlatform {
        self.platform
    }

    pub fn clipboard_kind(&self) -> ClipboardProvider {
        self.clipboard_kind
    }

    pub fn injector_kind(&self) -> PasteInjector {
        self.injector_kind
    }

    pub fn clipboard_command(&self) -> &CommandSpec {
        &self.clipboard
    }

    pub fn injector_command(&self) -> &CommandSpec {
        &self.injector
    }

    pub fn uses_shell(&self) -> bool {
        false
    }

    /// Copies first and only injects Ctrl+V after the clipboard process exits
    /// successfully, preserving the active window selected by the user.
    pub fn paste(&self, text: &str) -> Result<PasteOutcome, PasteError> {
        run_paste_command(&self.clipboard, Some(text.as_bytes()), true)?;
        run_paste_command(&self.injector, None, false)?;
        Ok(PasteOutcome {
            clipboard: self.clipboard_kind,
            injector: self.injector_kind,
        })
    }
}

fn run_paste_command(
    spec: &CommandSpec,
    input: Option<&[u8]>,
    clipboard: bool,
) -> Result<Output, PasteError> {
    let command = spec.program.to_string_lossy().into_owned();
    let mut process = Command::new(&spec.program);
    process
        .args(&spec.args)
        .stdin(if spec.stdin_required {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = process.spawn().map_err(|error| {
        if clipboard {
            PasteError::ClipboardSpawn {
                command: command.clone(),
                error: error.to_string(),
            }
        } else {
            PasteError::InjectorSpawn {
                command: command.clone(),
                error: error.to_string(),
            }
        }
    })?;
    if let Some(input) = input {
        let result = child
            .stdin
            .as_mut()
            .ok_or_else(|| {
                if clipboard {
                    PasteError::ClipboardWrite {
                        command: command.clone(),
                        error: "stdin no disponible".into(),
                    }
                } else {
                    PasteError::InjectorSpawn {
                        command: command.clone(),
                        error: "stdin no disponible".into(),
                    }
                }
            })
            .and_then(|stdin| {
                stdin.write_all(input).map_err(|error| {
                    if clipboard {
                        PasteError::ClipboardWrite {
                            command: command.clone(),
                            error: error.to_string(),
                        }
                    } else {
                        PasteError::InjectorSpawn {
                            command: command.clone(),
                            error: error.to_string(),
                        }
                    }
                })
            });
        if let Err(error) = result {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    }
    child.stdin.take();
    let output = child.wait_with_output().map_err(|error| {
        if clipboard {
            PasteError::ClipboardSpawn {
                command: command.clone(),
                error: error.to_string(),
            }
        } else {
            PasteError::InjectorSpawn {
                command: command.clone(),
                error: error.to_string(),
            }
        }
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if clipboard {
            PasteError::ClipboardFailed {
                command,
                code: output.status.code(),
                stderr,
            }
        } else {
            PasteError::InjectorFailed {
                command,
                code: output.status.code(),
                stderr,
            }
        });
    }
    Ok(output)
}

fn installation_hint(platform: PastePlatform, command: &str) -> String {
    match platform {
        PastePlatform::Windows => format!("Verifica que {command} esté disponible en Windows."),
        PastePlatform::X11 => {
            let package = if command == "xdotool" {
                "xdotool"
            } else {
                "xclip xdotool"
            };
            distro_install_hint(package)
        }
        PastePlatform::Wayland => {
            let package = match command {
                "wl-copy" | "wl-paste" => "wl-clipboard",
                "wtype" => "wtype",
                "ydotool" => "ydotool",
                _ => "wl-clipboard wtype",
            };
            distro_install_hint(package)
        }
    }
}

fn distro_install_hint(packages: &str) -> String {
    let release = fs::read_to_string("/etc/os-release")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if release.contains("debian") || release.contains("ubuntu") || release.contains("mint") {
        format!("Ejecuta: sudo apt install {packages}")
    } else if release.contains("fedora") || release.contains("rhel") || release.contains("centos") {
        format!("Ejecuta: sudo dnf install {packages}")
    } else if release.contains("arch") || release.contains("manjaro") {
        format!("Ejecuta: sudo pacman -S {packages}")
    } else if release.contains("opensuse") || release.contains("suse") {
        format!("Ejecuta: sudo zypper install {packages}")
    } else {
        format!("Instala estas dependencias: {packages}")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShortcutPlatform {
    Windows,
    X11,
    Wayland,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutMode {
    Hold,
    Toggle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Compositor {
    Gnome,
    Kde,
    Hyprland,
    Other(String),
    Unknown,
}

impl Compositor {
    pub fn from_name(name: &str) -> Self {
        let normalized = name.to_ascii_lowercase();
        if normalized.contains("gnome") {
            Self::Gnome
        } else if normalized.contains("kde") || normalized.contains("plasma") {
            Self::Kde
        } else if normalized.contains("hyprland") {
            Self::Hyprland
        } else if normalized.trim().is_empty() {
            Self::Unknown
        } else {
            Self::Other(name.to_owned())
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutCaptureMethod {
    ManagedGlobalHook,
    CompositorManaged,
    ToggleOnly,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShortcutError {
    HoldUnavailable {
        platform: ShortcutPlatform,
        compositor: Compositor,
    },
    ToggleUnavailable {
        platform: ShortcutPlatform,
    },
    UnsupportedPlatform(ShortcutPlatform),
}

impl fmt::Display for ShortcutError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HoldUnavailable { platform, compositor } => write!(
                formatter,
                "el modo mantener pulsada no está disponible en {platform:?} ({compositor:?}); usa alternar"
            ),
            Self::ToggleUnavailable { platform } => {
                write!(formatter, "el modo alternar no está disponible en {platform:?}")
            }
            Self::UnsupportedPlatform(platform) => write!(formatter, "plataforma no soportada: {platform:?}"),
        }
    }
}

impl std::error::Error for ShortcutError {}

/// A capability policy, separate from a native hook implementation.  Windows/X11
/// permit both modes when their adapter is installed; Wayland defaults to toggle
/// because a compositor cannot be assumed to report key release events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutPolicy {
    platform: ShortcutPlatform,
    compositor: Compositor,
    hold_supported: bool,
    toggle_supported: bool,
    capture_method: ShortcutCaptureMethod,
}

impl ShortcutPolicy {
    pub fn for_platform(platform: ShortcutPlatform) -> Self {
        match platform {
            ShortcutPlatform::Windows | ShortcutPlatform::X11 => Self {
                platform,
                compositor: Compositor::Unknown,
                hold_supported: true,
                toggle_supported: true,
                capture_method: ShortcutCaptureMethod::ManagedGlobalHook,
            },
            ShortcutPlatform::Wayland => Self::for_wayland(detect_compositor(), false),
            ShortcutPlatform::Unknown => Self {
                platform,
                compositor: Compositor::Unknown,
                hold_supported: false,
                toggle_supported: false,
                capture_method: ShortcutCaptureMethod::Unavailable,
            },
        }
    }

    pub fn for_wayland(compositor: Compositor, press_release_supported: bool) -> Self {
        Self {
            platform: ShortcutPlatform::Wayland,
            compositor,
            hold_supported: press_release_supported,
            toggle_supported: true,
            capture_method: if press_release_supported {
                ShortcutCaptureMethod::CompositorManaged
            } else {
                ShortcutCaptureMethod::ToggleOnly
            },
        }
    }

    pub fn platform(&self) -> &ShortcutPlatform {
        &self.platform
    }

    pub fn compositor(&self) -> &Compositor {
        &self.compositor
    }

    pub fn supports(&self, mode: ShortcutMode) -> bool {
        match mode {
            ShortcutMode::Hold => self.hold_supported,
            ShortcutMode::Toggle => self.toggle_supported,
        }
    }

    pub fn hold_supported(&self) -> bool {
        self.hold_supported
    }

    pub fn toggle_supported(&self) -> bool {
        self.toggle_supported
    }

    pub fn capture_method(&self) -> ShortcutCaptureMethod {
        self.capture_method
    }

    pub fn require(&self, mode: ShortcutMode) -> Result<(), ShortcutError> {
        if self.supports(mode) {
            return Ok(());
        }
        match mode {
            ShortcutMode::Hold => Err(ShortcutError::HoldUnavailable {
                platform: self.platform.clone(),
                compositor: self.compositor.clone(),
            }),
            ShortcutMode::Toggle => Err(ShortcutError::ToggleUnavailable {
                platform: self.platform.clone(),
            }),
        }
    }
}

pub fn detect_shortcut_platform() -> ShortcutPlatform {
    if cfg!(windows) {
        return ShortcutPlatform::Windows;
    }
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .map(|value| value.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false)
    {
        ShortcutPlatform::Wayland
    } else if std::env::var_os("DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .map(|value| value.eq_ignore_ascii_case("x11"))
            .unwrap_or(false)
    {
        ShortcutPlatform::X11
    } else {
        ShortcutPlatform::Unknown
    }
}

pub fn detect_compositor() -> Compositor {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP")
        .ok()
        .or_else(|| std::env::var("XDG_SESSION_DESKTOP").ok())
        .or_else(|| std::env::var("DESKTOP_SESSION").ok())
        .or_else(|| std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").map(|_| "Hyprland".to_owned()));
    Compositor::from_name(desktop.as_deref().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn temporary_model(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "chamu-dictation-test-{}-{}",
            std::process::id(),
            label
        ));
        fs::write(&path, b"model fixture").expect("create model fixture");
        path
    }

    #[test]
    fn capture_lifecycle_keeps_pcm_in_memory_until_finish() {
        let mut capture =
            InMemoryAudioCapture::new(AudioFormat::new(16_000, 1).unwrap(), 32).unwrap();
        assert_eq!(capture.state(), CaptureState::Idle);
        capture.start().unwrap();
        capture.push_samples(&[1, 2, 3]).unwrap();
        assert_eq!(capture.sample_count(), 3);

        let audio = capture.finish().unwrap();
        assert_eq!(capture.state(), CaptureState::Idle);
        assert_eq!(capture.sample_count(), 0);
        assert_eq!(audio.samples(), &[1, 2, 3]);
        assert_eq!(audio.format(), AudioFormat::new(16_000, 1).unwrap());
    }

    #[test]
    fn capture_rejects_samples_outside_active_lifecycle_and_limit() {
        let mut capture =
            InMemoryAudioCapture::new(AudioFormat::new(16_000, 1).unwrap(), 2).unwrap();
        assert!(matches!(
            capture.push_samples(&[1]),
            Err(CaptureError::NotRecording)
        ));
        capture.start().unwrap();
        capture.push_samples(&[1, 2]).unwrap();
        assert!(matches!(
            capture.push_samples(&[3]),
            Err(CaptureError::CapacityExceeded { .. })
        ));
        assert!(matches!(
            capture.start(),
            Err(CaptureError::AlreadyRecording)
        ));
        capture.cancel().unwrap();
        assert_eq!(capture.sample_count(), 0);
    }

    #[test]
    fn audio_buffer_encodes_pcm_as_a_wav_without_writing_a_file() {
        let mut capture =
            InMemoryAudioCapture::new(AudioFormat::new(8_000, 1).unwrap(), 4).unwrap();
        capture.start().unwrap();
        capture.push_samples(&[0, i16::MAX, i16::MIN]).unwrap();
        let wav = capture.finish().unwrap().to_wav_bytes().unwrap();
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 6);
        assert_eq!(
            u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize,
            wav.len() - 8
        );
    }

    #[test]
    fn whisper_invocation_contains_validated_model_and_language_flag() {
        let model = temporary_model("invocation");
        let config = WhisperTranscriberConfig::new(
            std::env::current_exe().unwrap(),
            &model,
            Language::English,
        )
        .unwrap();
        let invocation = config.invocation();
        assert!(invocation.args().windows(2).any(|pair| {
            pair[0] == OsStr::new("-m") && pair[1].as_os_str() == model.as_os_str()
        }));
        assert!(invocation
            .args()
            .windows(2)
            .any(|pair| { pair[0] == OsStr::new("-l") && pair[1] == OsStr::new("en") }));
        assert!(invocation
            .args()
            .windows(2)
            .any(|pair| { pair[0] == OsStr::new("-f") && pair[1] == OsStr::new("-") }));
        assert!(invocation
            .args()
            .iter()
            .all(|arg| arg != OsStr::new("sh") && arg != OsStr::new("-c")));
        fs::remove_file(model).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn whisper_runner_feeds_wav_to_local_process_and_returns_output() {
        let model = temporary_model("runner");
        let transcriber = WhisperTranscriber::new(
            WhisperTranscriberConfig::new("/bin/echo", &model, Language::Spanish).unwrap(),
        )
        .unwrap();
        let mut capture =
            InMemoryAudioCapture::new(AudioFormat::new(16_000, 1).unwrap(), 1).unwrap();
        capture.start().unwrap();
        capture.push_samples(&[4]).unwrap();
        let output = transcriber.transcribe(&capture.finish().unwrap()).unwrap();
        assert!(output.text().contains("-l"));
        assert!(output.text().contains("es"));
        fs::remove_file(model).unwrap();
    }

    #[test]
    fn whisper_configuration_rejects_missing_model_path() {
        let result = WhisperTranscriberConfig::new(
            "whisper-cli",
            std::env::temp_dir().join("chamu-model-does-not-exist"),
            Language::Spanish,
        );
        assert!(matches!(result, Err(WhisperConfigError::ModelNotFound(_))));
    }

    #[test]
    fn wayland_prefers_wtype_and_never_uses_a_shell() {
        let pipeline = PastePipeline::detect_with(PastePlatform::Wayland, |command| {
            matches!(command, "wl-copy" | "wl-paste" | "wtype" | "ydotool")
        })
        .unwrap();
        assert_eq!(pipeline.injector_kind(), PasteInjector::Wtype);
        assert_eq!(pipeline.clipboard_command().program(), Path::new("wl-copy"));
        assert!(!pipeline.uses_shell());
        assert!(pipeline
            .injector_command()
            .args()
            .iter()
            .all(|arg| arg != OsStr::new("-c") && arg != OsStr::new("sh")));
    }

    #[test]
    fn wayland_uses_ydotool_when_wtype_is_missing() {
        let pipeline = PastePipeline::detect_with(PastePlatform::Wayland, |command| {
            matches!(command, "wl-copy" | "wl-paste" | "ydotool")
        })
        .unwrap();
        assert_eq!(pipeline.injector_kind(), PasteInjector::Ydotool);
    }

    #[test]
    fn x11_falls_back_to_xsel_and_reports_missing_dependencies() {
        let pipeline = PastePipeline::detect_with(PastePlatform::X11, |command| {
            matches!(command, "xsel" | "xdotool")
        })
        .unwrap();
        assert_eq!(pipeline.clipboard_kind(), ClipboardProvider::Xsel);
        let missing = PastePipeline::detect_with(PastePlatform::Wayland, |_| false).unwrap_err();
        assert!(matches!(missing, PasteError::MissingDependency { .. }));
        assert!(missing.to_string().contains("wl-copy"));
    }

    #[test]
    fn shortcut_policy_allows_hold_on_windows_and_x11_but_not_default_wayland() {
        assert!(
            ShortcutPolicy::for_platform(ShortcutPlatform::Windows).supports(ShortcutMode::Hold)
        );
        assert!(ShortcutPolicy::for_platform(ShortcutPlatform::X11).supports(ShortcutMode::Hold));
        let wayland = ShortcutPolicy::for_wayland(Compositor::Gnome, false);
        assert!(!wayland.supports(ShortcutMode::Hold));
        assert!(wayland.supports(ShortcutMode::Toggle));
        assert!(matches!(
            wayland.require(ShortcutMode::Hold),
            Err(ShortcutError::HoldUnavailable { .. })
        ));
        assert!(ShortcutPolicy::for_wayland(Compositor::Gnome, true).supports(ShortcutMode::Hold));
    }

    #[test]
    fn compositor_detection_is_explicit_and_does_not_promise_an_unknown_adapter() {
        assert_eq!(Compositor::from_name("GNOME"), Compositor::Gnome);
        assert_eq!(Compositor::from_name("plasma"), Compositor::Kde);
        assert_eq!(Compositor::from_name("Hyprland"), Compositor::Hyprland);
        let unknown = ShortcutPolicy::for_wayland(Compositor::Unknown, false);
        assert_eq!(unknown.capture_method(), ShortcutCaptureMethod::ToggleOnly);
    }
}
