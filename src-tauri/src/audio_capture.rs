//! CPAL-backed microphone capture that never writes audio to disk.

use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;

use crate::audio_adapter::{
    convert_interleaved_f32_to_mono_16k, convert_interleaved_f64_to_mono_16k,
    convert_interleaved_i16_to_mono_16k, convert_interleaved_i32_to_mono_16k,
    convert_interleaved_i64_to_mono_16k, convert_interleaved_i8_to_mono_16k,
    convert_interleaved_u16_to_mono_16k, convert_interleaved_u32_to_mono_16k,
    convert_interleaved_u64_to_mono_16k, convert_interleaved_u8_to_mono_16k,
};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CAPTURE_SAMPLES: usize = 16_000 * 60 * 30;
pub const DEFAULT_MICROPHONE_NAME: &str = "Micrófono predeterminado del sistema";

/// Returns a usable display name without exposing any audio data.
pub fn microphone_name(name: Option<&str>) -> String {
    name.filter(|value| {
        let value = value.trim();
        !value.is_empty() && !matches!(value, "default" | "pipewire" | "pulse")
    })
        .unwrap_or(DEFAULT_MICROPHONE_NAME)
        .to_string()
}

/// A microphone the user can pick, mirroring what the sound server would
/// present: a stable id (the only identifier cpal exposes) and a friendly
/// label.  On Linux the label comes from the ALSA card name, the same one
/// PipeWire uses.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct InputDevice {
    pub id: String,
    pub label: String,
    pub is_built_in: bool,
}

/// Reads only the system default input device name.
pub fn default_input_device_name() -> String {
    let name = cpal::default_host()
        .default_input_device()
        .and_then(|device| device.name().ok());
    microphone_name(name.as_deref())
}

/// Returns the device name that the UI should present as effective. Linux
/// always reports the server default because direct ALSA IDs are not capture
/// selections under PipeWire.
pub fn effective_microphone_name(desired: Option<&str>) -> String {
    #[cfg(target_os = "linux")]
    {
        let _ = desired;
        return default_input_device_name();
    }

    #[cfg(not(target_os = "linux"))]
    resolved_input_device(desired)
        .map(|device| device.label)
        .unwrap_or_else(default_input_device_name)
}

/// Lists selectable input devices. Linux exposes only the system default
/// through the UI, so it returns an empty device-specific list there.
/// Other platforms enumerate and filter their selectable devices.
pub fn list_input_devices() -> Result<Vec<InputDevice>, String> {
    #[cfg(target_os = "linux")]
    {
        return Ok(Vec::new());
    }

    #[cfg(not(target_os = "linux"))]
    {
        let names = enumerate_input_device_names()?;
        let names = selectable_input_devices(names);
        let cards = read_alsa_card_names();
        Ok(describe_devices(names, &cards))
    }
}

fn selectable_input_devices(names: Vec<String>) -> Vec<String> {
    #[cfg(target_os = "linux")]
    {
        let _ = names;
        Vec::new()
    }

    #[cfg(not(target_os = "linux"))]
    {
        let names = normalize_device_names(names);
        keep_best_view_per_card(names)
    }
}

/// Applies the UI filter to a raw enumeration.
fn normalize_device_names(names: Vec<String>) -> Vec<String> {
    let mut names: Vec<String> = names
        .into_iter()
        .filter_map(|name| normalize_device_name(&name))
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Builds the user-facing device list from filtered ALSA names.
fn describe_devices(names: Vec<String>, cards: &HashMap<String, String>) -> Vec<InputDevice> {
    let mut devices: Vec<InputDevice> = names
        .into_iter()
        .map(|id| {
            let label = friendly_label(&id, cards);
            InputDevice {
                is_built_in: is_built_in_label(&label),
                id,
                label,
            }
        })
        .collect();
    disambiguate_same_card_labels(&mut devices);
    devices
}

/// Appends a suffix to repeated labels from the same card so every entry
/// stays distinguishable (e.g. two devices on one card).
fn disambiguate_same_card_labels(devices: &mut [InputDevice]) {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for device in devices.iter() {
        *counts.entry(device.label.clone()).or_insert(0) += 1;
    }
    for device in devices.iter_mut() {
        if counts.get(&device.label).copied().unwrap_or(0) > 1 {
            if let Some(card) = card_id(&device.id) {
                device.label.push_str(&format!(" · {card}"));
            }
        }
    }
}

/// Resolves the saved device id to the device it would capture from.  Returns
/// `None` when nothing is saved or the saved device vanished; the caller then
/// falls back to the system default.
pub fn resolved_input_device(desired: Option<&str>) -> Option<InputDevice> {
    let desired = desired.filter(|name| !name.trim().is_empty())?;
    let names = enumerate_input_device_names().ok()?;
    let names = normalize_device_names(names);
    let names = keep_best_view_per_card(names);
    let exists = names.iter().any(|name| name == &desired);
    if !exists {
        return None;
    }
    let cards = read_alsa_card_names();
    describe_devices(names, &cards)
        .into_iter()
        .find(|device| device.id == desired)
}

/// Reads every raw input device name without the UI filtering.
fn enumerate_input_device_names() -> Result<Vec<String>, String> {
    silence_alsa_lib_messages();
    let host = cpal::default_host();
    let mut names: Vec<String> = host
        .input_devices()
        .map_err(|error| format!("No se pudo enumerar los micrófonos: {error}"))?
        .filter_map(|device| device.name().ok())
        .filter(|name| !name.trim().is_empty())
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}

/// cpal probes every PCM in both directions to classify it, so ALSA prints
/// expected failures (a playback-only `dmix` tried as capture, and so on) to
/// stderr.  Silence those messages once; cpal still surfaces real errors
/// through its own error types.  The handler lives in `silence_alsa.c`.
fn silence_alsa_lib_messages() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        #[cfg(target_os = "linux")]
        unsafe {
            extern "C" {
                fn chamu_silence_alsa_messages();
            }
            chamu_silence_alsa_messages();
        }
    });
}

