use ashpd::desktop::{
    global_shortcuts::{BindShortcutsOptions, GlobalShortcuts, NewShortcut},
    CreateSessionOptions,
};
use futures_util::{stream, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::RuntimeState;

const EVENT_NAME: &str = "wayland-hold-shortcut";
const SHORTCUT_ID: &str = "chamu_hold_dictation";
const SHORTCUT_DESCRIPTION: &str = "Iniciar dictado mientras se mantiene pulsado";

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

async fn run_portal_session_inner(shortcut: String, app: &AppHandle) -> Result<(), String> {
    let trigger = to_xdg_trigger(&shortcut);
    if trigger.is_empty() {
        return Err("El atajo Wayland no puede estar vacío".into());
    }

    let portal = GlobalShortcuts::new()
        .await
        .map_err(|error| format!("No se encontró el portal de atajos globales: {error}"))?;
    let session = portal
        .create_session(CreateSessionOptions::default())
        .await
        .map_err(|error| format!("No se pudo crear la sesión de atajos Wayland: {error}"))?;
    let shortcut =
        NewShortcut::new(SHORTCUT_ID, SHORTCUT_DESCRIPTION).preferred_trigger(trigger.as_str());
    let request = portal
        .bind_shortcuts(&session, &[shortcut], None, BindShortcutsOptions::default())
        .await
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

    emit_event(app, PortalEventKind::Registered, None)?;

    let activated = portal
        .receive_activated()
        .await
        .map_err(|error| format!("No se pudo escuchar la presión del atajo Wayland: {error}"))?
        .map(|event| (event.shortcut_id() == SHORTCUT_ID).then_some(PortalEventKind::Activated));
    let deactivated = portal
        .receive_deactivated()
        .await
        .map_err(|error| format!("No se pudo escuchar la liberación del atajo Wayland: {error}"))?
        .map(|event| (event.shortcut_id() == SHORTCUT_ID).then_some(PortalEventKind::Deactivated));
    let mut events = stream::select(activated, deactivated);
    while let Some(kind) = events.next().await {
        if let Some(kind) = kind {
            emit_event(app, kind, None)?;
        }
    }

    Ok(())
}

pub async fn run_portal_session(shortcut: String, app: AppHandle) -> Result<(), String> {
    let result = run_portal_session_inner(shortcut, &app).await;
    if let Err(error) = &result {
        let _ = emit_event(&app, PortalEventKind::Error, Some(error.clone()));
    }
    result
}

#[tauri::command]
pub(crate) fn configure_wayland_hold_shortcut(
    shortcut: String,
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    let shortcut = shortcut.trim().to_string();
    if shortcut.is_empty() {
        return Err("El atajo Wayland no puede estar vacío".into());
    }

    let mut active_task = state
        .wayland_shortcut_task
        .lock()
        .map_err(|_| "No se pudo actualizar la sesión de atajo Wayland".to_string())?;
    if let Some(task) = active_task.take() {
        task.abort();
    }

    let task = tauri::async_runtime::spawn(async move {
        let _ = run_portal_session(shortcut, app).await;
    });
    *active_task = Some(task);
    Ok(())
}

#[tauri::command]
pub(crate) fn clear_wayland_hold_shortcut(state: State<'_, RuntimeState>) -> Result<(), String> {
    let mut active_task = state
        .wayland_shortcut_task
        .lock()
        .map_err(|_| "No se pudo actualizar la sesión de atajo Wayland".to_string())?;
    if let Some(task) = active_task.take() {
        task.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{to_xdg_trigger, PortalEventKind};

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
}
