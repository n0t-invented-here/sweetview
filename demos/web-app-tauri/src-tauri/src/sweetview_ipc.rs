//! The Rust side of the Sweetview IPC frames over Tauri 2, as specified in
//! docs/ipc-tauri.md. Self-contained, so it can be copied into another Tauri
//! app: a page using `tauriTransport()` sends each call frame to the command
//! `sweetview_ipc` and receives event frames as the Tauri event
//! `sweetview-ipc:event`, scoped to its webview.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, EventTarget, Runtime};

/// The command name the page invokes. Tauri registers a command under its function's name, so the
/// `#[tauri::command] fn` that handles frames is named `sweetview_ipc`; this constant records the name.
#[allow(dead_code)]
pub const COMMAND: &str = "sweetview_ipc";
/// The event name every event frame is emitted under.
pub const EVENT: &str = "sweetview-ipc:event";

/// One `CallFrame`: `{ kind: "call", seq: string | null, method: string, params: unknown }`.
pub struct Call {
    pub seq: Option<String>,
    pub method: String,
    pub params: Value,
}

/// Decodes the `frame` argument. Anything that is not a call frame is an error,
/// which the command returns as `Err`, so the page's `invoke` rejects with it.
pub fn parse_call(frame: Value) -> Result<Call, String> {
    let Value::Object(mut map) = frame else {
        return Err("sweetview_ipc: frame is not an object".into());
    };
    if map.get("kind").and_then(Value::as_str) != Some("call") {
        return Err("sweetview_ipc: frame kind is not \"call\"".into());
    }
    let seq = match map.remove("seq") {
        Some(Value::String(s)) => Some(s),
        Some(Value::Null) | None => None,
        Some(_) => return Err("sweetview_ipc: seq is not a string or null".into()),
    };
    let method = match map.remove("method") {
        Some(Value::String(m)) => m,
        _ => return Err("sweetview_ipc: method is not a string".into()),
    };
    // a page that sends `params: undefined` omits the key: that is null here
    let params = map.remove("params").unwrap_or(Value::Null);
    Ok(Call {
        seq,
        method,
        params,
    })
}

/// The command's return value for a handled call: the `ReplyFrame`, or `null`
/// for a call with `seq: null`, whose failure is logged instead of answered.
pub fn reply(call: &Call, outcome: Result<Value, String>) -> Value {
    match (&call.seq, outcome) {
        (Some(seq), Ok(result)) => {
            json!({ "kind": "reply", "seq": seq, "ok": true, "result": result })
        }
        (Some(seq), Err(error)) => {
            json!({ "kind": "reply", "seq": seq, "ok": false, "error": error })
        }
        (None, Ok(_)) => Value::Null,
        (None, Err(error)) => {
            eprintln!("{} failed: {}", call.method, error);
            Value::Null
        }
    }
}

fn event_frame(name: &str, payload: Value) -> Value {
    json!({ "kind": "event", "name": name, "payload": payload })
}

/// Sends an event to every webview (every session).
pub fn emit<R: Runtime>(app: &AppHandle<R>, name: &str, payload: Value) {
    if let Err(err) = app.emit(EVENT, event_frame(name, payload)) {
        eprintln!("event {name} not sent: {err}");
    }
}

/// Sends an event to one webview, the session whose id is `label`.
pub fn emit_to<R: Runtime>(app: &AppHandle<R>, label: &str, name: &str, payload: Value) {
    if let Err(err) = app.emit_to(
        EventTarget::webview(label),
        EVENT,
        event_frame(name, payload),
    ) {
        eprintln!("event {name} not sent to {label}: {err}");
    }
}
