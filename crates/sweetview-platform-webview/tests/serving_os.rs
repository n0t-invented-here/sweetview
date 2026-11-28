//! What a page fetches from a real WebView2, beyond `requests.rs`: the asset table's remaining
//! rules, the frames origin with no handler, the head of a streamed answer and the calls around
//! one, the header JSON a responder refuses, a service worker's own fetch, and Server-Sent
//! Events written in pieces from another thread. Moved here from the native package's
//! `webview.test.ts` (W2.2, W2.4, W2.5) and `request-handler.test.ts` (W2.7). One test
//! function, so one `tao` event loop serves every scenario in order.
#![cfg(windows)]

mod common;

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use common::{fetch_js, Ctx, View};
use serde_json::Value;
use sweetview_platform_webview::{ErrorCode, RawRequest, Responder};

const TEXT: &str = "text/plain; charset=utf-8";

fn scenario(name: &str) {
    eprintln!("-- {name}");
}

fn fetch(ctx: &mut Ctx, view: &View, tag: &str, url: &str) -> Value {
    view.eval(&fetch_js(tag, url, "{}"));
    ctx.wait(view, tag)
}

/// Status and text of a fetch, for the assertions that need no more.
fn answer(r: &Value) -> (Option<i64>, Option<&str>) {
    (r["status"].as_i64(), r["text"].as_str())
}

fn path_of(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let path = rest.find('/').map_or("/", |at| &rest[at..]);
    path.split(['?', '#']).next().unwrap_or(path)
}

