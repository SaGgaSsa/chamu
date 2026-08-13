use ashpd::{
    desktop::{
        global_shortcuts::{
            BindShortcutsOptions, ConfigureShortcutsOptions, GlobalShortcuts, ListShortcutsOptions,
            NewShortcut,
        },
        CreateSessionOptions, Session,
    },
    register_host_app_with_connection, AppID,
};
use futures_util::StreamExt;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

use crate::RuntimeState;

const EVENT_NAME: &str = "wayland-hold-shortcut";
const SHORTCUT_ID: &str = "chamu_hold_dictation";
const SHORTCUT_DESCRIPTION: &str = "Iniciar dictado mientras se mantiene pulsado";
const CHAMU_APP_ID: &str = "com.chamu.desktop";
const HOST_REGISTRY_INTERFACE: &str = "org.freedesktop.host.portal.Registry";
const CLEANUP_PENDING_MESSAGE: &str =
    "La limpieza de una sesión Wayland anterior todavía está pendiente";

// Keep one detached cleanup at most. Both portal waits are bounded, so
// process shutdown has a finite policy even if the portal does not answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CleanupPolicy {
    create_session_timeout: Duration,
    close_timeout: Duration,
    max_pending: usize,
}

const CLEANUP_POLICY: CleanupPolicy = CleanupPolicy {
    create_session_timeout: Duration::from_secs(2),
    close_timeout: Duration::from_secs(2),
    max_pending: 1,
};

pub(crate) struct WaylandShortcutTask {
    generation: u64,
    cancel: Option<oneshot::Sender<()>>,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Debug, Default)]
pub(crate) struct ShortcutLifecycleState {
    current_generation: u64,
}

impl ShortcutLifecycleState {
    fn register_request(&mut self) -> u64 {
        self.current_generation = self.current_generation.wrapping_add(1);
        if self.current_generation == 0 {
            self.current_generation = 1;
        }
        self.current_generation
    }

    fn is_current(&self, generation: u64) -> bool {
        is_current_generation(self.current_generation, generation)
    }
}

#[derive(Debug, Default)]
pub(crate) struct ShortcutCleanupState {
    pending: usize,
}

impl ShortcutCleanupState {
    fn reserve(&mut self) -> bool {
        if self.pending >= CLEANUP_POLICY.max_pending {
            return false;
        }
        self.pending += 1;
        true
    }

    fn release(&mut self) {
        self.pending = self.pending.saturating_sub(1);
    }

    fn is_pending(&self) -> bool {
        self.pending > 0
    }
}

struct CleanupLease {
    state: Arc<Mutex<ShortcutCleanupState>>,
}

impl Drop for CleanupLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.release();
        }
    }
}

type PortalCreateResult = (
    GlobalShortcuts,
    Result<Session<GlobalShortcuts>, ashpd::Error>,
);
type PortalCreateTask = tauri::async_runtime::JoinHandle<PortalCreateResult>;
type PortalCloseTask = tauri::async_runtime::JoinHandle<Result<(), String>>;

fn cleanup_state(app: &AppHandle) -> Arc<Mutex<ShortcutCleanupState>> {
    app.state::<RuntimeState>().wayland_shortcut_cleanup.clone()
}

fn ensure_cleanup_available(app: &AppHandle) -> Result<(), String> {
    let state = cleanup_state(app);
    let cleanup = state
        .lock()
        .map_err(|_| "No se pudo comprobar la limpieza del atajo Wayland".to_string())?;
    if cleanup.is_pending() {
        return Err(CLEANUP_PENDING_MESSAGE.into());
    }
    Ok(())
}