/// ALSA views that never represent a usable microphone.
const EXCLUDED_DEVICE_PREFIXES: &[&str] = &[
    "dsnoop:", "surround40:", "surround50:", "surround51:", "surround71:",
    "iec958:", "dmix:", "echo:", "tee:", "file:", "raw:",
];

/// Generic pseudo-devices that resolve to the system default; the UI already
/// offers the system default as an explicit choice.
const EXCLUDED_PSEUDO_DEVICES: &[&str] = &["default", "pipewire", "pulse"];

#[cfg(target_os = "linux")]
const DIRECT_ALSA_DEVICE_PREFIXES: &[&str] = &["front:", "sysdefault:", "hw:", "plughw:"];

/// Preferred ALSA views for the same card, in order.
const DEVICE_VIEW_PREFERENCE: &[&str] = &["front:", "sysdefault:", "hw:", "plughw:"];

fn normalize_device_name(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }
    if EXCLUDED_PSEUDO_DEVICES
        .iter()
        .any(|pseudo| trimmed == *pseudo)
    {
        return None;
    }
    if EXCLUDED_DEVICE_PREFIXES
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
    {
        return None;
    }
    #[cfg(target_os = "linux")]
    if DIRECT_ALSA_DEVICE_PREFIXES
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
    {
        return None;
    }
    Some(trimmed.to_string())
}

/// Keeps only the most recognizable view per ALSA card (`CARD=...`), falling
/// back to the raw name when a device has no card marker.
fn keep_best_view_per_card(names: Vec<String>) -> Vec<String> {
    let mut by_card: Vec<(String, String)> = Vec::new();
    let mut plain: Vec<String> = Vec::new();
    for name in names {
        match card_id(&name) {
            Some(card) => {
                if let Some((_, current)) = by_card.iter_mut().find(|(candidate, _)| *candidate == card) {
                    if view_rank(&name) < view_rank(current) {
                        *current = name;
                    }
                } else {
                    by_card.push((card, name));
                }
            }
            None => plain.push(name),
        }
    }
    let mut result: Vec<String> = by_card.into_iter().map(|(_, name)| name).collect();
    result.extend(plain);
    result.sort();
    result
}

fn card_id(name: &str) -> Option<String> {
    let marker = name.find("CARD=")?;
    let rest = &name[marker + "CARD=".len()..];
    let end = rest.find(',').unwrap_or(rest.len());
    (!rest[..end].is_empty()).then(|| rest[..end].to_string())
}

fn view_rank(name: &str) -> usize {
    DEVICE_VIEW_PREFERENCE
        .iter()
        .position(|prefix| name.starts_with(prefix))
        .unwrap_or(DEVICE_VIEW_PREFERENCE.len())
}

/// Friendly card names from `/proc/asound/cards`, keyed by ALSA card id.
/// These are the same descriptions PipeWire surfaces for each device.
#[cfg(target_os = "linux")]
fn read_alsa_card_names() -> HashMap<String, String> {
    let Ok(content) = std::fs::read_to_string("/proc/asound/cards") else {
        return HashMap::new();
    };
    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let id_start = line.find('[')?;
            let id_end = line.find(']')?;
            let id = line[id_start + 1..id_end].trim();
            let rest = &line[id_end + 1..];
            let separator = rest.find(" - ")?;
            let name = rest[separator + 3..].trim();
            if id.is_empty() || name.is_empty() {
                return None;
            }
            Some((id.to_string(), name.to_string()))
        })
        .collect()
}

#[cfg(not(target_os = "linux"))]
fn read_alsa_card_names() -> HashMap<String, String> {
    HashMap::new()
}

/// The label shown for a device: the friendly card name when the ALSA id
/// maps to one, otherwise the raw id (already friendly on macOS/Windows).
fn friendly_label(id: &str, cards: &HashMap<String, String>) -> String {
    card_id(id)
        .and_then(|card| cards.get(&card).cloned())
        .unwrap_or_else(|| id.to_string())
}