/// A WebView2 profile of this process's own, as each fixture of the native package had: a
/// service worker registered by an earlier run stays in a profile, and the scenario below is
/// about one registered now. Earlier runs' profiles are removed, where their browser has ended.
fn use_fresh_profile() {
    let base = std::env::temp_dir();
    let prefix = "sweetview-platform-webview-serving-os-";
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(prefix) {
                let _in_use_is_kept = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", base.join(format!("{prefix}{}", std::process::id())));
}

#[test]
fn serving_rules_beyond_the_request_path() {
    use_fresh_profile();
    let mut ctx = Ctx::new();
    let view = ctx.view();
    let extras = view.extras();
    ctx.load_index(&view);

    scenario("an asset set again under the same path replaces its bytes");
    assert_eq!(extras.set_asset("a.txt", TEXT, b"A1".to_vec()), ErrorCode::Ok);
    assert_eq!(answer(&fetch(&mut ctx, &view, "a1", "/a.txt")), (Some(200), Some("A1")));
    assert_eq!(extras.set_asset("a.txt", TEXT, b"A2".to_vec()), ErrorCode::Ok);
    let r = fetch(&mut ctx, &view, "a2", "/a.txt");
    assert_eq!(answer(&r), (Some(200), Some("A2")), "{r}");
    assert_eq!(r["headers"]["content-type"], TEXT, "the MIME type is the Content-Type: {r}");

    scenario("the raw path is the key: its percent-decoded form is not found");
    assert_eq!(extras.set_asset("x%41.txt", TEXT, b"raw-percent".to_vec()), ErrorCode::Ok);
    assert_eq!(answer(&fetch(&mut ctx, &view, "raw", "/x%41.txt")), (Some(200), Some("raw-percent")));
    assert_eq!(fetch(&mut ctx, &view, "decoded", "/xA.txt")["status"], 404);

    scenario("an asset with no trailing slash is not a request with one");
    assert_eq!(extras.set_asset("dir2", TEXT, b"no-slash".to_vec()), ErrorCode::Ok);
    assert_eq!(answer(&fetch(&mut ctx, &view, "dir2", "/dir2")), (Some(200), Some("no-slash")));
    assert_eq!(fetch(&mut ctx, &view, "dir2-slash", "/dir2/")["status"], 404);

    scenario("leading slashes in the asset's path are ignored");
    assert_eq!(extras.set_asset("/lead.txt", TEXT, b"one-leading".to_vec()), ErrorCode::Ok);
    assert_eq!(extras.set_asset("///many.txt", TEXT, b"many-leading".to_vec()), ErrorCode::Ok);
    assert_eq!(answer(&fetch(&mut ctx, &view, "lead", "/lead.txt")), (Some(200), Some("one-leading")));
    assert_eq!(answer(&fetch(&mut ctx, &view, "many", "/many.txt")), (Some(200), Some("many-leading")));

    scenario("a query string and fragment in the asset's path are ignored");
    assert_eq!(extras.set_asset("q.txt?ignored=1#frag", TEXT, b"query-in-path".to_vec()), ErrorCode::Ok);
    assert_eq!(answer(&fetch(&mut ctx, &view, "q", "/q.txt")), (Some(200), Some("query-in-path")));

    scenario("byte and empty bodies; a tab in the MIME type");
    assert_eq!(extras.set_asset("bytes.bin", "application/octet-stream", vec![0, 1, 2, 255]), ErrorCode::Ok);
    assert_eq!(extras.set_asset("empty.txt", TEXT, Vec::new()), ErrorCode::Ok);
    assert_eq!(extras.set_asset("tab.txt", "text/plain;\tcharset=utf-8", b"tab-ok".to_vec()), ErrorCode::Ok);
    let r = fetch(&mut ctx, &view, "bytes", "/bytes.bin");
    assert_eq!((r["status"].as_i64(), r["bytes"].clone()), (Some(200), serde_json::json!([0, 1, 2, 255])), "{r}");
    assert_eq!(r["headers"]["content-type"], "application/octet-stream");
    assert_eq!(answer(&fetch(&mut ctx, &view, "empty", "/empty.txt")), (Some(200), Some("")));
    let r = fetch(&mut ctx, &view, "tab", "/tab.txt");
    assert_eq!(answer(&r), (Some(200), Some("tab-ok")), "{r}");
    assert_eq!(r["headers"]["content-type"], "text/plain;\tcharset=utf-8", "{r}");

    scenario("a MIME type with LF alone, NUL, \\x01 or \\x7f is refused and the table is left as it was");
    for mime in ["text/plain\n", "a\0b", "a\u{1}b", "a\u{7f}b"] {
        assert_eq!(extras.set_asset("a.txt", mime, b"bad".to_vec()), ErrorCode::InvalidArgument, "{mime:?}");
    }
    assert_eq!(answer(&fetch(&mut ctx, &view, "a-kept", "/a.txt")), (Some(200), Some("A2")), "a.txt still answers A2");

    scenario("the frames origin with no handler: an iframe from it loads");
    view.eval(
        "(() => { const f = document.createElement('iframe'); f.src = 'http://frames.webview.localhost/x'; \
         f.onload = () => post({ tag: 'frame', loaded: true }); document.body.appendChild(f); })()",
    );
    assert_eq!(ctx.wait(&view, "frame")["loaded"], true);

    // From here on a handler answers. What it saw, and the requests it holds for the test.
    let responder = extras.responder();
    let seen: Rc<RefCell<Vec<RawRequest>>> = Rc::default();
    let held: Rc<RefCell<Vec<(String, u64)>>> = Rc::default();
    let codes: Rc<RefCell<Vec<(&'static str, ErrorCode)>>> = Rc::default();
    let (sse_ids, sse_requests) = mpsc::channel::<u64>();
    {
        let (seen, held, codes, responder) = (seen.clone(), held.clone(), codes.clone(), responder.clone());
        let handler = Rc::new(move |request: RawRequest| {
            seen.borrow_mut().push(request.clone());
            let id = request.id;
            let code = |what: &'static str, code: ErrorCode| codes.borrow_mut().push((what, code));
            match path_of(&request.url) {
                "/echo" => held.borrow_mut().push(("echo".into(), id)),
                "/sse" => sse_ids.send(id).expect("the SSE writer waits"),
                "/sw.js" => {
                    let worker = "self.addEventListener('install', () => self.skipWaiting());\n\
                        self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));\n\
                        self.addEventListener('message', (e) => e.waitUntil(fetch('/from-sw?via=service-worker')\n\
                          .then(async (r) => ({ status: r.status, text: await r.text() }))\n\
                          .catch((err) => ({ error: String(err) }))\n\
                          .then((result) => e.source.postMessage(result))));";
                    responder.complete(id, 200, Some(r#"{"Content-Type":"text/javascript; charset=utf-8"}"#), Some(worker.as_bytes()));
                }
                "/from-sw" => {
                    responder.complete(id, 200, Some(r#"{"Content-Type":"text/plain"}"#), Some(b"sw-ok"));
                }
                "/stream" => {
                    let head = r#"[["Content-Type","text/plain"],["X-Multi","a"],["X-Multi","b"]]"#;
                    code("stream begin", responder.begin(id, 201, Some(head)));
                    for chunk in ["one,", "two,", "three"] {
                        code("stream write", responder.write_chunk(id, chunk.as_bytes()));
                    }
                    code("stream end", responder.end(id));
                }
                "/answered-then-begun" => {
                    code("complete", responder.complete(id, 200, None, Some(b"completed")));
                    code("begin after complete", responder.begin(id, 500, None));
                    code("chunk after complete", responder.write_chunk(id, b"dropped"));
                }
                "/end-unbegun" => {
                    code("end unbegun", responder.end(id));
                    code("complete after end", responder.complete(id, 200, None, Some(b"still answerable")));
                }
                "/bad-head" => {
                    code("bad head header", responder.begin(id, 200, Some(r#"{"X-A":"a\r\nb"}"#)));
                    code("bad head status", responder.begin(id, 99, None));
                    code("complete after refusal", responder.complete(id, 200, None, Some(b"open after refusal")));
                }
                _ => {
                    responder.complete(id, 404, None, None);
                }
            }
        });
        assert_eq!(extras.set_request_handler(Some(handler)), ErrorCode::Ok);
    }

    scenario("the query string reaches the handler; bad header JSON is refused and the request stays open");
    view.eval(&fetch_js("echo", "/echo?x=1", "{}"));
    assert!(ctx.pump(Some(&view), Duration::from_secs(10), || !held.borrow().is_empty()), "the handler held /echo");
    let echo = held.borrow()[0].1;
    let url = seen.borrow().iter().find(|r| r.id == echo).map(|r| r.url.clone()).unwrap_or_default();
    assert!(url.ends_with("/echo?x=1"), "the full URL with its query: {url}");
    // Trailing text after a literal, an escaped NUL, a name that is not a token, a lone
    // surrogate, a raw tab inside a string.
    for json in [r#"{"X-Example":trueish}"#, r#"{"X-Example":"a\u0000b"}"#, r#"{"Bad Name":"a"}"#, r#"{"X-A":"\ud83d"}"#, "{\"X-A\":\"a\tb\"}"] {
        assert_eq!(responder.complete(echo, 200, Some(json), None), ErrorCode::InvalidArgument, "{json}");
    }
    assert_eq!(responder.complete(echo, 201, Some(r#"{"X-Answer":"real"}"#), Some(b"echoed")), ErrorCode::Ok);
    let r = ctx.wait(&view, "echo");
    assert_eq!(answer(&r), (Some(201), Some("echoed")), "the real answer reached the page: {r}");
    assert_eq!(r["headers"]["x-answer"], "real");

    scenario("a streamed answer's head: status 201 and repeated headers, every chunk in order");
    let r = fetch(&mut ctx, &view, "stream", "/stream");
    assert_eq!(answer(&r), (Some(201), Some("one,two,three")), "{r}");
    assert_eq!(r["headers"]["x-multi"], "a, b", "{r}");

    scenario("begin after complete does nothing and its chunks are dropped");
    let r = fetch(&mut ctx, &view, "answered", "/answered-then-begun");
    assert_eq!(answer(&r), (Some(200), Some("completed")), "{r}");
    assert_eq!(r["headers"]["x-multi"], Value::Null);

    scenario("ending a response never begun does nothing; the request can still be completed");
    assert_eq!(answer(&fetch(&mut ctx, &view, "unbegun", "/end-unbegun")), (Some(200), Some("still answerable")));

    scenario("a bad head on begin is refused and the request stays open");
    assert_eq!(answer(&fetch(&mut ctx, &view, "bad-head", "/bad-head")), (Some(200), Some("open after refusal")));
    assert_eq!(
        *codes.borrow(),
        [
            ("stream begin", ErrorCode::Ok),
            ("stream write", ErrorCode::Ok),
            ("stream write", ErrorCode::Ok),
            ("stream write", ErrorCode::Ok),
            ("stream end", ErrorCode::Ok),
            ("complete", ErrorCode::Ok),
            ("begin after complete", ErrorCode::Ok),
            ("chunk after complete", ErrorCode::Ok),
            ("end unbegun", ErrorCode::Ok),
            ("complete after end", ErrorCode::Ok),
            ("bad head header", ErrorCode::InvalidArgument),
            ("bad head status", ErrorCode::InvalidArgument),
            ("complete after refusal", ErrorCode::Ok),
        ]
    );

    scenario("a service worker's own fetch reaches the handler, not the network");
    view.eval(
        r#"(async () => {
          try {
            const reply = new Promise((res) => navigator.serviceWorker.addEventListener("message", (e) => res(e.data)));
            navigator.serviceWorker.startMessages();
            await navigator.serviceWorker.register("/sw.js", { scope: "/" });
            const ready = await navigator.serviceWorker.ready;
            ready.active.postMessage("go");
            post({ tag: "sw", reply: await reply });
          } catch (e) { post({ tag: "sw", error: String(e) }); }
        })()"#,
    );
    let r = ctx.wait_for(&view, "sw", Duration::from_secs(30));
    assert_eq!(r["reply"], serde_json::json!({ "status": 200, "text": "sw-ok" }), "{r}");
    let paths: Vec<String> = seen.borrow().iter().map(|r| path_of(&r.url).to_owned()).collect();
    assert!(paths.iter().any(|p| p == "/sw.js") && paths.iter().any(|p| p == "/from-sw"), "{paths:?}");

    scenario("Server-Sent Events from another thread: an event split over two writes is one event, over one connection");
    let writer = {
        let responder: Responder = responder.clone();
        thread::spawn(move || {
            let id = sse_requests.recv_timeout(Duration::from_secs(20)).expect("the page asked for /sse");
            let bad = responder.begin(id, 200, Some(r#"{"Bad Name":"x"}"#));
            let began = responder.begin(id, 200, Some(r#"{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache"}"#));
            let event = |n: u32| format!("id: {n}\ndata: {{\"n\":{n}}}\n\n");
            let mut writes = vec![responder.write_chunk(id, event(1).as_bytes())];
            let two = event(2);
            let (first, second) = two.split_at(two.len() / 2);
            writes.push(responder.write_chunk(id, first.as_bytes()));
            thread::sleep(Duration::from_millis(100));
            writes.push(responder.write_chunk(id, second.as_bytes()));
            writes.push(responder.write_chunk(id, event(3).as_bytes()));
            writes.push(responder.end(id));
            (bad, began, writes)
        })
    };
    view.eval(
        r#"(() => {
          const events = [];
          const es = new EventSource("/sse");
          es.onmessage = (e) => {
            events.push({ n: JSON.parse(e.data).n, id: e.lastEventId });
            if (events.length === 3) { es.close(); post({ tag: "sse", events }); }
          };
        })()"#,
    );
    let r = ctx.wait_for(&view, "sse", Duration::from_secs(30));
    assert_eq!(r["events"], serde_json::json!([{ "n": 1, "id": "1" }, { "n": 2, "id": "2" }, { "n": 3, "id": "3" }]), "{r}");
    let (bad, began, writes) = writer.join().expect("the SSE writer");
    assert_eq!((bad, began), (ErrorCode::InvalidArgument, ErrorCode::Ok), "a bad header on begin is refused, then the real begin");
    assert!(writes.iter().all(|c| *c == ErrorCode::Ok), "{writes:?}");
    ctx.settle(Some(&view), Duration::from_millis(300));
    let connections = seen.borrow().iter().filter(|r| path_of(&r.url) == "/sse").count();
    assert_eq!(connections, 1, "one connection, no reconnect");
    drop(view);
    ctx.settle(None, Duration::from_millis(200));
}
