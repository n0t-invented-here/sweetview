//! Whether a streamed response streams: on a real WebView2, the page reads a
//! response's body with a `ReadableStream` reader while the response is still
//! open, and each chunk must reach it before the next is written and before
//! the end. Written from the UI thread and from another thread.
#![cfg(windows)]

mod common;

use std::cell::Cell;
use std::rc::Rc;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use common::{Ctx, View};
use serde_json::Value;
use sweetview_platform_webview::{ErrorCode, RawRequest};

/// How long a written chunk may take to reach the page's reader.
const BOUND: Duration = Duration::from_secs(3);

/// The page reads `url` chunk by chunk and posts each read (`<tag>-head`,
/// `<tag>-chunk` with the text and the time, `<tag>-done` with the whole text).
fn reader_js(tag: &str, url: &str) -> String {
    format!(
        r#"(async () => {{
  try {{
    const r = await fetch({url:?});
    post({{ tag: {head:?}, status: r.status }});
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (let n = 1; ; n++) {{
      const {{ done, value }} = await reader.read();
      if (done) break;
      const piece = decoder.decode(value, {{ stream: true }});
      text += piece;
      post({{ tag: {chunk:?}, n, piece, text }});
    }}
    post({{ tag: {done:?}, text }});
  }} catch (e) {{
    post({{ tag: {done:?}, error: String(e) }});
  }}
}})()"#,
        head = format!("{tag}-head"),
        chunk = format!("{tag}-chunk"),
        done = format!("{tag}-done"),
    )
}

/// Pumps until the page has posted a `<tag>-chunk` whose text so far ends with
/// `expected`, or `BOUND` passes. Returns how long it took, or `None`.
fn wait_for_text(ctx: &mut Ctx, view: &View, tag: &str, expected: &str) -> Option<Duration> {
    let start = Instant::now();
    let chunk_tag = format!("{tag}-chunk");
    let mut seen = false;
    ctx.pump(Some(view), BOUND, || {
        while let Some(m) = view.take(&chunk_tag) {
            if m["text"].as_str().is_some_and(|t| t.ends_with(expected)) {
                seen = true;
            }
        }
        seen
    });
    seen.then(|| start.elapsed())
}

/// Sets a handler that keeps the id of the request for `path` and answers
/// nothing; returns where the id lands.
fn hold_request(view: &View, path: &'static str) -> Rc<Cell<Option<u64>>> {
    let held: Rc<Cell<Option<u64>>> = Rc::default();
    let slot = held.clone();
    view.extras().set_request_handler(Some(Rc::new(move |req: RawRequest| {
        if req.url.ends_with(path) {
            slot.set(Some(req.id));
        }
    })));
    held
}

#[test]
fn a_chunk_reaches_the_page_while_the_response_is_open() {
    let mut ctx = Ctx::new();
    let view = ctx.view();
    ctx.load_index(&view);
    let responder = view.extras().responder();

    eprintln!("-- written from the UI thread");
    let held = hold_request(&view, "/live-ui");
    view.eval(&reader_js("ui", "/live-ui"));
    assert!(ctx.pump(Some(&view), Duration::from_secs(10), || held.get().is_some()), "the request reached the handler");
    let id = held.get().unwrap();
    assert_eq!(responder.begin(id, 200, Some(r#"{"Content-Type":"text/plain; charset=utf-8"}"#)), ErrorCode::Ok);
    assert_eq!(responder.write_chunk(id, b"chunk one;"), ErrorCode::Ok);
    let first = wait_for_text(&mut ctx, &view, "ui", "chunk one;");
    eprintln!("   chunk 1 reached the page while open: {first:?}");
    assert_eq!(responder.write_chunk(id, b"chunk two;"), ErrorCode::Ok);
    let second = wait_for_text(&mut ctx, &view, "ui", "chunk two;");
    eprintln!("   chunk 2 reached the page while open: {second:?}");
    assert_eq!(responder.end(id), ErrorCode::Ok);
    let done = ctx.wait(&view, "ui-done");
    eprintln!("   after the end: {done}");
    assert_eq!(done["text"], "chunk one;chunk two;", "every byte, in order: {done}");
    assert!(first.is_some(), "chunk 1 reached the page's reader within {BOUND:?} while the response was open");
    assert!(second.is_some(), "chunk 2 reached the page's reader within {BOUND:?} while the response was open");

    eprintln!("-- written from another thread, each chunk after the page has the one before");
    let held = hold_request(&view, "/live-thread");
    view.eval(&reader_js("th", "/live-thread"));
    assert!(ctx.pump(Some(&view), Duration::from_secs(10), || held.get().is_some()), "the request reached the handler");
    let id = held.get().unwrap();
    let (ack_tx, ack_rx) = mpsc::channel::<usize>();
    let (report_tx, report_rx) = mpsc::channel::<Vec<bool>>();
    let writer = {
        let responder = responder.clone();
        thread::spawn(move || {
            let mut acked = Vec::new();
            assert_eq!(responder.begin(id, 200, Some(r#"{"Content-Type":"text/plain; charset=utf-8"}"#)), ErrorCode::Ok);
            for (n, chunk) in ["first;", "second;", "third;"].into_iter().enumerate() {
                assert_eq!(responder.write_chunk(id, chunk.as_bytes()), ErrorCode::Ok);
                // The next chunk only once the page has this one (or the bound passed).
                acked.push(ack_rx.recv_timeout(BOUND + Duration::from_secs(1)).is_ok_and(|seen| seen == n + 1));
            }
            assert_eq!(responder.end(id), ErrorCode::Ok);
            report_tx.send(acked).unwrap();
        })
    };
    let mut done: Option<Value> = None;
    let mut text = String::new();
    let mut acks = 0;
    let expected = ["first;", "second;", "third;"];
    ctx.pump(Some(&view), Duration::from_secs(20), || {
        while let Some(m) = view.take("th-chunk") {
            text = m["text"].as_str().unwrap_or_default().to_string();
            while acks < expected.len() && text.ends_with(expected[..=acks].concat().as_str()) {
                acks += 1;
                let _ = ack_tx.send(acks);
            }
        }
        if let Some(m) = view.take("th-done") {
            done = Some(m);
        }
        done.is_some()
    });
    writer.join().expect("the writer thread");
    let acked = report_rx.recv_timeout(Duration::from_secs(1)).expect("the writer's report");
    eprintln!("   each chunk reached the page before the next was written: {acked:?}; at the end: {done:?}");
    let done = done.expect("the page read to the end");
    assert_eq!(done["text"], "first;second;third;", "every byte, in order: {done}");
    assert_eq!(acked, vec![true, true, true], "each chunk reached the page within {BOUND:?}, before the next and before the end");

    drop(view);
    ctx.settle(None, Duration::from_millis(200));
}