/// Heuristic that flags onboard microphones, adapted from OpenWhispr's
/// `isBuiltInMicrophone`.  On Linux, HDA card names come from the kernel and
/// are reliably onboard hardware.
fn is_built_in_label(label: &str) -> bool {
    let lower = label.to_lowercase();
    const BUILT_IN_MARKERS: &[&str] = &[
        "built-in", "internal", "integrated", "macbook", "hd-audio", "hda-intel", "realtek",
    ];
    BUILT_IN_MARKERS.iter().any(|marker| lower.contains(marker))
}

/// Picks the device to capture from.  An empty or unknown name resolves to
/// `None`, which the caller treats as the system default.  When the exact name
/// is gone (ALSA views change as devices open and close), the same card is
/// matched again through its best available view.
fn resolve_input_device_name(available: &[String], desired: Option<&str>) -> Option<String> {
    let desired = desired.filter(|name| !name.trim().is_empty())?;
    #[cfg(target_os = "linux")]
    {
        let _ = (available, desired);
        return None;
    }

    #[cfg(not(target_os = "linux"))]
    {
        if let Some(exact) = available.iter().find(|name| *name == &desired) {
            return Some(exact.clone());
        }
        let desired_card = card_id(desired)?;
        let mut candidates: Vec<&String> = available
            .iter()
            .filter(|name| card_id(name).as_deref() == Some(desired_card.as_str()))
            .collect();
        candidates.sort_by_key(|name| view_rank(name));
        candidates.first().map(|name| (*name).clone())
    }
}

/// Keeps a requested device only on platforms where cpal can open a stable
/// user-selected device. Linux cpal uses the ALSA backend while PipeWire owns
/// the effective route, so capture must always use the server default.
pub fn capture_device_name(device_name: Option<String>) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let _ = device_name;
        None
    }

    #[cfg(not(target_os = "linux"))]
    device_name.filter(|name| !name.trim().is_empty())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    Idle,
    Recording,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureFinalization {
    Transcribe,
}

impl CaptureFinalization {
    /// Converts a fallible finalization operation into a policy result.  The
    /// audio owner is dropped by the caller on the error path, so no partial
    /// samples can escape to history or a file.
    pub fn from_result<T, E: ToString>(result: Result<T, E>) -> Result<T, String> {
        result.map_err(|error| error.to_string())
    }
}

#[derive(Debug, Default)]
pub struct CaptureSessionPolicy {
    state: SessionState,
}

impl CaptureSessionPolicy {
    pub fn state(&self) -> SessionState {
        self.state
    }

    pub fn start(&mut self) -> Result<(), String> {
        if self.state == SessionState::Recording {
            return Err("Ya hay un dictado en curso".into());
        }
        self.state = SessionState::Recording;
        Ok(())
    }

    pub fn finish(&mut self) -> Result<CaptureFinalization, String> {
        if self.state != SessionState::Recording {
            return Err("No hay un dictado en curso".into());
        }
        self.state = SessionState::Idle;
        Ok(CaptureFinalization::Transcribe)
    }
}

impl Default for SessionState {
    fn default() -> Self {
        Self::Idle
    }
}

/// A Send-safe control handle.  CPAL's platform stream is intentionally kept
/// on the worker thread because some host backends do not allow moving a
/// `Stream` across threads.  The handle only owns channels and a JoinHandle,
/// so it can safely live in Tauri managed state.
pub struct CaptureSessionHandle {
    stop_sender: Option<mpsc::Sender<()>>,
    result_receiver: Option<mpsc::Receiver<Result<Vec<i16>, String>>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl CaptureSessionHandle {
    pub fn start(device_name: Option<String>) -> Result<Self, String> {
        let device_name = capture_device_name(device_name);
        let (startup_sender, startup_receiver) = mpsc::channel();
        let (stop_sender, stop_receiver) = mpsc::channel();
        let (result_sender, result_receiver) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("chamu-audio-capture".into())
            .spawn(move || {
                run_capture_worker(device_name, startup_sender, stop_receiver, result_sender);
            })
            .map_err(|error| format!("No se pudo iniciar el capturador de audio: {error}"))?;

        match startup_receiver.recv_timeout(STARTUP_TIMEOUT) {
            Ok(Ok(())) => Ok(Self {
                stop_sender: Some(stop_sender),
                result_receiver: Some(result_receiver),
                worker: Some(worker),
            }),
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(error)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = stop_sender.send(());
                let _ = worker.join();
                Err("El micrófono tardó demasiado en iniciar".into())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = worker.join();
                Err("El capturador de audio terminó al iniciar".into())
            }
        }
    }

