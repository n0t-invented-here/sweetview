// Throwaway proof, outside every repository. Two questions:
//  1. Can native code call a JavaScript function on the JS thread while that
//     thread is inside a blocking tao event loop (the bun:ffi JSCallback case)?
//  2. Does a tao loop pumped once per JS timer tick deliver tray-icon events
//     when the process has no window?
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder};
use tao::platform::run_return::EventLoopExtRunReturn;
use tao::window::WindowBuilder;
use tray_icon::{TrayIcon, TrayIconBuilder, TrayIconEvent};
use wry::WebViewBuilder;

#[derive(Debug, Clone)]
enum UserEvt {
  Ipc,
  Tray(String),
}

const PAGE: &str = "<!doctype html><meta charset=utf-8><title>spike</title><script>window.ipc.postMessage('ping from ' + location.origin)</script>";

/// Question 1. Blocks in the tao loop; the page posts a message; the JS
/// function is called from inside the loop; its return value comes back.
#[napi]
pub fn run_blocking(cb: Function<String, String>) -> Result<String> {
  let mut event_loop: EventLoop<UserEvt> = EventLoopBuilder::<UserEvt>::with_user_event().build();
  let proxy = event_loop.create_proxy();
  let window = WindowBuilder::new()
    .with_visible(false)
    .with_title("spike")
    .build(&event_loop)
    .map_err(|e| Error::from_reason(format!("window: {e}")))?;

  let inbox: Rc<RefCell<VecDeque<String>>> = Rc::new(RefCell::new(VecDeque::new()));
  let inbox_for_ipc = inbox.clone();
  let _webview = WebViewBuilder::new()
    .with_custom_protocol("webview".into(), |_id, _req| {
      wry::http::Response::builder()
        .header("Content-Type", "text/html; charset=utf-8")
        .body(Cow::Borrowed(PAGE.as_bytes()))
        .unwrap()
    })
    .with_url("webview://localhost/index.html")
    .with_ipc_handler(move |req| {
      inbox_for_ipc.borrow_mut().push_back(req.body().clone());
      let _ = proxy.send_event(UserEvt::Ipc);
    })
    .build(&window)
    .map_err(|e| Error::from_reason(format!("webview: {e}")))?;

  let deadline = Instant::now() + Duration::from_secs(20);
  let mut outcome: Result<String> = Err(Error::from_reason("timed out: the page never called back"));
  event_loop.run_return(|event, _target, control_flow| {
    *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(100));
    match event {
      Event::UserEvent(UserEvt::Ipc) => {
        if let Some(message) = inbox.borrow_mut().pop_front() {
          // The call under test: JavaScript, from inside the native loop.
          outcome = cb.call(message);
          *control_flow = ControlFlow::Exit;
        }
      }
      Event::NewEvents(StartCause::ResumeTimeReached { .. }) | Event::MainEventsCleared => {
        if Instant::now() > deadline {
          *control_flow = ControlFlow::Exit;
        }
      }
      _ => {}
    }
  });
  outcome
}

struct TrayState {
  event_loop: EventLoop<UserEvt>,
  _tray: TrayIcon,
}

thread_local! {
  static TRAY: RefCell<Option<TrayState>> = const { RefCell::new(None) };
}

/// Question 2, part one: a loop and a tray icon, and no window at all.
#[napi]
pub fn init_tray() -> Result<()> {
  let event_loop: EventLoop<UserEvt> = EventLoopBuilder::<UserEvt>::with_user_event().build();
  let proxy = event_loop.create_proxy();
  TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
    let _ = proxy.send_event(UserEvt::Tray(format!("{event:?}")));
  }));
  let icon = tray_icon::Icon::from_rgba(vec![200u8; 16 * 16 * 4], 16, 16)
    .map_err(|e| Error::from_reason(format!("icon: {e}")))?;
  let tray = TrayIconBuilder::new()
    .with_tooltip("sweetview spike")
    .with_icon(icon)
    .build()
    .map_err(|e| Error::from_reason(format!("tray: {e}")))?;
  TRAY.with(|slot| *slot.borrow_mut() = Some(TrayState { event_loop, _tray: tray }));
  Ok(())
}

/// Question 2, part two: one pump. Dispatches what is waiting, calls the JS
/// function for each tray event, returns. Returns how many it delivered.
#[napi]
pub fn pump(cb: Function<String, ()>) -> Result<u32> {
  TRAY.with(|slot| {
    let mut slot = slot.borrow_mut();
    let state = slot.as_mut().ok_or_else(|| Error::from_reason("init_tray first"))?;
    let mut delivered = 0u32;
    let mut failure: Option<Error> = None;
    state.event_loop.run_return(|event, _target, control_flow| {
      *control_flow = ControlFlow::Poll;
      match event {
        Event::UserEvent(UserEvt::Tray(text)) => {
          delivered += 1;
          if let Err(e) = cb.call(text) {
            failure = Some(e);
          }
        }
        Event::MainEventsCleared => *control_flow = ControlFlow::Exit,
        _ => {}
      }
    });
    match failure {
      Some(e) => Err(e),
      None => Ok(delivered),
    }
  })
}

#[napi]
pub fn drop_tray() {
  TRAY.with(|slot| *slot.borrow_mut() = None);
}
