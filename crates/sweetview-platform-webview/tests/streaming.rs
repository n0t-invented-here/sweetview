//! What a streamed response does on a real WebView2 (DECISIONS D45): the page
//! reads the body with a `ReadableStream` reader while the response is open,
//! written from the UI thread and from another thread, small chunks (text) and
//! a large fast body (24 MiB of bytes). Every byte arrives, in order, and no
//! write waits for the page, on any thread.
//!
//! And what the page gets before the end, measured on the runtime the test
//! runs on (it prints the version): for these responses, nothing, not even the
//! resolved `fetch()`. Each "before the end" is decided by the thread that ends
//! the response, which waits for the page's report (up to 3 s) before it
//! calls `end`. Asserted as measured, so a WebView2 Runtime that hands the
//! page bytes before the end fails here: then D45, `docs/webview-library.md`
//! and these assertions are updated.
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

const MIB: usize = 1 << 20;

/// The fast writer's body, in chunks of this size.
const BULK_BYTES: usize = 24 * MIB + 4321;
const BULK_CHUNK: usize = 64 * 1024 + 7;

/// Byte `i` of the fast writer's body, which the page checks.
fn pattern(i: usize) -> u8 {
    ((i % 251) ^ ((i / 65_536) % 256)) as u8
}

/// The page reads `url` slowly (a pause every 256 KiB), checks every byte
/// against [`pattern`] and posts `bulk-done` with the total and the first
/// wrong position, if any.
fn bulk_reader_js(url: &str) -> String {
    format!(
        r#"(async () => {{
  try {{
    const r = await fetch({url:?});
    const reader = r.body.getReader();
    let total = 0, bad = null, nextPause = 262144;
    for (;;) {{
      const {{ done, value }} = await reader.read();
      if (done) break;
      for (let k = 0; k < value.length && bad === null; k++) {{
        const i = total + k;
        if (value[k] !== (((i % 251) ^ (Math.floor(i / 65536) % 256)) & 255)) bad = i;
      }}
      if (total === 0) post({{ tag: 'bulk-first' }});
      total += value.length;
      if (total >= nextPause) {{
        nextPause += 262144;
        await new Promise((res) => setTimeout(res, 15));
      }}
    }}
    post({{ tag: 'bulk-done', total, bad }});
  }} catch (e) {{
    post({{ tag: 'bulk-done', error: String(e) }});
  }}
}})()"#
    )
}

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
fn a_streamed_body_arrives_whole_and_in_order_and_webview2_gives_it_to_the_page_at_its_end() {
    eprintln!("-- WebView2 Runtime {}", wry::webview_version().unwrap_or_default());
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
    let head_before_end = view.take("ui-head").is_some();
    eprintln!("   chunk 1 reached the page while open: {first:?}; fetch() had resolved: {head_before_end}");
    assert_eq!(responder.write_chunk(id, b"chunk two;"), ErrorCode::Ok);
    let second = wait_for_text(&mut ctx, &view, "ui", "chunk two;");
    eprintln!("   chunk 2 reached the page while open: {second:?}");
    assert_eq!(responder.end(id), ErrorCode::Ok);
    let done = ctx.wait(&view, "ui-done");
    eprintln!("   after the end: {done}");
    assert_eq!(done["text"], "chunk one;chunk two;", "every byte, in order: {done}");

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

    eprintln!("-- a fast writer on another thread, a slow reader: no write waits, nothing lost or reordered");
    let held = hold_request(&view, "/bulk");
    view.eval(&bulk_reader_js("/bulk"));
    assert!(ctx.pump(Some(&view), Duration::from_secs(10), || held.get().is_some()), "the request reached the handler");
    let id = held.get().unwrap();
    // The writer decides whether the page had a byte before the end, because it is the one
    // that ends the response: once every byte is written it waits up to BOUND for the page's
    // first byte, and only then calls `end`.
    let (first_tx, first_rx) = mpsc::channel::<()>();
    let writer = {
        let responder = responder.clone();
        thread::spawn(move || {
            assert_eq!(responder.begin(id, 200, Some(r#"{"Content-Type":"application/octet-stream"}"#)), ErrorCode::Ok);
            let (mut sent, mut held_back) = (0usize, 0u32);
            while sent < BULK_BYTES {
                let n = (BULK_BYTES - sent).min(BULK_CHUNK);
                let chunk: Vec<u8> = (sent..sent + n).map(pattern).collect();
                let start = Instant::now();
                assert_eq!(responder.write_chunk(id, &chunk), ErrorCode::Ok);
                if start.elapsed() > Duration::from_millis(5) {
                    held_back += 1;
                }
                sent += n;
            }
            let first_before_end = first_rx.recv_timeout(BOUND).is_ok();
            assert_eq!(responder.end(id), ErrorCode::Ok);
            (sent, held_back, first_before_end)
        })
    };
    let mut done = None;
    let mut told = false;
    ctx.pump(Some(&view), Duration::from_secs(120), || {
        if !told && view.take("bulk-first").is_some() {
            told = true;
            let _ = first_tx.send(());
        }
        done = done.take().or_else(|| view.take("bulk-done"));
        done.is_some()
    });
    let done = done.expect("the page read the fast writer's body to the end");
    let (sent, held_back, first_before_end) = writer.join().expect("the writer thread");
    let bulk_first_before_end = Some(first_before_end);
    eprintln!("   wrote {sent} bytes; writes that took over 5 ms {held_back}; the page: {done}");
    assert_eq!(done["error"], Value::Null, "{done}");
    assert_eq!(done["total"].as_u64(), Some(sent as u64), "every byte reached the page: {done}");
    assert_eq!(done["bad"], Value::Null, "no byte lost or out of order: {done}");

    eprintln!("-- the UI thread is never held back: it writes 4 MiB while the page does not read");
    let held = hold_request(&view, "/stalled");
    view.eval(
        r#"(async () => {
  const r = await fetch('/stalled');
  window.__stalled = r.body.getReader();
  post({ tag: 'stalled-head', status: r.status });
})()"#,
    );
    assert!(ctx.pump(Some(&view), Duration::from_secs(10), || held.get().is_some()), "the request reached the handler");
    let id = held.get().unwrap();
    assert_eq!(responder.begin(id, 200, None), ErrorCode::Ok);
    let start = Instant::now();
    let chunk = vec![0u8; BULK_CHUNK];
    let mut written = 0;
    while written < 4 * MIB {
        assert_eq!(responder.write_chunk(id, &chunk), ErrorCode::Ok);
        written += chunk.len();
    }
    eprintln!("   wrote {written} bytes in {:?}", start.elapsed());
    assert!(start.elapsed() < Duration::from_secs(5), "the UI thread's writes do not wait for the page");
    // Released at teardown, below.

    drop(view);
    ctx.settle(None, Duration::from_millis(200));

    // Whether the page saw anything before the end, asserted once every scenario has run and printed.
    eprintln!("-- the page saw bytes before the end: UI thread {first:?} {second:?} (fetch resolved {head_before_end}); another thread {acked:?}; the fast writer's body {bulk_first_before_end:?}");
    let flipped = "WebView2 handed the page a response before its end: streaming works now; update D45, docs/webview-library.md and these assertions";
    assert_eq!((first, second, head_before_end), (None, None, false), "{flipped}");
    assert_eq!(acked, vec![false, false, false], "{flipped}");
    assert_eq!(bulk_first_before_end, Some(false), "{flipped}");
}
