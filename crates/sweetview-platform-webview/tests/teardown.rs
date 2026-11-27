//! Teardown (`requests.md`): requests and streams left open when the extras
//! are dropped, a worker racing the drop, and a create/drop loop that returns
//! the process's GUI and handle counts to where they started.
#![cfg(windows)]

mod common;

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use common::{fetch_js, Ctx};
use sweetview_platform_webview::{ErrorCode, RawRequest};
use windows::Win32::System::Threading::{GetCurrentProcess, GetGuiResources, GetProcessHandleCount, GR_GDIOBJECTS, GR_USEROBJECTS};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Counts {
    user: u32,
    gdi: u32,
    handles: u32,
}

fn counts() -> Counts {
    // SAFETY: the pseudo-handle of the current process is always valid and needs no closing.
    let process = unsafe { GetCurrentProcess() };
    // SAFETY: `process` is the current process's pseudo-handle.
    let user = unsafe { GetGuiResources(process, GR_USEROBJECTS) };
    // SAFETY: `process` is the current process's pseudo-handle.
    let gdi = unsafe { GetGuiResources(process, GR_GDIOBJECTS) };
    let mut handles = 0u32;
    // SAFETY: `handles` is a local u32 for the call to fill.
    unsafe { GetProcessHandleCount(process, &mut handles) }.expect("GetProcessHandleCount");
    Counts { user, gdi, handles }
}

/// One webview's whole life: created, a page loaded, a request answered by
/// the handler and one streamed, then the extras, webview and window dropped.
fn one_life(ctx: &mut Ctx) {
    let view = ctx.view();
    ctx.load_index(&view);
    let responder = view.extras().responder();
    view.extras().set_request_handler(Some(Rc::new(move |req: RawRequest| {
        if req.url.ends_with("/stream") {
            responder.begin(req.id, 200, None);
            responder.write_chunk(req.id, b"streamed");
            responder.end(req.id);
        } else {
            responder.complete(req.id, 200, None, Some(b"answered"));
        }
    })));
    view.eval(&fetch_js("one", "/one", "{}"));
    assert_eq!(ctx.wait(&view, "one")["text"], "answered");
    view.eval(&fetch_js("two", "/stream", "{}"));
    assert_eq!(ctx.wait(&view, "two")["text"], "streamed");
    drop(view);
    ctx.settle(None, Duration::from_millis(300));
}

#[test]
fn teardown() {
    let mut ctx = Ctx::new();

    eprintln!("-- requests and a stream left open when the extras are dropped");
    let view = ctx.view();
    ctx.load_index(&view);
    let responder = view.extras().responder();
    let seen: Rc<RefCell<Vec<u64>>> = Rc::default();
    let (begun_tx, begun_rx) = mpsc::channel();
    {
        let seen = seen.clone();
        let responder = responder.clone();
        view.extras().set_request_handler(Some(Rc::new(move |req: RawRequest| {
            seen.borrow_mut().push(req.id);
            if req.url.ends_with("/open-stream") {
                // Begun and fed, never ended: WebView2's reader blocks in Read().
                assert_eq!(responder.begin(req.id, 200, None), ErrorCode::Ok);
                assert_eq!(responder.write_chunk(req.id, b"partial"), ErrorCode::Ok);
                begun_tx.send(req.id).unwrap();
            }
            // Anything else is left unanswered.
        })));
    }
    view.eval(&fetch_js("held", "/held", "{}"));
    view.eval(&fetch_js("frames-held", "http://frames.webview.localhost/held", "{ mode: 'no-cors' }"));
    view.eval(&fetch_js("open-stream", "/open-stream", "{}"));
    assert!(ctx.pump(Some(&view), Duration::from_secs(20), || seen.borrow().len() == 3), "all three reached the handler");
    let stream_id = begun_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    // Let the stream head reach WebView2, so a reader is waiting on it.
    ctx.settle(Some(&view), Duration::from_millis(500));
    let held = seen.borrow()[0];

    // A worker answering in a loop races the drop: every call returns Ok or
    // InvalidState, never anything else, and never crashes.
    let stop = Arc::new(AtomicBool::new(false));
    let racer = {
        let responder = responder.clone();
        let stop = stop.clone();
        thread::spawn(move || {
            let mut seen_invalid = false;
            while !stop.load(Ordering::SeqCst) {
                for code in [
                    responder.write_chunk(stream_id, b"more"),
                    responder.complete(u64::MAX - 1, 200, None, Some(b"no such request")),
                ] {
                    assert!(matches!(code, ErrorCode::Ok | ErrorCode::InvalidState), "{code:?}");
                    seen_invalid |= code == ErrorCode::InvalidState;
                }
            }
            seen_invalid
        })
    };
    thread::sleep(Duration::from_millis(50));
    let mut view = view;
    let started = Instant::now();
    drop(view.extras.take());
    eprintln!("   extras dropped in {:?} with two requests and a stream open", started.elapsed());
    assert!(started.elapsed() < Duration::from_secs(5), "the drop never waits on WebView2's blocked reader");
    thread::sleep(Duration::from_millis(50));
    stop.store(true, Ordering::SeqCst);
    assert!(racer.join().expect("the racing worker never panicked"), "the worker saw the drop");

    assert_eq!(responder.complete(held, 200, None, None), ErrorCode::InvalidState);
    assert_eq!(responder.begin(held, 200, None), ErrorCode::InvalidState);
    assert_eq!(responder.write_chunk(stream_id, b"late"), ErrorCode::InvalidState);
    assert_eq!(responder.end(stream_id), ErrorCode::InvalidState);
    drop(view);
    ctx.settle(None, Duration::from_millis(500));

    eprintln!("-- create/drop loop: GUI and handle counts return to their start");
    one_life(&mut ctx); // warm-up: loads WebView2's DLLs and starts its threads
    one_life(&mut ctx);
    ctx.settle(None, Duration::from_secs(1));
    let start = counts();
    for _ in 0..5 {
        one_life(&mut ctx);
    }
    // WebView2 lets go of some handles a little after the controller closes.
    let mut end = counts();
    let deadline = Instant::now() + Duration::from_secs(10);
    while end != start && Instant::now() < deadline {
        ctx.settle(None, Duration::from_millis(250));
        end = counts();
    }
    eprintln!("   start {start:?}, after five lives {end:?}");
    assert_eq!(end.user, start.user, "USER objects");
    assert_eq!(end.gdi, start.gdi, "GDI objects");
    assert!(end.handles <= start.handles, "kernel handles: {start:?} -> {end:?}");
}
