//! A real `tao` window and a real webview of this crate in it with the
//! extras attached, pumped with `run_return`; the page reports back through
//! `window.chrome.webview.postMessage`, received by the extras' page message
//! handler.
#![allow(dead_code)]

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use sweetview_platform_webview::{ExtrasOptions, Layout, Webview, WebviewExtras};
use sweetview_platform_window::BorrowedWindow;
use tao::dpi::LogicalSize;
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder};
use tao::platform::run_return::EventLoopExtRunReturn;
use tao::platform::windows::EventLoopBuilderExtWindows;
use tao::window::{Window, WindowBuilder};

/// The page every test loads first. `post` reports to the test.
pub const INDEX_HTML: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><title>extras test</title></head>
<body style="background: transparent">
<script>
  window.post = (o) => window.chrome.webview.postMessage(JSON.stringify(o));
  post({
    tag: 'ready',
    path: location.pathname,
    origin: location.origin,
    us1: typeof window.__us1,
    us2: typeof window.__us2,
    drop: window.__webview_file_drop_enabled__,
    scripts: Object.keys(window).filter((k) => k.startsWith('__script_')).sort(),
  });
</script>
</body></html>"#;

pub const INDEX_URL: &str = "http://webview.localhost/index.html";

thread_local! {
    /// True while the harness runs `WebviewExtras::drain`.
    pub static IN_DRAIN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub struct Ctx {
    pub el: EventLoop<()>,
}

/// One window, its webview and the extras, dropped in that field order:
/// extras, then webview, then window.
pub struct View {
    pub extras: Option<WebviewExtras>,
    pub webview: Option<Webview>,
    pub window: Option<Window>,
    pub messages: Rc<RefCell<Vec<String>>>,
    pub wakes: Arc<AtomicUsize>,
}

impl View {
    pub fn extras(&self) -> &WebviewExtras {
        self.extras.as_ref().expect("extras")
    }

    pub fn webview(&self) -> &Webview {
        self.webview.as_ref().expect("webview")
    }

    pub fn eval(&self, js: &str) {
        assert_eq!(self.webview().evaluate(js).code(), 0, "evaluate");
    }

    /// Navigates the webview to `url`.
    pub fn navigate(&self, url: &str) {
        assert_eq!(self.webview().navigate(url).code(), 0, "navigate");
    }

    /// Takes the first message with `tag`, if one arrived.
    pub fn take(&self, tag: &str) -> Option<Value> {
        let mut messages = self.messages.borrow_mut();
        let index = messages.iter().position(|m| {
            serde_json::from_str::<Value>(m).ok().and_then(|v| v.get("tag").cloned()) == Some(Value::from(tag))
        })?;
        serde_json::from_str(&messages.remove(index)).ok()
    }

    /// Every raw message received so far, drained.
    pub fn drain_raw(&self) -> Vec<String> {
        std::mem::take(&mut *self.messages.borrow_mut())
    }
}

impl Drop for Ctx {
    /// Every view is gone by now (declared after the context, dropped before it): the
    /// thread's shared WebView2 environment goes while the thread still runs, on a failed
    /// assertion too. Released by the thread's own teardown, WebView2 faults (0xc000041d).
    fn drop(&mut self) {
        sweetview_platform_webview::test_support::release_environment();
    }
}

impl Ctx {
    pub fn new() -> Self {
        Self { el: EventLoopBuilder::new().with_any_thread(true).build() }
    }

    /// A visible 480x360 window with a webview whose page messages are kept,
    /// the extras attached, and `index.html` set as an asset (not yet loaded).
    pub fn view(&self) -> View {
        self.view_debug(false)
    }

    /// [`view`](Self::view), with the developer tools as `devtools`.
    pub fn view_debug(&self, devtools: bool) -> View {
        let window = WindowBuilder::new()
            .with_title("sweetview-platform-webview test")
            .with_inner_size(LogicalSize::new(480.0, 360.0))
            .build(&self.el)
            .expect("window");
        let webview = Webview::create(&BorrowedWindow::of(&window), Layout::Fill, devtools).expect("webview");
        let messages = Rc::new(RefCell::new(Vec::new()));
        let wakes = Arc::new(AtomicUsize::new(0));
        let counter = wakes.clone();
        let extras = WebviewExtras::attach(
            &webview,
            ExtrasOptions { wake_ui: Arc::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            }) },
        )
        .expect("attach");
        let sink = messages.clone();
        extras.set_page_message_handler(Some(Rc::new(move |message: &str| sink.borrow_mut().push(message.to_owned()))));
        assert_eq!(extras.set_asset("index.html", "text/html; charset=utf-8", INDEX_HTML.as_bytes().to_vec()).code(), 0);
        View { extras: Some(extras), webview: Some(webview), window: Some(window), messages, wakes }
    }

    /// Pumps the loop (and the extras' queue) until `done` or `timeout`.
    ///
    /// A ticker thread sends a `tao` user event every few milliseconds while it
    /// runs: `tao` otherwise calls its handler again only once the thread's queue
    /// is empty of posted messages (its cycle ends on an internal paint), which a
    /// loading WebView2 can hold off for a long time.
    pub fn pump(&mut self, view: Option<&View>, timeout: Duration, mut done: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        let stop = Arc::new(AtomicBool::new(false));
        let ticker = {
            let stop = stop.clone();
            let proxy = self.el.create_proxy();
            thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    let _ = proxy.send_event(());
                    thread::sleep(Duration::from_millis(5));
                }
            })
        };
        let mut reached = false;
        self.el.run_return(|_event, _target, control_flow| {
            if let Some(extras) = view.and_then(|v| v.extras.as_ref()) {
                IN_DRAIN.with(|d| d.set(true));
                extras.drain();
                IN_DRAIN.with(|d| d.set(false));
            }
            // `tao` still calls the handler after Exit (LoopDestroyed): stay exited.
            if reached || done() {
                reached = true;
                *control_flow = ControlFlow::Exit;
            } else if Instant::now() >= deadline {
                *control_flow = ControlFlow::Exit;
            } else {
                *control_flow = ControlFlow::Wait;
            }
        });
        stop.store(true, Ordering::SeqCst);
        ticker.join().expect("ticker");
        reached
    }

    /// Pumps for `duration` regardless.
    pub fn settle(&mut self, view: Option<&View>, duration: Duration) {
        self.pump(view, duration, || false);
    }

    /// Pumps until a message with `tag` arrives, and returns it.
    pub fn wait(&mut self, view: &View, tag: &str) -> Value {
        self.wait_for(view, tag, Duration::from_secs(20))
    }

    /// [`wait`](Self::wait) with a timeout of `timeout`.
    pub fn wait_for(&mut self, view: &View, tag: &str, timeout: Duration) -> Value {
        let mut found = None;
        self.pump(Some(view), timeout, || {
            found = view.take(tag);
            found.is_some()
        });
        found.unwrap_or_else(|| panic!("no message tagged {tag:?}; received: {:?}", view.messages.borrow()))
    }

    /// Loads `index.html` and waits for its `ready` message.
    pub fn load_index(&mut self, view: &View) -> Value {
        view.navigate(INDEX_URL);
        self.wait(view, "ready")
    }
}

/// A page script that fetches `url` with `init` and posts `{tag, status,
/// headers, bytes, text}` or `{tag, error}`.
pub fn fetch_js(tag: &str, url: &str, init: &str) -> String {
    format!(
        r#"(async () => {{
  try {{
    const r = await fetch({url:?}, {init});
    const buf = new Uint8Array(await r.arrayBuffer());
    const headers = {{}};
    r.headers.forEach((v, k) => {{ headers[k] = v; }});
    post({{ tag: {tag:?}, status: r.status, statusText: r.statusText, headers, bytes: Array.from(buf), text: new TextDecoder().decode(buf) }});
  }} catch (e) {{
    post({{ tag: {tag:?}, error: String(e) }});
  }}
}})()"#
    )
}
