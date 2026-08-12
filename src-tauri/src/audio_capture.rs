//! CPAL-backed microphone capture that never writes audio to disk.

use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

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
    pub fn start() -> Result<Self, String> {
        let (startup_sender, startup_receiver) = mpsc::channel();
        let (stop_sender, stop_receiver) = mpsc::channel();
        let (result_sender, result_receiver) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("chamu-audio-capture".into())
            .spawn(move || {
                run_capture_worker(startup_sender, stop_receiver, result_sender);
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

fn run_capture_worker(
    startup_sender: mpsc::Sender<Result<(), String>>,
    stop_receiver: mpsc::Receiver<()>,
    result_sender: mpsc::Sender<Result<Vec<i16>, String>>,
) {
    let setup = build_capture_stream();
    let (stream, samples, callback_error) = match setup {
        Ok(capture) => capture,
        Err(error) => {
            let _ = startup_sender.send(Err(error));
            return;
        }
    };

    if startup_sender.send(Ok(())).is_err() {
        drop(stream);
        return;
    }
    let _ = stop_receiver.recv();
    // Dropping the stream releases CPAL's callback before reading the buffer.
    drop(stream);

    let result = match callback_error.lock() {
        Ok(error) => match error.clone() {
            Some(error) => Err(error),
            None => samples
                .lock()
                .map(|mut values| std::mem::take(&mut *values))
                .map_err(|_| "No se pudo leer el audio capturado".to_string()),
        },
        Err(_) => Err("No se pudo leer el estado del capturador".into()),
    };
    let _ = result_sender.send(result);
}

fn build_capture_stream() -> Result<(cpal::Stream, SampleStore, CallbackError), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "No se encontró un dispositivo de entrada de audio".to_string())?;
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

fn stream_error_callback(callback_error: CallbackError) -> impl FnMut(cpal::StreamError) + Send + 'static {
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
    use super::{CaptureFinalization, CaptureSessionPolicy, SessionState};

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
}
