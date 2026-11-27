//! The web-app demo's methods, answered in Rust. A subset of
//! demos/web-app/packages/web-app-backend: runtime info and the shared notes
//! list in full; folder watching, the folder picker and notifications answer
//! with an error, as the web host does for the desktop-only ones.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

use crate::sweetview_ipc;

/// Broadcasts an event; in probe mode, logs it as the Electron shell does.
fn emit<R: Runtime>(app: &AppHandle<R>, name: &str, payload: Value) {
    if crate::probing() {
        println!("host: event {name} -> every session");
    }
    sweetview_ipc::emit(app, name, payload);
}

/// Sends an event to one session (webview label); in probe mode, logs it.
fn emit_to<R: Runtime>(app: &AppHandle<R>, session: &str, name: &str, payload: Value) {
    if crate::probing() {
        println!("host: event {name} -> {session}");
    }
    sweetview_ipc::emit_to(app, session, name, payload);
}

struct Note {
    id: u64,
    text: String,
    created_at: String,
}

impl Note {
    fn to_json(&self) -> Value {
        json!({ "id": self.id, "text": self.text, "createdAt": self.created_at })
    }
}

struct State {
    notes: Vec<Note>,
    next_id: u64,
    sessions: HashSet<String>,
}

pub struct Backend {
    state: Mutex<State>,
}

/// An ISO 8601 UTC timestamp with milliseconds, like JavaScript's `toISOString()`.
fn now_iso() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

/// Node's names for the platform and architecture, which the page labels.
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}
fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

impl Backend {
    pub fn new() -> Self {
        let now = now_iso();
        Backend {
            state: Mutex::new(State {
                notes: vec![
                    Note {
                        id: 1,
                        text: "Answered by the Rust backend of the Tauri shell".into(),
                        created_at: now.clone(),
                    },
                    Note {
                        id: 2,
                        text: "Rendered with Mantine".into(),
                        created_at: now,
                    },
                ],
                next_id: 3,
                sessions: HashSet::new(),
            }),
        }
    }

    pub fn end_session(&self, session: &str) {
        self.state.lock().unwrap().sessions.remove(session);
    }

    /// One method call for `session` (the webview label). `Err` is the user-safe message of an error reply.
    pub fn call<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        session: &str,
        method: &str,
        params: &Value,
    ) -> Result<Value, String> {
        let not_watching = json!({ "watching": false, "path": null });
        match method {
            "info.get" => {
                let mut state = self.state.lock().unwrap();
                state.sessions.insert(session.to_string());
                Ok(json!({
                    "runtime": format!("Rust backend, Tauri {}", tauri::VERSION),
                    "platform": node_platform(),
                    "arch": node_arch(),
                    "pid": std::process::id(),
                    "compiled": true,
                    "cwd": std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default(),
                    "host": "tauri",
                    "sessions": state.sessions.len(),
                }))
            }
            "notes.list" => Ok(self.notes_json()),
            "notes.add" => {
                let text = params
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if text.is_empty() {
                    return Err("text is required".into());
                }
                let note = {
                    let mut state = self.state.lock().unwrap();
                    let note = Note {
                        id: state.next_id,
                        text,
                        created_at: now_iso(),
                    };
                    state.next_id += 1;
                    let json = note.to_json();
                    state.notes.push(note);
                    json
                };
                emit(app, "notes.changed", self.notes_json());
                Ok(note)
            }
            "notes.remove" => {
                let id = params
                    .get("id")
                    .and_then(Value::as_u64)
                    .ok_or("id is required")?;
                {
                    let mut state = self.state.lock().unwrap();
                    let i = state
                        .notes
                        .iter()
                        .position(|n| n.id == id)
                        .ok_or_else(|| format!("note {id} not found"))?;
                    state.notes.remove(i);
                }
                emit(app, "notes.changed", self.notes_json());
                Ok(Value::Null)
            }
            "watch.status" => Ok(not_watching),
            "watch.stop" => {
                emit_to(app, session, "watch.status", not_watching.clone());
                Ok(not_watching)
            }
            "watch.start" => Err("the Tauri demo's Rust backend does not watch folders".into()),
            "ui.theme" => Ok(Value::Null),
            "pick.folder" => {
                Err("no native folder picker in the Tauri demo; type a path instead".into())
            }
            "notify.status" | "notify.onChanges" | "notify.test" => {
                Err("system notifications come from the Sweetview desktop app".into())
            }
            _ => Err(format!("unknown method {method}")),
        }
    }

    fn notes_json(&self) -> Value {
        Value::Array(
            self.state
                .lock()
                .unwrap()
                .notes
                .iter()
                .map(Note::to_json)
                .collect(),
        )
    }
}