fn reserve_cleanup(app: &AppHandle) -> Result<CleanupLease, String> {
    let state = cleanup_state(app);
    let mut cleanup = state
        .lock()
        .map_err(|_| "No se pudo reservar la limpieza del atajo Wayland".to_string())?;
    if !cleanup.reserve() {
        return Err(CLEANUP_PENDING_MESSAGE.into());
    }
    drop(cleanup);
    Ok(CleanupLease { state })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortalShortcutEvent {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PortalConfigurationAction {
    BindOnly,
    Configure,
    ExplainDesktopAssignment,
}

pub(crate) fn configuration_action(
    portal_version: u32,
    requested_change: bool,
) -> PortalConfigurationAction {
    if !requested_change {
        PortalConfigurationAction::BindOnly
    } else if portal_version >= 2 {
        PortalConfigurationAction::Configure
    } else {
        PortalConfigurationAction::ExplainDesktopAssignment
    }
}

pub(crate) fn stream_end_error(stream: &str) -> String {
    format!("El stream portal {stream} terminó sin cancelación")
}

pub(crate) fn shortcut_change_trigger_description<'a, I>(
    event_session_handle: &str,
    expected_session_handle: &str,
    shortcuts: I,
) -> Option<String>
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    if event_session_handle != expected_session_handle {
        return None;
    }

    shortcuts
        .into_iter()
        .find(|(shortcut_id, _)| *shortcut_id == SHORTCUT_ID)
        .map(|(_, trigger_description)| trigger_description.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortalEventKind {
    Registered,
    Activated,
    Deactivated,
    Error,
}

impl PortalEventKind {
    pub fn status(self) -> &'static str {
        match self {
            Self::Registered => "registered",
            Self::Activated => "pressed",
            Self::Deactivated => "released",
            Self::Error => "error",
        }
    }
}

/// Converts the application shortcut format to the XDG shortcut syntax.
///
/// The renderer stores browser/tauri key names, while the portal expects XKB
/// names. Modifiers use the names from the freedesktop shortcuts
/// specification. The application currently stores one main key, so unknown
/// tokens are preserved after a conservative normalization.
pub fn to_xdg_trigger(shortcut: &str) -> String {
    shortcut
        .split('+')
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(|token| {
            modifier_to_xdg(token)
                .map(str::to_owned)
                .unwrap_or_else(|| key_to_xdg(token))
        })
        .collect::<Vec<_>>()
        .join("+")
}

fn modifier_to_xdg(token: &str) -> Option<&'static str> {
    match token.to_ascii_lowercase().as_str() {
        "commandorcontrol" | "control" | "ctrl" => Some("CTRL"),
        "alt" | "option" => Some("ALT"),
        "shift" => Some("SHIFT"),
        "command" | "logo" | "meta" | "os" | "super" | "win" | "windows" => Some("LOGO"),
        "num" | "numlock" => Some("NUM"),
        _ => None,
    }
}

fn key_to_xdg(token: &str) -> String {
    let normalized = token.trim();
    let lowercase = normalized.to_ascii_lowercase();
    match lowercase.as_str() {
        "space" => "space".into(),
        "enter" | "return" => "Return".into(),
        "esc" | "escape" => "Escape".into(),
        "backspace" => "BackSpace".into(),
        "tab" => "Tab".into(),
        "arrowdown" | "down" => "Down".into(),
        "arrowleft" | "left" => "Left".into(),
        "arrowright" | "right" => "Right".into(),
        "arrowup" | "up" => "Up".into(),
        "begin" => "Begin".into(),
        "break" => "Break".into(),
        "capslock" => "Caps_Lock".into(),
        "cancel" => "Cancel".into(),
        "clear" => "Clear".into(),
        "delete" => "Delete".into(),
        "end" => "End".into(),
        "execute" => "Execute".into(),
        "find" => "Find".into(),
        "help" => "Help".into(),
        "home" => "Home".into(),
        "insert" => "Insert".into(),
        "menu" => "Menu".into(),
        "pageup" => "Page_Up".into(),
        "pagedown" => "Page_Down".into(),
        "pause" => "Pause".into(),
        "print" | "printscreen" => "Print".into(),
        "redo" => "Redo".into(),
        "select" => "Select".into(),
        "scrolllock" => "Scroll_Lock".into(),
        "sysreq" => "Sys_Req".into(),
        "undo" => "Undo".into(),
        "numpadadd" => "KP_Add".into(),
        "numpaddecimal" => "KP_Decimal".into(),
        "numpaddivide" => "KP_Divide".into(),
        "numpadenter" => "KP_Enter".into(),
        "numpadequal" => "KP_Equal".into(),
        "numpadmultiply" => "KP_Multiply".into(),
        "numpadsubtract" => "KP_Subtract".into(),
        "backquote" | "grave" => "grave".into(),
        "bracketleft" => "bracketleft".into(),
        "bracketright" => "bracketright".into(),
        "backslash" => "backslash".into(),
        "comma" => "comma".into(),
        "equal" => "equal".into(),
        "minus" => "minus".into(),
        "period" => "period".into(),
        "quote" => "apostrophe".into(),
        "semicolon" => "semicolon".into(),
        "slash" => "slash".into(),
        _ if normalized.len() == 1 && normalized.as_bytes()[0].is_ascii_alphanumeric() => {
            normalized.to_ascii_lowercase()
        }
        _ if lowercase.starts_with("key") && lowercase.len() == 4 => lowercase[3..].to_string(),
        _ if lowercase.starts_with("digit") && lowercase.len() == 6 => lowercase[5..].to_string(),
        _ if function_key_number(normalized).is_some() => {
            format!("F{}", function_key_number(normalized).unwrap())
        }
        _ if lowercase.starts_with('f') && lowercase[1..].parse::<u8>().is_ok() => {
            normalized.to_ascii_uppercase()
        }
        _ => normalized.to_string(),
    }
}

fn function_key_number(token: &str) -> Option<u8> {
    let lowercase = token.trim().to_ascii_lowercase();
    let suffix = lowercase.strip_prefix('f')?;
    if suffix.is_empty() || !suffix.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }

    suffix
        .parse::<u8>()
        .ok()
        .filter(|number| (1..=35).contains(number))
}