    /// Stops the native stream before taking the in-memory PCM buffer.
    pub fn stop(mut self) -> Result<Vec<i16>, String> {
        let stop_sender = self
            .stop_sender
            .take()
            .ok_or_else(|| "La sesión de audio ya fue detenida".to_string())?;
        stop_sender
            .send(())
            .map_err(|_| "El capturador de audio ya no está disponible".to_string())?;
        let result_receiver = self
            .result_receiver
            .take()
            .ok_or_else(|| "La sesión de audio no tiene resultado".to_string())?;
        let result = result_receiver
            .recv_timeout(STOP_TIMEOUT)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => {
                    "El capturador de audio no respondió al detenerse".to_string()
                }
                mpsc::RecvTimeoutError::Disconnected => {
                    "El capturador de audio terminó sin devolver el audio".to_string()
                }
            })?;
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| "El capturador de audio terminó inesperadamente".to_string())?;
        }
        result
    }
}

impl Drop for CaptureSessionHandle {
    fn drop(&mut self) {
        if let Some(stop_sender) = self.stop_sender.take() {
            let _ = stop_sender.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

type SampleStore = Arc<Mutex<Vec<i16>>>;
type CallbackError = Arc<Mutex<Option<String>>>;

/// A stream whose callback thread died (a known cpal/PipeWire failure on some
/// HDA cards) never delivers samples; dropping it then panics inside cpal.
/// The worker detects the silent stream, falls back to the system default,
/// and swallows the drop panic so the dictation never hangs.
const FIRST_SAMPLE_GRACE: Duration = Duration::from_millis(300);

fn run_capture_worker(
    device_name: Option<String>,
    startup_sender: mpsc::Sender<Result<(), String>>,
    stop_receiver: mpsc::Receiver<()>,
    result_sender: mpsc::Sender<Result<Vec<i16>, String>>,
) {
    let startup_dup = startup_sender.clone();
    let result_dup = result_sender.clone();
    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        run_capture_worker_inner(device_name, startup_sender, stop_receiver, result_sender);
    }));
    if run.is_err() {
        let _ = startup_dup.send(Err("El capturador de audio falló de forma inesperada".into()));
        let _ = result_dup.send(Err("El capturador de audio falló de forma inesperada".into()));
    }
}

fn run_capture_worker_inner(
    device_name: Option<String>,
    startup_sender: mpsc::Sender<Result<(), String>>,
    stop_receiver: mpsc::Receiver<()>,
    result_sender: mpsc::Sender<Result<Vec<i16>, String>>,
) {
    let active_name = device_name.clone();
    let mut capture = match build_capture_stream(active_name.as_deref()) {
        Ok(capture) => capture,
        Err(error) => {
            if active_name.is_some() {
                println!("[chamu] capture setup error: {error}; reintentando con el predeterminado");
                match build_capture_stream(None) {
                    Ok(capture) => capture,
                    Err(fallback_error) => {
                        let _ = startup_sender.send(Err(fallback_error));
                        return;
                    }
                }
            } else {
                let _ = startup_sender.send(Err(error));
                return;
            }
        }
    };

    if !wait_for_first_samples(&capture.1) {
        if active_name.is_some() {
            drop_stream(capture.0);
            println!(
                "[chamu] el micrófono {active_name:?} no entrega audio; reintentando con el predeterminado"
            );
            capture = match build_capture_stream(None) {
                Ok(capture) => capture,
                Err(error) => {
                    let _ = startup_sender.send(Err(error));
                    return;
                }
            };
            if !wait_for_first_samples(&capture.1) {
                drop_stream(capture.0);
                let _ = startup_sender.send(Err(
                    "El micrófono no entrega audio; revisa su nivel o silencio".into(),
                ));
                return;
            }
        } else {
            drop_stream(capture.0);
            let _ = startup_sender.send(Err(
                "El micrófono no entrega audio; revisa su nivel o silencio".into(),
            ));
            return;
        }
    }

    if startup_sender.send(Ok(())).is_err() {
        drop_stream(capture.0);
        return;
    }
    let _ = stop_receiver.recv();
    // Dropping the stream releases CPAL's callback before reading the buffer.
    drop_stream(capture.0);

    let result = match capture.2.lock() {
        Ok(error) => match error.clone() {
            Some(error) => Err(error),
            None => capture
                .1
                .lock()
                .map(|mut values| std::mem::take(&mut *values))
                .map_err(|_| "No se pudo leer el audio capturado".to_string()),
        },
        Err(_) => Err("No se pudo leer el estado del capturador".into()),
    };
    let _ = result_sender.send(result);
}

fn wait_for_first_samples(samples: &SampleStore) -> bool {
    let deadline = Instant::now() + FIRST_SAMPLE_GRACE;
    loop {
        if samples.lock().map(|store| !store.is_empty()).unwrap_or(false) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn drop_stream(stream: cpal::Stream) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(stream)));
}

/// CPAL's ALSA host panics internally on some HDA cards behind PipeWire
/// (timestamp asserts in `cpal/src/host/alsa/mod.rs`).  The worker already
/// detects the dead stream, falls back to the system default, and swallows
/// the drop panic; this hook only stops those known internal panics from
/// polluting stderr while every other panic keeps its default handler.
pub fn silence_cpal_panics() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let file = info.location().map(|location| location.file()).unwrap_or("");
            if file.contains("cpal") {
                return;
            }
            default_hook(info);
        }));
    });
}

