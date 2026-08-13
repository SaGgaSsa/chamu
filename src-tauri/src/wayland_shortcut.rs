use ashpd::desktop::{
    global_shortcuts::{BindShortcutsOptions, GlobalShortcuts, NewShortcut},
    CreateSessionOptions, Session,
};
use futures_util::StreamExt;
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

use crate::RuntimeState;

const EVENT_NAME: &str = "wayland-hold-shortcut";
const SHORTCUT_ID: &str = "chamu_hold_dictation";
const SHORTCUT_DESCRIPTION: &str = "Iniciar dictado mientras se mantiene pulsado";

pub(crate) struct WaylandShortcutTask {
    cancel: Option<oneshot::Sender<()>>,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortalShortcutEvent {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
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
        _ if lowercase.starts_with('f') && lowercase[1..].parse::<u8>().is_ok() => {
            normalized.to_ascii_uppercase()
        }
        _ => normalized.to_string(),
    }
}

fn emit_event(
    app: &AppHandle,
    kind: PortalEventKind,
    message: Option<String>,
) -> Result<(), String> {
    app.emit(
        EVENT_NAME,
        PortalShortcutEvent {
            status: kind.status().to_string(),
            message,
        },
    )
    .map_err(|error| format!("No se pudo emitir el estado del atajo Wayland: {error}"))
}

fn emit_event_if_current(
    app: &AppHandle,
    generation: u64,
    kind: PortalEventKind,
    message: Option<String>,
) -> Result<(), String> {
    let state = app.state::<RuntimeState>();
    if !is_current_generation(
        state.wayland_shortcut_generation.load(Ordering::SeqCst),
        generation,
    ) {
        return Ok(());
    }

    emit_event(app, kind, message)
}

fn is_current_generation(current_generation: u64, event_generation: u64) -> bool {
    current_generation == event_generation
}

fn clear_task_for_generation(app: &AppHandle, generation: u64) {
    let state = app.state::<RuntimeState>();
    let Ok(mut active_task) = state.wayland_shortcut_task.lock() else {
        return;
    };
    if is_current_generation(
        state.wayland_shortcut_generation.load(Ordering::SeqCst),
        generation,
    ) {
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
    Completed,
    Cancelled,
}

async fn run_portal_session_with_session(
    portal: &GlobalShortcuts,
    session: &Session<GlobalShortcuts>,
    trigger: &str,
    app: &AppHandle,
    generation: u64,
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
    if !bound
        .shortcuts()
        .iter()
        .any(|registered| registered.id() == SHORTCUT_ID)
    {
        return Err("El portal no asignó el atajo Wayland solicitado".into());
    }

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
    emit_event_if_current(app, generation, PortalEventKind::Registered, None)?;

    loop {
        tokio::select! {
            _ = &mut *cancel => return Ok(SessionRunOutcome::Cancelled),
            event = activated.next() => {
                let event = match event {
                    Some(event) => event,
                    None => return Ok(SessionRunOutcome::Completed),
                };
                if event_matches_session(
                    event.session_handle().as_str(),
                    event.shortcut_id(),
                    &session_handle,
                ) {
                    emit_event_if_current(app, generation, PortalEventKind::Activated, None)?;
                }
            }
            event = deactivated.next() => {
                let event = match event {
                    Some(event) => event,
                    None => return Ok(SessionRunOutcome::Completed),
                };
                if event_matches_session(
                    event.session_handle().as_str(),
                    event.shortcut_id(),
                    &session_handle,
                ) {
                    emit_event_if_current(app, generation, PortalEventKind::Deactivated, None)?;
                }
            }
            closed_event = closed.next() => {
                match closed_event {
                    Some(_) => return Err("El portal cerró la sesión de atajo Wayland".into()),
                    None => return Ok(SessionRunOutcome::Completed),
                }
            }
        }
    }
}

async fn run_portal_session_inner(
    shortcut: String,
    app: &AppHandle,
    generation: u64,
    mut cancel: oneshot::Receiver<()>,
) -> Result<(), String> {
    let trigger = to_xdg_trigger(&shortcut);
    if trigger.is_empty() {
        return Err("El atajo Wayland no puede estar vacío".into());
    }

    let portal = tokio::select! {
        result = GlobalShortcuts::new() => result,
        _ = &mut cancel => return Ok(()),
    }
    .map_err(|error| format!("No se encontró el portal de atajos globales: {error}"))?;
    // Después de iniciar la creación, espera el identificador de sesión.
    // Así la cancelación puede cerrar una sesión creada en paralelo.
    let session = portal
        .create_session(CreateSessionOptions::default())
        .await
        .map_err(|error| format!("No se pudo crear la sesión de atajos Wayland: {error}"))?;

    let result = run_portal_session_with_session(
        &portal,
        &session,
        trigger.as_str(),
        app,
        generation,
        &mut cancel,
    )
    .await;
    let close_result = session
        .close()
        .await
        .map_err(|error| format!("No se pudo cerrar la sesión de atajos Wayland: {error}"));

    match result {
        Err(error) => Err(error),
        Ok(SessionRunOutcome::Cancelled) => Ok(()),
        Ok(SessionRunOutcome::Completed) => close_result.map(|_| ()),
    }
}

pub async fn run_portal_session(
    shortcut: String,
    app: AppHandle,
    generation: u64,
    cancel: oneshot::Receiver<()>,
) -> Result<(), String> {
    let result = run_portal_session_inner(shortcut, &app, generation, cancel).await;
    if let Err(error) = &result {
        let _ = emit_event_if_current(
            &app,
            generation,
            PortalEventKind::Error,
            Some(error.clone()),
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

fn next_generation(state: &RuntimeState) -> u64 {
    state
        .wayland_shortcut_generation
        .fetch_add(1, Ordering::SeqCst)
        .wrapping_add(1)
}

#[tauri::command]
pub(crate) async fn configure_wayland_hold_shortcut(
    shortcut: String,
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    let shortcut = shortcut.trim().to_string();
    if shortcut.is_empty() {
        return Err("El atajo Wayland no puede estar vacío".into());
    }

    let _operation = state.wayland_shortcut_operation.lock().await;
    let generation = next_generation(&state);
    stop_active_session(&state).await?;

    let (cancel, cancel_receiver) = oneshot::channel();
    let mut active_task = state
        .wayland_shortcut_task
        .lock()
        .map_err(|_| "No se pudo actualizar la sesión de atajo Wayland".to_string())?;
    let task = tauri::async_runtime::spawn(async move {
        let _ = run_portal_session(shortcut, app, generation, cancel_receiver).await;
    });
    *active_task = Some(WaylandShortcutTask {
        cancel: Some(cancel),
        task,
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn clear_wayland_hold_shortcut(
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    let _operation = state.wayland_shortcut_operation.lock().await;
    next_generation(&state);
    stop_active_session(&state).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        event_matches_session, is_current_generation, to_xdg_trigger, PortalEventKind, SHORTCUT_ID,
    };

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
    fn maps_portal_state_to_frontend_status() {
        assert_eq!(PortalEventKind::Activated.status(), "pressed");
        assert_eq!(PortalEventKind::Deactivated.status(), "released");
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
}
