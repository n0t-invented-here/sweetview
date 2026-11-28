//! Requests a shared worker makes reach the request handler: the filters are
//! added for every request source kind (`ICoreWebView2_22`), so the worker's
//! own script and a fetch it makes are both answered by the application.
//! `rust-rewrite/PORT-STATUS.md` section 3 row "Requests from a shared worker".
#![cfg(windows)]

mod common;

use std::cell::RefCell;
use std::rc::Rc;

use common::Ctx;
use sweetview_platform_webview::{ErrorCode, RawRequest};

/// The shared worker: on its first connection it fetches a path of the page's origin and
/// posts what it was answered back through the port.
const WORKER_JS: &str = "onconnect = (e) => { const port = e.ports[0]; fetch('/from-shared-worker').then((r) => r.text()).then((t) => port.postMessage(t), (err) => port.postMessage('error ' + err)); };";

#[test]
fn requests_from_a_shared_worker_reach_the_request_handler() {
    let mut ctx = Ctx::new();
    let view = ctx.view();
    let extras = view.extras();
    ctx.load_index(&view);
    let seen: Rc<RefCell<Vec<String>>> = Rc::default();
    let responder = extras.responder();
    {
        let seen = seen.clone();
        extras.set_request_handler(Some(Rc::new(move |request: RawRequest| {
            seen.borrow_mut().push(request.url.clone());
            let (kind, body): (&str, &[u8]) = if request.url.ends_with("/shared-worker.js") {
                ("text/javascript", WORKER_JS.as_bytes())
            } else {
                ("text/plain", b"answered for the shared worker")
            };
            let headers = format!(r#"[["Content-Type","{kind}"]]"#);
            assert_eq!(responder.complete(request.id, 200, Some(&headers), Some(body)), ErrorCode::Ok);
        })));
    }
    view.eval("(() => { const w = new SharedWorker('/shared-worker.js'); w.port.onmessage = (e) => post({ tag: 'worker', text: e.data }); w.port.start(); })()");
    let reply = ctx.wait(&view, "worker");
    assert_eq!(reply["text"], "answered for the shared worker", "{reply}");
    let seen = seen.borrow();
    assert!(seen.iter().any(|url| url.ends_with("/shared-worker.js")), "the worker's script: {seen:?}");
    assert!(seen.iter().any(|url| url.ends_with("/from-shared-worker")), "the worker's fetch: {seen:?}");
}