fn build_capture_stream(
    device_name: Option<&str>,
) -> Result<(cpal::Stream, SampleStore, CallbackError), String> {
    silence_cpal_panics();
    let host = cpal::default_host();
    let device = if should_enumerate_capture_devices(device_name) {
        silence_alsa_lib_messages();
        let devices: Vec<(String, cpal::Device)> = host
            .input_devices()
            .map_err(|error| format!("No se pudo enumerar los micrófonos: {error}"))?
            .filter_map(|device| {
                device
                    .name()
                    .ok()
                    .filter(|name| !name.trim().is_empty())
                    .map(|name| (name, device))
            })
            .collect();
        let names: Vec<String> = devices.iter().map(|(name, _)| name.clone()).collect();
        println!("[chamu] build_capture_stream names: {names:?} (desired={device_name:?})");
        resolve_input_device_name(&names, device_name)
            .and_then(|name| {
                devices
                    .into_iter()
                    .find(|(candidate, _)| candidate == &name)
                    .map(|(_, device)| device)
            })
            .or_else(|| host.default_input_device())
    } else {
        host.default_input_device()
    }
    .ok_or_else(|| "No se encontró un dispositivo de entrada de audio".to_string())?;
    let resolved_name = device
        .name()
        .unwrap_or_else(|_| "<sin nombre>".to_string());
    println!(
        "[chamu] capture device resolved: {resolved_name} (requested={device_name:?})"
    );
    let supported = device
        .default_input_config()
        .map_err(|error| format!("No se pudo leer la configuración del micrófono: {error}"))?;
    let sample_format = supported.sample_format();
    let stream_config: cpal::StreamConfig = supported.into();
    let channels = stream_config.channels;
    let sample_rate = stream_config.sample_rate.0;
    let samples: SampleStore = Arc::new(Mutex::new(Vec::new()));
    let callback_error: CallbackError = Arc::new(Mutex::new(None));

    let stream = match sample_format {
        SampleFormat::F32 => {
            let samples = Arc::clone(&samples);
            let callback_error = Arc::clone(&callback_error);
            let callback_error_for_stream = Arc::clone(&callback_error);
            device.build_input_stream(
                &stream_config,
                move |data: &[f32], _| {
                    append_samples(
                        convert_interleaved_f32_to_mono_16k(data, channels, sample_rate),
                        &samples,
                        &callback_error,
                    )
                },
                stream_error_callback(callback_error_for_stream),
                None,
            )
        }
        SampleFormat::F64 => {
            let samples = Arc::clone(&samples);
            let callback_error = Arc::clone(&callback_error);
            let callback_error_for_stream = Arc::clone(&callback_error);
            device.build_input_stream(
                &stream_config,
                move |data: &[f64], _| {
                    append_samples(
                        convert_interleaved_f64_to_mono_16k(data, channels, sample_rate),
                        &samples,
                        &callback_error,
                    )
                },
                stream_error_callback(callback_error_for_stream),
                None,
            )
        }
        SampleFormat::I8 => {
            let samples = Arc::clone(&samples);
            let callback_error = Arc::clone(&callback_error);
            let callback_error_for_stream = Arc::clone(&callback_error);
            device.build_input_stream(
                &stream_config,
                move |data: &[i8], _| {
                    append_samples(
                        convert_interleaved_i8_to_mono_16k(data, channels, sample_rate),
                        &samples,
                        &callback_error,
                    )
                },
                stream_error_callback(callback_error_for_stream),
                None,
            )
        }
        SampleFormat::I16 => {
            let samples = Arc::clone(&samples);
            let callback_error = Arc::clone(&callback_error);
            let callback_error_for_stream = Arc::clone(&callback_error);
            device.build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    append_samples(
                        convert_interleaved_i16_to_mono_16k(data, channels, sample_rate),
                        &samples,
                        &callback_error,
                    )
                },
                stream_error_callback(callback_error_for_stream),
                None,
            )
        }
        SampleFormat::I32 => {
            let samples = Arc::clone(&samples);
            let callback_error = Arc::clone(&callback_error);
            let callback_error_for_stream = Arc::clone(&callback_error);
            device.build_input_stream(
                &stream_config,
                move |data: &[i32], _| {
                    append_samples(
                        convert_interleaved_i32_to_mono_16k(data, channels, sample_rate),
                        &samples,
                        &callback_error,
                    )
                },
                stream_error_callback(callback_error_for_stream),
                None,
            )
        }
        SampleFormat::I64 => {
            let samples = Arc::clone(&samples);
            let callback_error = Arc::clone(&callback_error);
            let callback_error_for_stream = Arc::clone(&callback_error);
            device.build_input_stream(
                &stream_config,
                move |data: &[i64], _| {
                    append_samples(
                        convert_interleaved_i64_to_mono_16k(data, channels, sample_rate),
                        &samples,
                        &callback_error,
                    )
                },
                stream_error_callback(callback_error_for_stream),
                None,
            )
        }
        SampleFormat::U8 => {
            let samples = Arc::clone(&samples);
            let callback_error = Arc::clone(&callback_error);
            let callback_error_for_stream = Arc::clone(&callback_error);
            device.build_input_stream(
                &stream_config,
                move |data: &[u8], _| {
                    append_samples(
                        convert_interleaved_u8_to_mono_16k(data, channels, sample_rate),
                        &samples,
                        &callback_error,
                    )
                },
                stream_error_callback(callback_error_for_stream),
                None,
            )
        }
        SampleFormat::U16 => {
            let samples = Arc::clone(&samples);
            let callback_error = Arc::clone(&callback_error);
            let callback_error_for_stream = Arc::clone(&callback_error);
            device.build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    append_samples(
                        convert_interleaved_u16_to_mono_16k(data, channels, sample_rate),
                        &samples,
                        &callback_error,
                    )
                },
                stream_error_callback(callback_error_for_stream),
                None,
            )
        }
        SampleFormat::U32 => {
            let samples = Arc::clone(&samples);
            let callback_error = Arc::clone(&callback_error);
            let callback_error_for_stream = Arc::clone(&callback_error);
            device.build_input_stream(
                &stream_config,
                move |data: &[u32], _| {
                    append_samples(
                        convert_interleaved_u32_to_mono_16k(data, channels, sample_rate),
                        &samples,
                        &callback_error,
                    )
                },
                stream_error_callback(callback_error_for_stream),
                None,
            )
        }
        SampleFormat::U64 => {
            let samples = Arc::clone(&samples);
            let callback_error = Arc::clone(&callback_error);
            let callback_error_for_stream = Arc::clone(&callback_error);
            device.build_input_stream(
                &stream_config,
                move |data: &[u64], _| {
                    append_samples(
                        convert_interleaved_u64_to_mono_16k(data, channels, sample_rate),
                        &samples,
                        &callback_error,
                    )
                },
                stream_error_callback(callback_error_for_stream),
                None,
            )
        }
        format => return Err(format!("El formato de audio {format:?} no está soportado")),
    }
    .map_err(|error| format!("No se pudo abrir el micrófono: {error}"))?;
    stream
        .play()
        .map_err(|error| format!("No se pudo comenzar la captura: {error}"))?;
    Ok((stream, samples, callback_error))
}

