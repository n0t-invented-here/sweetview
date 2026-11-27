// The web-app demo's page in a Tauri 2 window. The page (the web-app frontend,
// unchanged) picks tauriTransport(); its calls arrive at the `sweetview_ipc`
// command below and are answered by backend.rs; events go back as the
// `sweetview-ipc:event` Tauri event. Each webview is one session, its label
// the session id.
//
// WEB_APP_PROBE=1 evaluates demos/web-app/scripts/shell-probe.js in the page
// once it has loaded, prints the page's report as one `PROBE {...}` line, and
// exits.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod sweetview_ipc;

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, State, WindowEvent};

use backend::Backend;

const PROBE_SCRIPT: &str = include_str!("../../../web-app/scripts/shell-probe.js");

pub(crate) fn probing() -> bool {
    std::env::var("WEB_APP_PROBE").as_deref() == Ok("1")
}

/// The one command of the protocol: a `CallFrame` in, the `ReplyFrame` (or null) out.
#[tauri::command]
fn sweetview_ipc(
    app: AppHandle,
    webview: tauri::Webview,
    backend: State<'_, Backend>,
    frame: Value,
) -> Result<Value, String> {
    let call = sweetview_ipc::parse_call(frame)?;
    let session = webview.label().to_string();
    if probing() {
        println!("host: call {} from tauri session {}", call.method, session);
    }
    let outcome = backend.call(&app, &session, &call.method, &call.params);
    Ok(sweetview_ipc::reply(&call, outcome))
}

/// Receives the probe's report from the page, prints it, and exits.
#[tauri::command]
fn probe_report(app: AppHandle, report: String) {
    println!("PROBE {report}");
    app.exit(if report.starts_with("FAILED") { 1 } else { 0 });
}

fn main() {
    let probed = AtomicBool::new(false);
    tauri::Builder::default()
        .manage(Backend::new())
        .invoke_handler(tauri::generate_handler![sweetview_ipc, probe_report])
        .on_page_load(move |webview, payload| {
            if !probing() || payload.event() != PageLoadEvent::Finished || probed.swap(true, Ordering::SeqCst) {
                return;
            }
            let script = format!(
                "Promise.resolve({PROBE_SCRIPT}\n).then((r) => JSON.stringify(r), (e) => `FAILED ${{e && e.message}}`).then((report) => window.__TAURI_INTERNALS__.invoke('probe_report', {{ report }}));"
            );
            if let Err(err) = webview.eval(&script) {
                eprintln!("probe not evaluated: {err}");
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                // one webview per window here, with the window's label: its session ends with it
                window.app_handle().state::<Backend>().end_session(window.label());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the Tauri application");
}