fn is_known_main_key(token: &str) -> bool {
    let normalized = token.trim();
    let lowercase = normalized.to_ascii_lowercase();
    matches!(
        lowercase.as_str(),
        "space"
            | "enter"
            | "return"
            | "esc"
            | "escape"
            | "backspace"
            | "tab"
            | "arrowdown"
            | "down"
            | "arrowleft"
            | "left"
            | "arrowright"
            | "right"
            | "arrowup"
            | "up"
            | "begin"
            | "break"
            | "capslock"
            | "cancel"
            | "clear"
            | "delete"
            | "end"
            | "execute"
            | "find"
            | "help"
            | "home"
            | "insert"
            | "menu"
            | "pageup"
            | "pagedown"
            | "pause"
            | "print"
            | "printscreen"
            | "redo"
            | "select"
            | "scrolllock"
            | "sysreq"
            | "undo"
            | "numpadadd"
            | "numpaddecimal"
            | "numpaddivide"
            | "numpadenter"
            | "numpadequal"
            | "numpadmultiply"
            | "numpadsubtract"
            | "backquote"
            | "grave"
            | "bracketleft"
            | "bracketright"
            | "backslash"
            | "comma"
            | "equal"
            | "minus"
            | "period"
            | "quote"
            | "semicolon"
            | "slash"
    ) || (normalized.len() == 1 && normalized.as_bytes()[0].is_ascii_alphanumeric())
        || (lowercase.starts_with("key")
            && lowercase.len() == 4
            && lowercase.as_bytes()[3].is_ascii_alphabetic())
        || (lowercase.starts_with("digit")
            && lowercase.len() == 6
            && lowercase.as_bytes()[5].is_ascii_digit())
        || function_key_number(normalized).is_some()
}

fn validate_shortcut(shortcut: &str) -> Result<(), String> {
    if shortcut.trim().is_empty() {
        return Err("El atajo Wayland no puede estar vacío".into());
    }

    let tokens = shortcut.split('+').map(str::trim).collect::<Vec<_>>();
    if tokens.iter().any(|token| token.is_empty()) {
        return Err("El atajo Wayland contiene un elemento vacío".into());
    }

    let mut modifier_count = 0;
    let mut main_key_count = 0;
    let mut modifiers = Vec::new();
    for token in tokens {
        if let Some(modifier) = modifier_to_xdg(token) {
            modifier_count += 1;
            if modifiers.contains(&modifier) {
                return Err("El atajo Wayland no puede repetir modificadores".into());
            }
            modifiers.push(modifier);
        } else if is_known_main_key(token) {
            main_key_count += 1;
        } else {
            return Err(format!("La tecla principal Wayland no es válida: {token}"));
        }
    }

    if !(1..=2).contains(&modifier_count) {
        return Err("El atajo Wayland debe tener uno o dos modificadores".into());
    }
    if main_key_count != 1 {
        return Err("El atajo Wayland debe tener exactamente una tecla principal".into());
    }

    Ok(())
}

fn emit_event(
    app: &AppHandle,
    kind: PortalEventKind,
    message: Option<String>,
    trigger_description: Option<String>,
) -> Result<(), String> {
    app.emit(
        EVENT_NAME,
        PortalShortcutEvent {
            status: kind.status().to_string(),
            message,
            trigger_description,
        },
    )
    .map_err(|error| format!("No se pudo emitir el estado del atajo Wayland: {error}"))
}

fn emit_event_if_current(
    app: &AppHandle,
    generation: u64,
    kind: PortalEventKind,
    message: Option<String>,
    trigger_description: Option<String>,
) -> Result<(), String> {
    let state = app.state::<RuntimeState>();
    let lifecycle = state
        .wayland_shortcut_lifecycle
        .lock()
        .map_err(|_| "No se pudo comprobar la generación del atajo Wayland".to_string())?;
    if !lifecycle.is_current(generation) {
        return Ok(());
    }

    emit_event(app, kind, message, trigger_description)
}

fn is_current_generation(current_generation: u64, event_generation: u64) -> bool {
    current_generation == event_generation
}

fn clear_task_for_generation(app: &AppHandle, generation: u64) {
    let state = app.state::<RuntimeState>();
    let Ok(mut active_task) = state.wayland_shortcut_task.lock() else {
        return;
    };
    if active_task
        .as_ref()
        .is_some_and(|task| task.generation == generation)
    {
        active_task.take();
    }
}

fn event_matches_session(
    session_handle: &str,
    shortcut_id: &str,
    expected_session_handle: &str,
) -> bool {
    session_handle == expected_session_handle && shortcut_id == SHORTCUT_ID
}

