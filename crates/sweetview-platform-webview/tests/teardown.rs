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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Counts {
    user: u32,
    gdi: u32,
    handles: u32,
}

fn counts() -> Counts {
    let counts = sweetview_platform_loop::resource_counts();
    Counts { user: counts.user_objects, gdi: counts.gdi_objects, handles: counts.kernel_handles }
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
    let seen: Rc<RefCell<Vec<(u64, String)>>> = Rc::default();
    let (begun_tx, begun_rx) = mpsc::channel();
    {
        let seen = seen.clone();
        let responder = responder.clone();
        view.extras().set_request_handler(Some(Rc::new(move |req: RawRequest| {
            seen.borrow_mut().push((req.id, req.url.clone()));
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
    // The page may also ask for /favicon.ico, which is left open as well.
    let wanted = ["http://webview.localhost/held", "http://frames.webview.localhost/held", "http://webview.localhost/open-stream"];
    let all = ctx.pump(Some(&view), Duration::from_secs(20), || {
        wanted.iter().all(|url| seen.borrow().iter().any(|(_, u)| u == url))
    });
    assert!(all, "all three reached the handler: {:?}", seen.borrow());
    let stream_id = begun_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    // Let the stream head reach WebView2, so a reader is waiting on it.
    ctx.settle(Some(&view), Duration::from_millis(500));
    let held = seen.borrow().iter().find(|(_, u)| u.ends_with("/held")).map(|(id, _)| *id).unwrap();

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
    eprintln!("   extras dropped in {:?} with requests and a stream open", started.elapsed());
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
    // WebView2 (or `wry`) keeps about one kernel handle per webview ever made in
    // the process, with or without the extras; the same loop with no extras is
    // the baseline, so the extras must add nothing to it.
    for _ in 0..2 {
        one_life(&mut ctx); // warm-up: loads WebView2's DLLs and starts its threads
        bare_life(&mut ctx);
    }
    let lives = 5;
    let bare = growth(&mut ctx, lives, bare_life);
    // Measured twice, and the smaller growth of each kind counts: what the extras leak they leak
    // in every life, so it shows in both runs; an object WebView2 or the shell makes once in the
    // process, when it pleases, shows in one.
    let first = growth(&mut ctx, lives, one_life);
    let second = growth(&mut ctx, lives, one_life);
    eprintln!("   over {lives} lives: without the extras {bare:?}, with them {first:?} and then {second:?}");
    let with_extras =
        Growth { user: first.user.min(second.user), gdi: first.gdi.min(second.gdi), handles: first.handles.min(second.handles) };
    // USER and GDI objects return to their starting value (the smaller of the two runs, for the
    // object WebView2 or the shell makes once in the process, D20). Where the same lives without
    // the extras grew too, that growth is WebView2's own and is the allowance: the extras add
    // nothing to it. With no such growth, which is the usual case, the count must be the start's.
    assert!(
        with_extras.user <= bare.user.max(0),
        "USER objects return to their start: {with_extras:?} ({bare:?} without the extras)"
    );
    assert!(
        with_extras.gdi <= bare.gdi.max(0),
        "GDI objects return to their start: {with_extras:?} ({bare:?} without the extras)"
    );
    // Kernel handles are compared with the same loop without the extras: WebView2 keeps about
    // one per webview ever made in the process, extras or not (measured here: 6 over 5 lives
    // without the extras, 4 or 5 with them, in each of three runs).
    assert!(
        with_extras.handles <= bare.handles,
        "the extras add no kernel handle to what a webview without them keeps: {with_extras:?} vs {bare:?}"
    );
}

#[derive(Debug)]
struct Growth {
    user: i64,
    gdi: i64,
    handles: i64,
}

/// What `lives` runs of `life` leave behind, after letting WebView2 settle.
fn growth(ctx: &mut Ctx, lives: usize, life: fn(&mut Ctx)) -> Growth {
    ctx.settle(None, Duration::from_secs(1));
    let start = counts();
    for _ in 0..lives {
        life(ctx);
    }
    // WebView2 lets go of some handles and windows a little after the controller closes: each
    // count is read once it is back at its start, or when the wait is over.
    let mut end = counts();
    let deadline = Instant::now() + Duration::from_secs(5);
    while (end.handles > start.handles || end.user > start.user || end.gdi > start.gdi) && Instant::now() < deadline {
        ctx.settle(None, Duration::from_millis(250));
        end = counts();
    }
    Growth {
        user: i64::from(end.user) - i64::from(start.user),
        gdi: i64::from(end.gdi) - i64::from(start.gdi),
        handles: i64::from(end.handles) - i64::from(start.handles),
    }
}

/// The same life as `one_life` with no extras: a window and a webview of this
/// crate showing a page that sets its title, then dropped.
fn bare_life(ctx: &mut Ctx) {
    let window = tao::window::WindowBuilder::new().build(&ctx.el).expect("window");
    let webview = sweetview_platform_webview::Webview::create(
        &sweetview_platform_window::BorrowedWindow::of(&window),
        sweetview_platform_webview::Layout::Fill,
        false,
    )
    .expect("webview");
    assert_eq!(webview.navigate_to_string("<script>document.title = 'ready'</script>").code(), 0);
    assert!(ctx.pump(None, Duration::from_secs(20), || sweetview_platform_webview::test_support::document_title(&webview) == "ready"));
    drop(webview);
    drop(window);
    ctx.settle(None, Duration::from_millis(300));
}
