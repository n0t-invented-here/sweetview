//! The request path on a real WebView2: assets, the request handler, answers
//! from other threads, streaming, the frames origin, user scripts, background
//! colour, file-drop plumbing and navigation failures. One test function, so
//! one `tao` event loop serves every scenario in order.
#![cfg(windows)]

mod common;

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use common::{fetch_js, Ctx, View};
use serde_json::{json, Value};
use sweetview_platform_webview::{ErrorCode, NavigationFailure, RawRequest};

fn scenario(name: &str) {
    eprintln!("-- {name}");
}

fn fetch(ctx: &mut Ctx, view: &View, tag: &str, url: &str, init: &str) -> Value {
    view.eval(&fetch_js(tag, url, init));
    ctx.wait(view, tag)
}

#[test]
fn request_path_on_a_real_webview() {
    let mut ctx = Ctx::new();
    let view = ctx.view();
    let extras = view.extras();

    scenario("an asset is served at http://webview.localhost/");
    let ready = ctx.load_index(&view);
    assert_eq!(ready["origin"], "http://webview.localhost");
    assert_eq!(ready["path"], "/index.html");

    scenario("path matching rules (assets.md)");
    assert_eq!(extras.set_asset("a/b.js", "text/javascript", b"x".to_vec()), ErrorCode::Ok);
    assert_eq!(extras.set_asset("dir/", "text/plain", b"dir".to_vec()), ErrorCode::Ok);
    assert_eq!(extras.set_asset("a%20b.txt", "text/plain", b"encoded".to_vec()), ErrorCode::Ok);
    assert_eq!(extras.set_asset("bad.txt", "text/plain\r\nX: y", b"x".to_vec()), ErrorCode::InvalidArgument);
    let r = fetch(&mut ctx, &view, "m1", "/a/b.js?v=2#top", "{}");
    assert_eq!((r["status"].as_i64(), r["text"].as_str()), (Some(200), Some("x")), "{r}");
    assert_eq!(r["headers"]["content-type"], "text/javascript");
    let r = fetch(&mut ctx, &view, "m2", "http://webview.localhost//a/b.js", "{}");
    assert_eq!(r["status"], 200, "leading slashes are ignored: {r}");
    let r = fetch(&mut ctx, &view, "m3", "/dir/", "{}");
    assert_eq!((r["status"].as_i64(), r["text"].as_str()), (Some(200), Some("dir")), "{r}");
    let r = fetch(&mut ctx, &view, "m4", "/dir", "{}");
    assert_eq!(r["status"], 404, "the trailing slash is part of the key: {r}");
    let r = fetch(&mut ctx, &view, "m5", "/a%20b.txt", "{}");
    assert_eq!(r["text"], "encoded", "the raw path is matched, not percent-decoded: {r}");
    let r = fetch(&mut ctx, &view, "m6", "/bad.txt", "{}");
    assert_eq!(r["status"], 404, "a refused asset is not stored: {r}");

    scenario("the 404 rule: no asset and no handler");
    let r = fetch(&mut ctx, &view, "nf", "/missing", "{}");
    assert_eq!((r["status"].as_i64(), r["statusText"].as_str()), (Some(404), Some("Not Found")), "{r}");

    scenario("a handler-answered request: status, repeated headers, body bytes, POST body");
    let seen: Rc<RefCell<Vec<RawRequest>>> = Rc::default();
    let responder = extras.responder();
    {
        let seen = seen.clone();
        let responder = responder.clone();
        extras.set_request_handler(Some(Rc::new(move |req: RawRequest| {
            let id = req.id;
            let path = req.url.clone();
            seen.borrow_mut().push(req);
            if path.ends_with("/api/echo") {
                let code = responder.complete(
                    id,
                    201,
                    Some(r#"[["X-Multi","a"],["X-Multi","b"],["Content-Type","application/octet-stream"]]"#),
                    Some(&[0, 1, 2, 255]),
                );
                assert_eq!(code, ErrorCode::Ok);
            }
        })));
    }
    let r = fetch(
        &mut ctx,
        &view,
        "h1",
        "/api/echo",
        r#"{ method: 'POST', body: 'hello body', headers: { 'X-Test': 'one' } }"#,
    );
    assert_eq!(r["status"], 201, "{r}");
    assert_eq!(r["statusText"], "Created");
    assert_eq!(r["headers"]["x-multi"], "a, b");
    assert_eq!(r["bytes"], json!([0, 1, 2, 255]));
    {
        let seen = seen.borrow();
        let req = seen.last().expect("the handler saw the request");
        assert_eq!(req.method, "POST");
        assert_eq!(req.url, "http://webview.localhost/api/echo");
        assert_eq!(req.body.as_deref(), Some(b"hello body".as_slice()));
        let headers: Vec<(String, String)> = serde_json::from_str::<Vec<[String; 2]>>(&req.headers_json)
            .expect("headers_json is an array of pairs")
            .into_iter()
            .map(|[n, v]| (n, v))
            .collect();
        assert!(headers.iter().any(|(n, v)| n.eq_ignore_ascii_case("x-test") && v == "one"), "{headers:?}");
        assert!(req.id > 0);
    }
    seen.borrow_mut().clear();
    let r = fetch(&mut ctx, &view, "h2", "/a/b.js", "{}");
    assert_eq!(r["text"], "x", "assets answer first, with a handler set: {r}");
    assert!(seen.borrow().is_empty(), "the asset never reached the handler");

    scenario("a request answered later from another thread");
    let r = {
        let responder = responder.clone();
        extras.set_request_handler(Some(Rc::new(move |req: RawRequest| {
            let responder = responder.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(150));
                // Refused headers answer nothing, and the request stays open.
                assert_eq!(responder.complete(req.id, 200, Some(r#"{"X-Bad":"a\nb"}"#), None), ErrorCode::InvalidArgument);
                assert_eq!(responder.complete(req.id, 600, None, None), ErrorCode::InvalidArgument);
                let code = responder.complete(req.id, 200, Some(r#"{"Content-Type":"text/plain"}"#), Some(b"late"));
                assert_eq!(code, ErrorCode::Ok);
                // A second answer does nothing.
                assert_eq!(responder.complete(req.id, 500, None, Some(b"again")), ErrorCode::Ok);
            });
        })));
        fetch(&mut ctx, &view, "later", "/later", "{}")
    };
    assert_eq!((r["status"].as_i64(), r["text"].as_str()), (Some(200), Some("late")), "{r}");

    scenario("the 500 rule: a handler that panics without answering");
    extras.set_request_handler(Some(Rc::new(|_req: RawRequest| panic!("handler failure (expected by the test)"))));
    let r = fetch(&mut ctx, &view, "p1", "/boom", "{}");
    assert_eq!((r["status"].as_i64(), r["statusText"].as_str()), (Some(500), Some("Internal Server Error")), "{r}");
    scenario("a handler that answers and then panics keeps its answer");
    {
        let responder = responder.clone();
        extras.set_request_handler(Some(Rc::new(move |req: RawRequest| {
            assert_eq!(responder.complete(req.id, 202, None, Some(b"kept")), ErrorCode::Ok);
            panic!("after answering (expected by the test)");
        })));
    }
    let r = fetch(&mut ctx, &view, "p2", "/answered-then-panicked", "{}");
    assert_eq!((r["status"].as_i64(), r["text"].as_str()), (Some(202), Some("kept")), "{r}");

    scenario("the frames origin reaches the handler and is cross-origin from the page");
    {
        let responder = responder.clone();
        extras.set_request_handler(Some(Rc::new(move |req: RawRequest| {
            let body = "<!doctype html><script>parent.postMessage({ from: location.origin }, '*');</script>";
            let status = if req.url.starts_with("http://frames.webview.localhost/") { 200 } else { 404 };
            responder.complete(req.id, status, Some(r#"{"Content-Type":"text/html"}"#), Some(body.as_bytes()));
        })));
    }
    view.eval(
        r#"(() => {
  window.addEventListener('message', (e) => {
    const frame = document.getElementById('f');
    let readable = true;
    try { void frame.contentWindow.document.body; } catch (err) { readable = false; }
    post({ tag: 'frame', origin: e.origin, from: e.data.from, readable });
  }, { once: true });
  const f = document.createElement('iframe');
  f.id = 'f';
  f.src = 'http://frames.webview.localhost/frame.html';
  document.body.appendChild(f);
})()"#,
    );
    let r = ctx.wait(&view, "frame");
    assert_eq!(r["origin"], "http://frames.webview.localhost", "{r}");
    assert_eq!(r["from"], "http://frames.webview.localhost");
    assert_eq!(r["readable"], false, "the page cannot reach into the frame's document");

    scenario("a streamed response: begin, chunks from another thread, end; duplicate begin; chunk after end");
    let (codes_tx, codes_rx) = mpsc::channel::<Vec<(&'static str, ErrorCode)>>();
    {
        let responder = responder.clone();
        extras.set_request_handler(Some(Rc::new(move |req: RawRequest| {
            let responder = responder.clone();
            let codes_tx = codes_tx.clone();
            thread::spawn(move || {
                let id = req.id;
                let mut codes = vec![("begin", responder.begin(id, 200, Some(r#"{"Content-Type":"text/plain"}"#)))];
                codes.push(("begin again", responder.begin(id, 200, None)));
                codes.push(("complete after begin", responder.complete(id, 500, None, Some(b"never"))));
                for chunk in ["one ", "two ", "three"] {
                    thread::sleep(Duration::from_millis(40));
                    codes.push(("chunk", responder.write_chunk(id, chunk.as_bytes())));
                }
                codes.push(("empty chunk", responder.write_chunk(id, b"")));
                codes.push(("end", responder.end(id)));
                codes.push(("chunk after end", responder.write_chunk(id, b" late")));
                codes.push(("end again", responder.end(id)));
                codes_tx.send(codes).unwrap();
            });
        })));
    }
    let r = fetch(&mut ctx, &view, "stream", "/stream", "{}");
    assert_eq!((r["status"].as_i64(), r["text"].as_str()), (Some(200), Some("one two three")), "{r}");
    assert_eq!(r["headers"]["content-type"], "text/plain");
    let codes = codes_rx.recv_timeout(Duration::from_secs(5)).expect("stream codes");
    assert_eq!(codes[0], ("begin", ErrorCode::Ok));
    assert_eq!(codes[1], ("begin again", ErrorCode::Duplicate));
    for (what, code) in &codes[2..] {
        assert_eq!(*code, ErrorCode::Ok, "{what}");
    }

    scenario("background colour: alpha 0 and 255 accepted, any other alpha refused");
    assert_eq!(extras.set_background_color(10, 20, 30, 128), ErrorCode::Unspecified);
    assert_eq!(extras.set_background_color(10, 20, 30, 1), ErrorCode::Unspecified);
    assert_eq!(extras.set_background_color(255, 255, 255, 255), ErrorCode::Ok);
    assert_eq!(extras.set_background_color(0, 0, 0, 0), ErrorCode::Ok);

    scenario("a user script added, then removed");
    let us1 = extras.add_user_script("window.__us1 = 1;").expect("add_user_script");
    let ready = ctx.load_index(&view);
    assert_eq!(ready["us1"], "number", "the script ran in the next document: {ready}");
    extras.remove_user_script(us1);
    let ready = ctx.load_index(&view);
    assert_eq!(ready["us1"], "undefined", "the removed script no longer runs: {ready}");

    scenario("several scripts added, then a navigation at once: every one runs");
    // `load_index` calls `load_url` straight after the last add, with no pump in
    // between: every script must be registered by the time `add_user_script`
    // returns.
    let names = ["a", "b", "c", "d", "e"];
    let mut scripts = Vec::new();
    for name in names {
        scripts.push(extras.add_user_script(&format!("window.__script_{name} = true;")).expect("add_user_script"));
    }
    let ready = ctx.load_index(&view);
    assert_eq!(ready["scripts"], json!(["__script_a", "__script_b", "__script_c", "__script_d", "__script_e"]), "{ready}");
    scenario("a script removed, then a navigation at once: it no longer runs");
    let c = scripts.remove(2);
    extras.remove_user_script(c);
    let ready = ctx.load_index(&view);
    assert_eq!(ready["scripts"], json!(["__script_a", "__script_b", "__script_d", "__script_e"]), "{ready}");
    for script in scripts {
        extras.remove_user_script(script);
    }
    let ready = ctx.load_index(&view);
    assert_eq!(ready["scripts"], json!([]), "{ready}");

    scenario("file drop plumbing: the drop script's flag follows the handler, in later documents too");
    assert_eq!(ready["drop"], false, "the drop script is installed and starts disabled: {ready}");
    let dropped: Rc<RefCell<Vec<Vec<String>>>> = Rc::default();
    {
        let dropped = dropped.clone();
        assert_eq!(extras.set_file_drop_handler(Some(Rc::new(move |paths| dropped.borrow_mut().push(paths)))), ErrorCode::Ok);
    }
    let drop_probe = r#"(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['x'], 'made-in-page.txt', { type: 'text/plain' }));
  const e = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  post({ tag: 'probe', flag: window.__webview_file_drop_enabled__, prevented: e.defaultPrevented });
})()"#;
    view.eval(drop_probe);
    let r = ctx.wait(&view, "probe");
    assert_eq!((r["flag"].as_bool(), r["prevented"].as_bool()), (Some(true), Some(true)), "{r}");
    let ready = ctx.load_index(&view);
    assert_eq!(ready["drop"], false, "a new document's script starts disabled");
    view.eval(drop_probe);
    let r = ctx.wait(&view, "probe");
    assert_eq!(r["flag"], true, "ContentLoading switched it on in the new document: {r}");
    ctx.settle(Some(&view), Duration::from_millis(200));
    assert!(dropped.borrow().is_empty(), "a File made in the page has no path, so the handler is not called");
    assert_eq!(extras.set_file_drop_handler(None), ErrorCode::Ok);
    view.eval(drop_probe);
    let r = ctx.wait(&view, "probe");
    assert_eq!((r["flag"].as_bool(), r["prevented"].as_bool()), (Some(false), Some(false)), "{r}");
    // External drops are allowed by default; the setting is read back from WebView2 itself.
    assert_eq!(extras.allows_external_drop(), Some(true));
    assert_eq!(extras.set_allow_external_drop(false), ErrorCode::Ok);
    assert_eq!(extras.allows_external_drop(), Some(false));
    assert_eq!(extras.set_allow_external_drop(true), ErrorCode::Ok);
    assert_eq!(extras.allows_external_drop(), Some(true));

    scenario("navigation failures are reported; HTTP error responses are not");
    let failures: Rc<RefCell<Vec<NavigationFailure>>> = Rc::default();
    {
        let failures = failures.clone();
        extras.set_navigation_failed_handler(Some(Rc::new(move |f| failures.borrow_mut().push(f))));
    }
    extras.set_request_handler(None);
    extras.note_host_navigation();
    view.webview().load_url("http://webview.localhost/no-such-page").unwrap();
    ctx.settle(Some(&view), Duration::from_millis(800));
    assert!(failures.borrow().is_empty(), "a 404 response shows the server's page and is not a failure");
    extras.note_host_navigation();
    view.webview().load_url("http://sweetview-test.invalid/").unwrap();
    let reported = ctx.pump(Some(&view), Duration::from_secs(15), || !failures.borrow().is_empty());
    assert!(reported, "the failed navigation was reported");
    {
        let failures = failures.borrow();
        let f = &failures[0];
        assert_eq!(f.url, "http://sweetview-test.invalid/");
        assert!(!f.reason.is_empty());
        assert!(f.is_current());
        eprintln!("   reported: {f:?}");
        extras.note_host_navigation();
        assert!(!f.is_current(), "a host navigation after it makes it stale");
    }

    scenario("focus and popup position calls");
    // Focus is `wry`'s own `WebView::focus` (`MoveFocus`, programmatic).
    let _ = view.webview().focus();
    extras.notify_parent_window_position_changed();
    assert_eq!(extras.call_devtools_protocol_method("Runtime.enable", "{}"), ErrorCode::Ok);

    drop(view);
    ctx.settle(None, Duration::from_millis(200));
}