fn session_handle_string(session: &Session<GlobalShortcuts>) -> Result<String, String> {
    serde_json::to_value(session)
        .map_err(|error| format!("No se pudo leer la sesión de atajos Wayland: {error}"))?
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "El portal devolvió una sesión Wayland inválida".to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionRunOutcome {
    Cancelled,
}

async fn run_portal_session_with_session(
    portal: &GlobalShortcuts,
    session: &Session<GlobalShortcuts>,
    trigger: &str,
    app: &AppHandle,
    generation: u64,
    request_configuration: bool,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<SessionRunOutcome, String> {
    let session_handle = session_handle_string(session)?;
    let shortcut = NewShortcut::new(SHORTCUT_ID, SHORTCUT_DESCRIPTION).preferred_trigger(trigger);
    let shortcuts = [shortcut];

    let request = tokio::select! {
        result = portal.bind_shortcuts(
            session,
            &shortcuts,
            None,
            BindShortcutsOptions::default(),
        ) => result,
        _ = &mut *cancel => return Ok(SessionRunOutcome::Cancelled),
    }
    .map_err(|error| format!("No se pudo solicitar el atajo al portal Wayland: {error}"))?;
    let bound = request
        .response()
        .map_err(|error| format!("El portal no asignó el atajo Wayland: {error}"))?;
    let assigned = bound
        .shortcuts()
        .iter()
        .find(|registered| registered.id() == SHORTCUT_ID)
        .ok_or_else(|| "El portal no asignó el atajo Wayland solicitado".to_string())?;
    let mut trigger_description = assigned.trigger_description().to_string();
    let configuration_decision = configuration_action(portal.version(), request_configuration);
    let mut shortcuts_changed = if configuration_decision == PortalConfigurationAction::Configure {
        Some(
            tokio::select! {
                result = portal.receive_shortcuts_changed() => result,
                _ = &mut *cancel => return Ok(SessionRunOutcome::Cancelled),
            }
            .map_err(|error| format!("No se pudo escuchar los cambios del atajo Wayland: {error}"))?,
        )
    } else {
        None
    };
    let configuration_message = match configuration_decision {
        PortalConfigurationAction::BindOnly => None,
        PortalConfigurationAction::Configure => {
            tokio::select! {
                result = portal.configure_shortcuts(
                    session,
                    None,
                    ConfigureShortcutsOptions::default(),
                ) => result,
                _ = &mut *cancel => return Ok(SessionRunOutcome::Cancelled),
            }
            .map_err(|error| format!("No se pudo abrir la configuración del atajo Wayland: {error}"))?;

            let listed = tokio::select! {
                result = portal.list_shortcuts(session, ListShortcutsOptions::default()) => result,
                _ = &mut *cancel => return Ok(SessionRunOutcome::Cancelled),
            }
            .map_err(|error| format!("No se pudo leer la asignación del atajo Wayland: {error}"))?
            .response()
            .map_err(|error| format!("El portal no devolvió la asignación del atajo Wayland: {error}"))?;
            let assigned = listed
                .shortcuts()
                .iter()
                .find(|registered| registered.id() == SHORTCUT_ID)
                .ok_or_else(|| "El portal no devolvió el atajo Wayland configurado".to_string())?;
            trigger_description = assigned.trigger_description().to_string();
            None
        }
        PortalConfigurationAction::ExplainDesktopAssignment => Some(
            "El escritorio mantiene este enlace; usa su configuración de atajos para cambiarlo"
                .to_string(),
        ),
    };

    let mut activated = tokio::select! {
        result = portal.receive_activated() => result,
        _ = &mut *cancel => return Ok(SessionRunOutcome::Cancelled),
    }
    .map_err(|error| format!("No se pudo escuchar la presión del atajo Wayland: {error}"))?;
    let mut deactivated = tokio::select! {
        result = portal.receive_deactivated() => result,
        _ = &mut *cancel => return Ok(SessionRunOutcome::Cancelled),
    }
    .map_err(|error| format!("No se pudo escuchar la liberación del atajo Wayland: {error}"))?;
    let mut closed = tokio::select! {
        result = session.receive_closed() => result,
        _ = &mut *cancel => return Ok(SessionRunOutcome::Cancelled),
    }
    .map_err(|error| format!("No se pudo escuchar el cierre de la sesión Wayland: {error}"))?;

    // Todas las suscripciones están activas antes de emitir `registered`.
    emit_event_if_current(
        app,
        generation,
        PortalEventKind::Registered,
        configuration_message,
        Some(trigger_description),
    )?;

    loop {
        tokio::select! {
            _ = &mut *cancel => return Ok(SessionRunOutcome::Cancelled),
            event = activated.next() => {
                let event = match event {
                    Some(event) => event,
                    None => return Err(stream_end_error("activated")),
                };
                if event_matches_session(
                    event.session_handle().as_str(),
                    event.shortcut_id(),
                    &session_handle,
                ) {
                    emit_event_if_current(app, generation, PortalEventKind::Activated, None, None)?;
                }
            }
            event = deactivated.next() => {
                let event = match event {
                    Some(event) => event,
                    None => return Err(stream_end_error("deactivated")),
                };
                if event_matches_session(
                    event.session_handle().as_str(),
                    event.shortcut_id(),
                    &session_handle,
                ) {
                    emit_event_if_current(app, generation, PortalEventKind::Deactivated, None, None)?;
                }
            }
            changed_event = async {
                match shortcuts_changed.as_mut() {
                    Some(stream) => stream.next().await,
                    None => futures_util::future::pending::<Option<_>>().await,
                }
            } => {
                let event = match changed_event {
                    Some(event) => event,
                    None => return Err(stream_end_error("shortcuts_changed")),
                };
                let trigger_description = shortcut_change_trigger_description(
                    event.session_handle().as_str(),
                    &session_handle,
                    event
                        .shortcuts()
                        .iter()
                        .map(|shortcut| (shortcut.id(), shortcut.trigger_description())),
                );
                if let Some(trigger_description) = trigger_description {
                    emit_event_if_current(
                        app,
                        generation,
                        PortalEventKind::Registered,
                        Some("La asignación del portal se actualizó".into()),
                        Some(trigger_description),
                    )?;
                }
            }
            closed_event = closed.next() => {
                match closed_event {
                    Some(_) => return Err("El portal cerró la sesión de atajo Wayland".into()),
                    None => return Err(stream_end_error("closed")),
                }
            }
        }
    }
}

async fn finish_close_cleanup(mut close_task: PortalCloseTask) {
    if tokio::time::timeout(CLEANUP_POLICY.close_timeout, &mut close_task)
        .await
        .is_err()
    {
        close_task.abort();
    }
}

fn schedule_close_cleanup(app: &AppHandle, close_task: PortalCloseTask) -> Result<(), String> {
    let lease = match reserve_cleanup(app) {
        Ok(lease) => lease,
        Err(error) => {
            // The lifecycle invariant permits one pending cleanup. Abort is
            // only the bounded fallback if that invariant is violated.
            close_task.abort();
            return Err(error);
        }
    };
    tauri::async_runtime::spawn(async move {
        let _lease = lease;
        finish_close_cleanup(close_task).await;
    });
    Ok(())
}

async fn close_session_with_timeout(
    app: &AppHandle,
    session: Session<GlobalShortcuts>,
) -> Result<(), String> {
    let mut close_task = tauri::async_runtime::spawn(async move {
        session
            .close()
            .await
            .map_err(|error| format!("No se pudo cerrar la sesión de atajos Wayland: {error}"))
    });
    match tokio::time::timeout(CLEANUP_POLICY.close_timeout, &mut close_task).await {
        Ok(result) => match result {
            Ok(result) => result,
            Err(error) => Err(format!(
                "La tarea de cierre de sesión Wayland falló: {error}"
            )),
        },
        Err(_) => {
            let timeout_message =
                "Se agotó el tiempo de cierre de la sesión de atajos Wayland".to_string();
            if let Err(error) = schedule_close_cleanup(app, close_task) {
                return Err(format!("{timeout_message}: {error}"));
            }
            Err(timeout_message)
        }
    }
}

fn schedule_create_cleanup(
    app: &AppHandle,
    mut creation_task: PortalCreateTask,
) -> Result<(), String> {
    let lease = match reserve_cleanup(app) {
        Ok(lease) => lease,
        Err(error) => {
            // No second unbounded create task is allowed. The portal
            // connection is dropped after cancelling this exact request.
            creation_task.abort();
            return Err(error);
        }
    };
    tauri::async_runtime::spawn(async move {
        let _lease = lease;
        match tokio::time::timeout(CLEANUP_POLICY.create_session_timeout, &mut creation_task).await
        {
            Ok(Ok((_, Ok(session)))) => {
                let close_task = tauri::async_runtime::spawn(async move {
                    session.close().await.map_err(|error| {
                        format!("No se pudo cerrar la sesión de atajos Wayland: {error}")
                    })
                });
                finish_close_cleanup(close_task).await;
            }
            Ok(Ok((_, Err(_)))) | Ok(Err(_)) => {}
            Err(_) => {
                creation_task.abort();
            }
        }
    });
    Ok(())
}

async fn create_session_with_cancellation(
    portal: GlobalShortcuts,
    app: &AppHandle,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<Option<(GlobalShortcuts, Session<GlobalShortcuts>)>, String> {
    let mut creation_task: PortalCreateTask = tauri::async_runtime::spawn(async move {
        let result = portal.create_session(CreateSessionOptions::default()).await;
        (portal, result)
    });

    tokio::select! {
        result = &mut creation_task => {
            let (portal, session_result) = result
                .map_err(|error| format!("La tarea de creación de sesión Wayland falló: {error}"))?;
            let session = session_result
                .map_err(|error| format!("No se pudo crear la sesión de atajos Wayland: {error}"))?;
            Ok(Some((portal, session)))
        }
        _ = &mut *cancel => {
            // Keep the exact create request bounded. If it returns a Session
            // after cancellation, the cleanup task closes it explicitly.
            schedule_create_cleanup(app, creation_task)?;
            Ok(None)
        }
    }
}

fn host_registration_error(error: &str) -> String {
    format!(
        "No se pudo registrar Chamu ante el portal Wayland ({CHAMU_APP_ID}): {error}"
    )
}

fn is_missing_host_registry(error: &ashpd::Error) -> bool {
    match error {
        ashpd::Error::PortalNotFound(interface) => interface.as_str() == HOST_REGISTRY_INTERFACE,
        _ => false,
    }
}

async fn register_host_for_global_shortcuts() -> Result<GlobalShortcuts, String> {
    let connection = ashpd::zbus::Connection::session()
        .await
        .map_err(|error| format!("No se pudo conectar al bus de sesión Wayland: {error}"))?;
    let app_id = AppID::try_from(CHAMU_APP_ID)
        .map_err(|error| format!("El identificador de Chamu es inválido: {error}"))?;
    match register_host_app_with_connection(connection.clone(), app_id).await {
        Ok(()) => {}
        Err(error) if is_missing_host_registry(&error) => {}
        Err(error) => return Err(host_registration_error(&error.to_string())),
    }
    GlobalShortcuts::with_connection(connection)
        .await
        .map_err(|error| format!("No se encontró el portal de atajos globales: {error}"))
}

async fn run_portal_session_inner(
    shortcut: String,
    app: &AppHandle,
    generation: u64,
    request_configuration: bool,
    mut cancel: oneshot::Receiver<()>,
) -> Result<(), String> {
    validate_shortcut(&shortcut)?;
    let trigger = to_xdg_trigger(&shortcut);
    if trigger.is_empty() {
        return Err("El atajo Wayland no puede estar vacío".into());
    }
    ensure_cleanup_available(app)?;

    let portal = tokio::select! {
        result = register_host_for_global_shortcuts() => result,
        _ = &mut cancel => return Ok(()),
    }?;
    let Some((portal, session)) =
        create_session_with_cancellation(portal, app, &mut cancel).await?
    else {
        return Ok(());
    };

    let result = run_portal_session_with_session(
        &portal,
        &session,
        trigger.as_str(),
        app,
        generation,
        request_configuration,
        &mut cancel,
    )
    .await;
    let _close_result = close_session_with_timeout(app, session).await;

    match result {
        Err(error) => Err(error),
        Ok(SessionRunOutcome::Cancelled) => Ok(()),
    }
}

pub async fn run_portal_session(
    shortcut: String,
    app: AppHandle,
    generation: u64,
    request_configuration: bool,
    cancel: oneshot::Receiver<()>,
) -> Result<(), String> {
    let result = run_portal_session_inner(
        shortcut,
        &app,
        generation,
        request_configuration,
        cancel,
    )
    .await;
    if let Err(error) = &result {
        let _ = emit_event_if_current(
            &app,
            generation,
            PortalEventKind::Error,
            Some(error.clone()),
            None,
        );
    }
    clear_task_for_generation(&app, generation);
    result
}

async fn stop_active_session(state: &RuntimeState) -> Result<(), String> {
    let active_task = {
        let mut active_task = state
            .wayland_shortcut_task
            .lock()
            .map_err(|_| "No se pudo actualizar la sesión de atajo Wayland".to_string())?;
        active_task.take()
    };

    if let Some(mut active_task) = active_task {
        if let Some(cancel) = active_task.cancel.take() {
            let _ = cancel.send(());
        }
        // La tarea cierra la sesión del portal antes de terminar. No uses
        // JoinHandle::abort, porque abortar omite esta limpieza.
        let _ = active_task.task.await;
    }

    Ok(())
}

fn register_request(state: &RuntimeState) -> Result<u64, String> {
    state
        .wayland_shortcut_lifecycle
        .lock()
        .map(|mut lifecycle| lifecycle.register_request())
        .map_err(|_| "No se pudo registrar la solicitud del atajo Wayland".to_string())
}

fn is_current_request(state: &RuntimeState, generation: u64) -> Result<bool, String> {
    state
        .wayland_shortcut_lifecycle
        .lock()
        .map(|lifecycle| lifecycle.is_current(generation))
        .map_err(|_| "No se pudo comprobar la solicitud del atajo Wayland".to_string())
}

#[tauri::command]
pub(crate) async fn configure_wayland_hold_shortcut(
    shortcut: String,
    request_configuration: Option<bool>,
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    let shortcut = shortcut.trim().to_string();
    if shortcut.is_empty() {
        return Err("El atajo Wayland no puede estar vacío".into());
    }
    validate_shortcut(&shortcut)?;

    let generation = register_request(&state)?;
    let _operation = state.wayland_shortcut_operation.lock().await;
    if !is_current_request(&state, generation)? {
        return Ok(());
    }
    stop_active_session(&state).await?;
    if !is_current_request(&state, generation)? {
        return Ok(());
    }
    ensure_cleanup_available(&app)?;

    let (cancel, cancel_receiver) = oneshot::channel();
    let mut active_task = state
        .wayland_shortcut_task
        .lock()
        .map_err(|_| "No se pudo actualizar la sesión de atajo Wayland".to_string())?;
    let task = tauri::async_runtime::spawn(async move {
        let _ = run_portal_session(
            shortcut,
            app,
            generation,
            request_configuration.unwrap_or(false),
            cancel_receiver,
        )
        .await;
    });
    *active_task = Some(WaylandShortcutTask {
        generation,
        cancel: Some(cancel),
        task,
    });
    Ok(())
}

pub(crate) async fn probe_portal() -> Result<u32, String> {
    GlobalShortcuts::new()
        .await
        .map(|portal| portal.version())
        .map_err(|error| format!("No se encontró el portal de atajos globales: {error}"))
}

#[tauri::command]
pub(crate) async fn clear_wayland_hold_shortcut(
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    let generation = register_request(&state)?;
    let _operation = state.wayland_shortcut_operation.lock().await;
    if !is_current_request(&state, generation)? {
        return Ok(());
    }
    stop_active_session(&state).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        configuration_action, event_matches_session, is_current_generation,
        host_registration_error, is_missing_host_registry, shortcut_change_trigger_description,
        stream_end_error, to_xdg_trigger, validate_shortcut, CleanupPolicy,
        PortalConfigurationAction, PortalEventKind, ShortcutCleanupState, ShortcutLifecycleState,
        CLEANUP_POLICY, HOST_REGISTRY_INTERFACE, SHORTCUT_ID,
    };

    fn interface_name(name: &str) -> ashpd::zbus::names::OwnedInterfaceName {
        name.try_into().expect("test interface name must be valid")
    }

    #[test]
    fn falls_back_only_when_host_registry_interface_is_missing() {
        let error = ashpd::Error::PortalNotFound(interface_name(HOST_REGISTRY_INTERFACE));

        assert!(is_missing_host_registry(&error));
    }

    #[test]
    fn keeps_real_registry_rejections_as_terminal_errors() {
        let error = ashpd::Error::Portal(ashpd::PortalError::NotAllowed(
            "Register rejected".into(),
        ));

        assert!(!is_missing_host_registry(&error));
    }

    #[test]
    fn does_not_treat_another_missing_portal_interface_as_registry_fallback() {
        let error = ashpd::Error::PortalNotFound(interface_name(
            "org.freedesktop.portal.GlobalShortcuts",
        ));

        assert!(!is_missing_host_registry(&error));
    }

    #[test]
    fn converts_chamu_shortcut_to_xdg_trigger() {
        assert_eq!(
            to_xdg_trigger("CommandOrControl+Shift+Space"),
            "CTRL+SHIFT+space"
        );
    }

    #[test]
    fn converts_all_supported_modifier_aliases() {
        assert_eq!(
            to_xdg_trigger("Ctrl+Alt+Shift+Meta+NumpadAdd"),
            "CTRL+ALT+SHIFT+LOGO+KP_Add"
        );
    }

    #[test]
    fn converts_browser_key_names_to_xkb_names() {
        assert_eq!(to_xdg_trigger("Ctrl+ArrowDown"), "CTRL+Down");
        assert_eq!(to_xdg_trigger("Alt+Enter"), "ALT+Return");
        assert_eq!(to_xdg_trigger("Shift+F12"), "SHIFT+F12");
        assert_eq!(to_xdg_trigger("Ctrl+PageDown"), "CTRL+Page_Down");
        assert_eq!(to_xdg_trigger("Ctrl+ScrollLock"), "CTRL+Scroll_Lock");
    }

    #[test]
    fn normalizes_supported_function_keys_and_rejects_out_of_range_keys() {
        assert_eq!(to_xdg_trigger("Ctrl+F1"), "CTRL+F1");
        assert_eq!(to_xdg_trigger("Ctrl+F01"), "CTRL+F1");
        assert_eq!(to_xdg_trigger("Ctrl+F35"), "CTRL+F35");
        assert!(validate_shortcut("Ctrl+F1").is_ok());
        assert!(validate_shortcut("Ctrl+F01").is_ok());
        assert!(validate_shortcut("Ctrl+F35").is_ok());
        assert!(validate_shortcut("Ctrl+F36").is_err());
    }

    #[test]
    fn maps_portal_state_to_frontend_status() {
        assert_eq!(PortalEventKind::Activated.status(), "pressed");
        assert_eq!(PortalEventKind::Deactivated.status(), "released");
    }

    #[test]
    fn exposes_the_portal_configuration_decision_for_v1_and_v2() {
        assert_eq!(
            configuration_action(1, false),
            PortalConfigurationAction::BindOnly
        );
        assert_eq!(
            configuration_action(1, true),
            PortalConfigurationAction::ExplainDesktopAssignment
        );
        assert_eq!(
            configuration_action(2, true),
            PortalConfigurationAction::Configure
        );
    }

    #[test]
    fn filters_shortcuts_changed_by_session_and_shortcut_id() {
        let session = "/org/freedesktop/portal/desktop/session/1";
        let other_session = "/org/freedesktop/portal/desktop/session/2";
        assert_eq!(
            shortcut_change_trigger_description(
                session,
                session,
                [("other_shortcut", "Ctrl+Alt+B"), (SHORTCUT_ID, "Ctrl+Alt+A")],
            ),
            Some("Ctrl+Alt+A".to_string())
        );
        assert_eq!(
            shortcut_change_trigger_description(
                other_session,
                session,
                [(SHORTCUT_ID, "Ctrl+Alt+A")],
            ),
            None
        );
        assert_eq!(
            shortcut_change_trigger_description(
                session,
                session,
                [("other_shortcut", "Ctrl+Alt+B")],
            ),
            None
        );
    }

    #[test]
    fn treats_every_non_cancelled_stream_end_as_an_error() {
        assert!(stream_end_error("activated").contains("activated"));
        assert!(stream_end_error("deactivated").contains("deactivated"));
        assert!(stream_end_error("closed").contains("closed"));
    }

    #[test]
    fn formats_host_registration_error_with_application_id() {
        let message = host_registration_error("portal rejected");
        assert_eq!(
            message,
            "No se pudo registrar Chamu ante el portal Wayland (com.chamu.desktop): portal rejected"
        );
    }

    #[test]
    fn ignores_events_from_other_sessions_or_shortcuts() {
        assert!(event_matches_session(
            "/org/freedesktop/portal/desktop/session/1",
            SHORTCUT_ID,
            "/org/freedesktop/portal/desktop/session/1",
        ));
        assert!(!event_matches_session(
            "/org/freedesktop/portal/desktop/session/2",
            SHORTCUT_ID,
            "/org/freedesktop/portal/desktop/session/1",
        ));
        assert!(!event_matches_session(
            "/org/freedesktop/portal/desktop/session/1",
            "other-shortcut",
            "/org/freedesktop/portal/desktop/session/1",
        ));
    }

    #[test]
    fn ignores_events_from_stale_generations() {
        assert!(is_current_generation(7, 7));
        assert!(!is_current_generation(8, 7));
    }

    #[test]
    fn accepts_one_or_two_known_modifiers_and_one_main_key() {
        assert!(validate_shortcut("Ctrl+Space").is_ok());
        assert!(validate_shortcut("CommandOrControl+Shift+Space").is_ok());
    }

    #[test]
    fn rejects_missing_or_extra_main_keys() {
        assert!(validate_shortcut("Ctrl").is_err());
        assert!(validate_shortcut("Ctrl+Space+Enter").is_err());
    }

    #[test]
    fn rejects_unknown_or_too_many_modifiers() {
        assert!(validate_shortcut("UnknownModifier+Space").is_err());
        assert!(validate_shortcut("Ctrl+Alt+Shift+Space").is_err());
    }

    #[test]
    fn request_generation_is_monotonic_and_latest_wins() {
        let mut lifecycle = ShortcutLifecycleState::default();
        let first = lifecycle.register_request();
        let second = lifecycle.register_request();

        assert!(second > first);
        assert!(!lifecycle.is_current(first));
        assert!(lifecycle.is_current(second));
    }

    #[test]
    fn cleanup_state_deduplicates_pending_cleanup() {
        let mut cleanup = ShortcutCleanupState::default();
        assert!(cleanup.reserve());
        assert!(!cleanup.reserve());
        assert!(cleanup.is_pending());
        cleanup.release();
        assert!(!cleanup.is_pending());
        assert!(cleanup.reserve());
    }

    #[test]
    fn cleanup_policy_has_bounded_single_pending_cleanup() {
        assert_eq!(
            CLEANUP_POLICY,
            CleanupPolicy {
                create_session_timeout: std::time::Duration::from_secs(2),
                close_timeout: std::time::Duration::from_secs(2),
                max_pending: 1,
            }
        );
        assert!(CLEANUP_POLICY.create_session_timeout > std::time::Duration::ZERO);
        assert!(CLEANUP_POLICY.close_timeout > std::time::Duration::ZERO);
        assert_eq!(CLEANUP_POLICY.max_pending, 1);
    }
}