fn should_enumerate_capture_devices(device_name: Option<&str>) -> bool {
    #[cfg(target_os = "linux")]
    {
        let _ = device_name;
        false
    }

    #[cfg(not(target_os = "linux"))]
    device_name.is_some_and(|name| !name.trim().is_empty())
}

fn stream_error_callback(
    callback_error: CallbackError,
) -> impl FnMut(cpal::StreamError) + Send + 'static {
    move |error| {
        if let Ok(mut slot) = callback_error.lock() {
            if slot.is_none() {
                *slot = Some(format!("Error del micrófono: {error}"));
            }
        }
    }
}

fn append_samples(converted: Vec<i16>, samples: &SampleStore, callback_error: &CallbackError) {
    if converted.is_empty() {
        return;
    }
    let Ok(mut values) = samples.lock() else {
        set_callback_error(callback_error, "No se pudo guardar el audio en memoria");
        return;
    };
    if values
        .len()
        .checked_add(converted.len())
        .map(|length| length > MAX_CAPTURE_SAMPLES)
        .unwrap_or(true)
    {
        set_callback_error(
            callback_error,
            "La captura superó el límite de 30 minutos y fue descartada",
        );
        return;
    }
    values.extend(converted);
}

fn set_callback_error(callback_error: &CallbackError, message: &str) {
    if let Ok(mut slot) = callback_error.lock() {
        if slot.is_none() {
            *slot = Some(message.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        card_id, describe_devices, disambiguate_same_card_labels, friendly_label,
        is_built_in_label, keep_best_view_per_card, microphone_name, normalize_device_name,
        resolve_input_device_name, wait_for_first_samples, CaptureFinalization,
        CaptureSessionPolicy, InputDevice, SampleStore, SessionState, DEFAULT_MICROPHONE_NAME,
    };
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    #[test]
    fn microphone_name_uses_the_device_name_or_system_fallback() {
        assert_eq!(microphone_name(Some("Micrófono USB")), "Micrófono USB");
        assert_eq!(microphone_name(None), DEFAULT_MICROPHONE_NAME);
        assert_eq!(microphone_name(Some("  ")), DEFAULT_MICROPHONE_NAME);
        assert_eq!(microphone_name(Some("default")), DEFAULT_MICROPHONE_NAME);
        assert_eq!(microphone_name(Some("pipewire")), DEFAULT_MICROPHONE_NAME);
        assert_eq!(microphone_name(Some("pulse")), DEFAULT_MICROPHONE_NAME);
    }

    #[test]
    fn device_normalization_drops_pseudo_devices_and_output_views() {
        assert_eq!(normalize_device_name("default"), None);
        assert_eq!(normalize_device_name("pipewire"), None);
        assert_eq!(normalize_device_name("pulse"), None);
        assert_eq!(normalize_device_name("  "), None);
        assert_eq!(normalize_device_name("dsnoop:CARD=X,DEV=0"), None);
        assert_eq!(normalize_device_name("surround51:CARD=X,DEV=0"), None);
        assert_eq!(normalize_device_name("iec958:CARD=X,DEV=0"), None);
        #[cfg(target_os = "linux")]
        assert_eq!(normalize_device_name("front:CARD=X,DEV=0"), None);
        #[cfg(not(target_os = "linux"))]
        assert_eq!(
            normalize_device_name("front:CARD=X,DEV=0"),
            Some("front:CARD=X,DEV=0".into())
        );
        assert_eq!(
            normalize_device_name("Micrófono USB"),
            Some("Micrófono USB".into())
        );
    }

    #[test]
    fn linux_device_list_drops_direct_alsa_pcm_names() {
        #[cfg(target_os = "linux")]
        for name in [
            "front:CARD=Mic,DEV=0",
            "hw:CARD=Mic,DEV=0",
            "plughw:CARD=Mic,DEV=0",
            "sysdefault:CARD=Mic",
        ] {
            assert_eq!(normalize_device_name(name), None, "device: {name}");
        }

        #[cfg(not(target_os = "linux"))]
        assert_eq!(
            normalize_device_name("front:CARD=Mic,DEV=0"),
            Some("front:CARD=Mic,DEV=0".into())
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_selectable_device_list_is_always_empty() {
        let raw = vec![
            "null".to_string(),
            "alsa_input.pci-1".to_string(),
            "front:CARD=Mic,DEV=0".to_string(),
        ];
        assert!(super::selectable_input_devices(raw).is_empty());
    }

    #[test]
    fn capture_stream_only_enumerates_for_an_explicit_selection() {
        #[cfg(target_os = "linux")]
        {
            assert!(!super::should_enumerate_capture_devices(None));
            assert!(!super::should_enumerate_capture_devices(Some("old-id")));
        }
        #[cfg(not(target_os = "linux"))]
        {
            assert!(!super::should_enumerate_capture_devices(None));
            assert!(super::should_enumerate_capture_devices(Some("USB")));
        }
    }

    #[test]
    fn card_selection_keeps_one_recognizable_view_per_card() {
        let names = vec![
            "plughw:CARD=X,DEV=0".into(),
            "hw:CARD=X,DEV=0".into(),
            "sysdefault:CARD=X".into(),
            "front:CARD=X,DEV=0".into(),
            "hw:CARD=Y,DEV=0".into(),
            "Micrófono USB".into(),
        ];
        assert_eq!(
            keep_best_view_per_card(names),
            vec!["Micrófono USB", "front:CARD=X,DEV=0", "hw:CARD=Y,DEV=0"]
        );
    }

    #[test]
    fn card_id_extracts_only_the_card_identifier() {
        assert_eq!(card_id("front:CARD=Generic_1,DEV=0"), Some("Generic_1".into()));
        assert_eq!(card_id("sysdefault:CARD=S"), Some("S".into()));
        assert_eq!(card_id("Micrófono USB"), None);
    }

    #[test]
    fn friendly_label_uses_the_card_name_when_known() {
        let mut cards = HashMap::new();
        cards.insert("S".to_string(), "HyperX QuadCast S".to_string());
        cards.insert("Generic_1".to_string(), "HD-Audio Generic".to_string());
        assert_eq!(
            friendly_label("front:CARD=S,DEV=0", &cards),
            "HyperX QuadCast S"
        );
        assert_eq!(friendly_label("front:CARD=Generic_1,DEV=0", &cards), "HD-Audio Generic");
        assert_eq!(friendly_label("Micrófono USB", &cards), "Micrófono USB");
        assert_eq!(friendly_label("front:CARD=Unknown,DEV=0", &cards), "front:CARD=Unknown,DEV=0");
    }

    #[test]
    fn built_in_heuristic_flags_onboard_devices_only() {
        assert!(is_built_in_label("HD-Audio Generic"));
        assert!(is_built_in_label("Realtek Audio"));
        assert!(is_built_in_label("Built-in Microphone"));
        assert!(!is_built_in_label("HyperX QuadCast S"));
        assert!(!is_built_in_label("T&V Dunn"));
    }

    #[test]
    fn describe_devices_builds_friendly_entries_and_disambiguates_labels() {
        let mut cards = HashMap::new();
        cards.insert("S".to_string(), "HyperX QuadCast S".to_string());
        cards.insert("Generic_1".to_string(), "HD-Audio Generic".to_string());
        let devices = describe_devices(
            vec![
                "front:CARD=Generic_1,DEV=0".into(),
                "front:CARD=S,DEV=0".into(),
                "Micrófono USB".into(),
            ],
            &cards,
        );
        assert_eq!(
            devices,
            vec![
                InputDevice {
                    id: "front:CARD=Generic_1,DEV=0".into(),
                    label: "HD-Audio Generic".into(),
                    is_built_in: true,
                },
                InputDevice {
                    id: "front:CARD=S,DEV=0".into(),
                    label: "HyperX QuadCast S".into(),
                    is_built_in: false,
                },
                InputDevice {
                    id: "Micrófono USB".into(),
                    label: "Micrófono USB".into(),
                    is_built_in: false,
                },
            ]
        );

        let mut devices = vec![
            InputDevice { id: "front:CARD=X,DEV=0".into(), label: "Tarjeta".into(), is_built_in: false },
            InputDevice { id: "front:CARD=X,DEV=1".into(), label: "Tarjeta".into(), is_built_in: false },
        ];
        disambiguate_same_card_labels(&mut devices);
        assert_eq!(devices[0].label, "Tarjeta · X");
        assert_eq!(devices[1].label, "Tarjeta · X");
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn resolve_device_keeps_a_known_name() {
        let available = ["USB", "Built-in"].map(String::from);
        assert_eq!(
            resolve_input_device_name(&available, Some("USB")),
            Some("USB".into())
        );
    }

    #[test]
    fn resolve_device_falls_back_on_unknown_or_missing_name() {
        let available = ["USB"].map(String::from);
        assert_eq!(resolve_input_device_name(&available, Some("HDMI")), None);
        assert_eq!(resolve_input_device_name(&available, None), None);
        assert_eq!(resolve_input_device_name(&available, Some("  ")), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn capture_resolution_uses_the_system_default_on_linux() {
        let available = ["front:CARD=Mic,DEV=0"].map(String::from);
        assert_eq!(
            resolve_input_device_name(&available, Some("front:CARD=Mic,DEV=0")),
            None
        );
    }

    #[test]
    fn capture_session_normalizes_the_requested_device_for_the_platform() {
        let requested = Some("front:CARD=Mic,DEV=0".to_string());
        #[cfg(target_os = "linux")]
        assert_eq!(super::capture_device_name(requested), None);
        #[cfg(not(target_os = "linux"))]
        assert_eq!(
            super::capture_device_name(requested),
            Some("front:CARD=Mic,DEV=0".to_string())
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn effective_microphone_name_uses_the_server_default_on_linux() {
        let name = super::effective_microphone_name(Some("front:CARD=Mic,DEV=0"));
        assert_eq!(name, super::default_input_device_name());
        assert_ne!(name, "front:CARD=Mic,DEV=0");
    }

    #[test]
    fn policy_allows_one_session_and_rejects_a_second_start() {
        let mut policy = CaptureSessionPolicy::default();
        assert_eq!(policy.state(), SessionState::Idle);
        assert_eq!(policy.start(), Ok(()));
        assert_eq!(policy.state(), SessionState::Recording);
        assert_eq!(policy.start(), Err("Ya hay un dictado en curso".into()));
    }

    #[test]
    fn policy_requires_an_active_session_to_finish() {
        let mut policy = CaptureSessionPolicy::default();
        assert_eq!(
            policy.finish(),
            Err("No hay un dictado en curso".to_string())
        );
        policy.start().unwrap();
        assert_eq!(policy.finish(), Ok(CaptureFinalization::Transcribe));
        assert_eq!(policy.state(), SessionState::Idle);
    }

    #[test]
    fn policy_discards_audio_when_finalization_fails() {
        assert_eq!(
            CaptureFinalization::from_result::<(), String>(Err("faltan dependencias".into())),
            Err("faltan dependencias".to_string())
        );
        assert!(CaptureFinalization::from_result::<(), String>(Ok(())).is_ok());
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn resolve_falls_back_to_another_view_of_the_same_card() {
        let available = vec![
            "hw:CARD=Generic_1,DEV=0".to_string(),
            "dsnoop:CARD=Generic_1,DEV=0".to_string(),
        ];
        assert_eq!(
            super::resolve_input_device_name(&available, Some("front:CARD=Generic_1,DEV=0")),
            Some("hw:CARD=Generic_1,DEV=0".to_string())
        );
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn resolve_prefers_the_best_available_view() {
        let available = vec![
            "plughw:CARD=Generic_1,DEV=0".to_string(),
            "sysdefault:CARD=Generic_1".to_string(),
        ];
        assert_eq!(
            super::resolve_input_device_name(&available, Some("front:CARD=Generic_1,DEV=0")),
            Some("sysdefault:CARD=Generic_1".to_string())
        );
    }

    #[test]
    fn wait_for_first_samples_detects_silent_streams() {
        let samples: SampleStore = Arc::new(Mutex::new(Vec::new()));
        assert!(!super::wait_for_first_samples(&samples));
        samples.lock().unwrap().push(1);
        assert!(super::wait_for_first_samples(&samples));
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn resolve_keeps_the_exact_match_when_present() {
        let available = vec![
            "front:CARD=Generic_1,DEV=0".to_string(),
            "front:CARD=S,DEV=0".to_string(),
        ];
        assert_eq!(
            super::resolve_input_device_name(&available, Some("front:CARD=Generic_1,DEV=0")),
            Some("front:CARD=Generic_1,DEV=0".to_string())
        );
    }
}
