//! The webview engine: one `wry` webview and everything Sweetview adds to it.
//!
//! `wry` creates the webview, runs scripts and carries the page's messages.
//! Assets, the request handler, streamed responses, drops and the tab hooks
//! come from `sweetview-platform-webview`. This module is the glue: it owns
//! both, keeps the bindings (`bind`, `unbind`, `return`), and decides when a
//! webview is really dropped.
//!
//! Two rules shape it:
//!
//! * A page message is never answered inside WebView2's own callback. The
//!   binding's function runs on a later turn of the loop, as a deferred job,
//!   so it may open a modal dialog or destroy the webview.
//! * A webview is never dropped inside one of its own callbacks. `destroy`
//!   marks it destroyed at once (no handler runs again, answers are refused),
//!   and the drop waits for the callback to return.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::rc::{Rc, Weak};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use sweetview_platform_webview::{ErrorCode, ExtrasOptions, Responder, UserScript, WebviewExtras};
pub use sweetview_platform_webview::{KeyData, NavigationFailure, RawRequest};
use sweetview_platform_window::BorrowedWindow;
use tao::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use tao::event::{Event, WindowEvent};
use tao::window::{Window as TaoWindow, WindowBuilder};
use wry::{NewWindowResponse, WebView, WebViewBuilder};

use crate::bridge::{self, BridgeCall};
use crate::error::{Error, Result};
use crate::runtime::{self, Runtime};

/// Names a live webview. This is the number applications see as `unsafeHandle`
/// and pass to the functions a `Worker` calls.
pub type EngineId = u32;

/// A rectangle in physical pixels, in the client coordinates of the host window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bounds {
  pub x: i32,
  pub y: i32,
  pub width: u32,
  pub height: u32,
}

/// What a size given to [`Engine::set_size`] means. The values are the C API's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SizeHint {
  None = 0,
  Min = 1,
  Max = 2,
  Fixed = 3,
}

impl SizeHint {
  pub fn from_code(code: i32) -> Self {
    match code {
      1 => SizeHint::Min,
      2 => SizeHint::Max,
      3 => SizeHint::Fixed,
      _ => SizeHint::None,
    }
  }
}

/// Where a new webview lives.
#[derive(Debug, Clone, Copy)]
pub enum Host {
  /// A window of the engine's own, shown when its size is first set or it runs.
  Own,
  /// Fills the window with this handle value, and follows its size.
  Fill(isize),
  /// A child of the window with this handle value, at the given rectangle.
  Child(isize, Bounds),
}

type BindingFn = Rc<dyn Fn(&str, &str)>;
/// The popup handler, shared with the closure `wry` calls for a new-window request.
type NewWindowSlot = Rc<RefCell<Option<Rc<dyn Fn(String)>>>>;

struct Binding {
  /// Distinguishes this registration from a later one under the same name.
  generation: u64,
  callback: BindingFn,
}

enum HostWindow {
  Own { window: TaoWindow, listener: u64 },
  /// A window the webview was given to fill (`Host::Fill`), by handle value:
  /// lent again for each call (`window::with_mount_target`).
  Filled(isize),
  /// A window the webview is a child of (`Host::Child`), by handle value.
  Foreign(isize),
}

/// What exists only while the webview does. Fields drop in this order: what
/// was added to the webview, the webview, then its own window.
struct Live {
  extras: WebviewExtras,
  webview: WebView,
  window: HostWindow,
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// The answering half of each live webview, for the functions any thread may call.
static RESPONDERS: Mutex<Option<HashMap<EngineId, Responder>>> = Mutex::new(None);

thread_local! {
  static ENGINES: RefCell<HashMap<EngineId, Rc<Inner>>> = RefCell::new(HashMap::new());
  /// How many webview-originated callbacks are on the stack. A webview is not dropped while one is.
  static CALLBACK_DEPTH: Cell<u32> = const { Cell::new(0) };
  /// Webviews destroyed while a callback was on the stack, whose drop waits for a later turn.
  static UNDROPPED: RefCell<Vec<Weak<Inner>>> = const { RefCell::new(Vec::new()) };
}

/// Destroys every webview of this thread that is still alive, and drops those whose drop was
/// waiting for a later turn of the loop, unless a webview's callback is on the stack now (the
/// process is ending from inside one): those are left to the OS. Each webview goes before the
/// window it lives in.
pub(crate) fn release_all() {
  let live: Vec<Rc<Inner>> = ENGINES.try_with(|engines| engines.borrow().values().cloned().collect()).unwrap_or_default();
  for inner in live {
    inner.destroy();
  }
  if CALLBACK_DEPTH.with(Cell::get) > 0 {
    return;
  }
  let waiting: Vec<Rc<Inner>> = UNDROPPED.try_with(|all| all.borrow_mut().drain(..).filter_map(|weak| weak.upgrade()).collect()).unwrap_or_default();
  for inner in waiting {
    inner.drop_live();
  }
}

/// The answering half of webview `id`, from any thread. `None` once it is destroyed.
pub fn responder(id: EngineId) -> Option<Responder> {
  RESPONDERS.lock().unwrap_or_else(PoisonError::into_inner).as_ref()?.get(&id).cloned()
}

fn register_responder(id: EngineId, responder: Responder) {
  RESPONDERS.lock().unwrap_or_else(PoisonError::into_inner).get_or_insert_with(HashMap::new).insert(id, responder);
}

fn forget_responder(id: EngineId) {
  if let Some(map) = RESPONDERS.lock().unwrap_or_else(PoisonError::into_inner).as_mut() {
    map.remove(&id);
  }
}

/// Marks a webview-originated callback as running for as long as it lives.
struct CallbackScope;

impl CallbackScope {
  fn enter() -> Self {
    CALLBACK_DEPTH.with(|depth| depth.set(depth.get() + 1));
    CallbackScope
  }
}

impl Drop for CallbackScope {
  fn drop(&mut self) {
    CALLBACK_DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
  }
}

/// The wake token of a webview's own cross-thread work. Above every token JavaScript can name.
fn drain_token(id: EngineId) -> u64 {
  (1u64 << 32) | u64::from(id)
}

struct Inner {
  id: EngineId,
  runtime: Rc<Runtime>,
  live: RefCell<Option<Live>>,
  destroyed: Cell<bool>,
  window_value: Cell<isize>,
  own_window_shown: Cell<bool>,
  bindings: RefCell<BTreeMap<String, Binding>>,
  next_generation: Cell<u64>,
  bind_script: RefCell<Option<UserScript>>,
  /// Scripts added with `init`; kept so they stay registered.
  init_scripts: RefCell<Vec<UserScript>>,
  new_window: NewWindowSlot,
  /// Navigations and evaluations asked for while a script added by `init` or
  /// `bind` was not yet registered, in the order asked; carried out once
  /// every script is.
  held: RefCell<VecDeque<PageOp>>,
  /// How many times the webview was told its window moved (a test hook: the
  /// position WebView2 keeps for its window is not readable from outside).
  moves_told: Cell<u32>,
}

/// Something the host asked of the page that must happen after the scripts
/// added before it are registered: a navigation, or a script evaluated in
/// the current document (`eval`, a binding's reply, the bridge's notices).
enum PageOp {
  Url(String),
  Html(String),
  Script(String),
}

/// One webview. Cheap to clone; every clone names the same webview.
#[derive(Clone)]
pub struct Engine {
  inner: Rc<Inner>,
}

impl Engine {
  /// Makes a webview. `debug` enables the developer tools; the context menu is
  /// on either way, as the C++ library left it.
  pub fn create(debug: bool, host: Host) -> Result<Engine> {
    let runtime = Runtime::get()?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let slot: Rc<RefCell<Weak<Inner>>> = Rc::new(RefCell::new(Weak::new()));
    let new_window: NewWindowSlot = Rc::new(RefCell::new(None));

    let message_slot = slot.clone();
    let popup_handler = new_window.clone();
    let popup_runtime = Rc::downgrade(&runtime);
    // WebView2's own zoom, pinch zoom and swipe navigation, which the C++ library left on and
    // `wry` turns off; CSS `app-region`, which `wry` turns on, is turned off by `WebviewExtras::attach`.
    let builder = sweetview_platform_webview::with_page_behaviour(WebViewBuilder::new())
      .with_devtools(debug)
      // How `wry` grants the clipboard-read permission the C++ library granted.
      .with_clipboard(true)
      .with_ipc_handler(move |request| {
        let inner = message_slot.borrow().upgrade();
        if let Some(inner) = inner {
          inner.on_page_message(request.body());
        }
      })
      .with_new_window_req_handler(move |url, _features| {
        // With no handler the engine's default applies. With one, the popup is
        // reported instead of opened, on a later turn of the loop.
        let handler = popup_handler.borrow().clone();
        match (handler, popup_runtime.upgrade()) {
          (Some(handler), Some(runtime)) => {
            runtime.defer(move || handler(url));
            NewWindowResponse::Deny
          }
          _ => NewWindowResponse::Allow,
        }
      });
    // The page takes the focus only in a window the engine makes itself, as under the C++
    // library (`owns_window()` in `win32_edge.hh`); `wry` would move it into every webview.
    let builder = configure_for_platform(builder.with_focused(matches!(host, Host::Own)))?;

    let mount = |error: wry::Error| Error::os("the webview could not be created (is the WebView2 runtime installed?)", error);
    let no_window = || Error::state("sweetview: the window handle given for the webview names no window");
    let (webview, window, window_value) = match host {
      Host::Own => {
        let window = runtime
          .with_target(|target| WindowBuilder::new().with_visible(false).with_inner_size(LogicalSize::new(640.0, 480.0)).build(target))?
          .map_err(|e| Error::os("the webview's window could not be created", e))?;
        let webview = builder.build(&window).map_err(mount)?;
        let value = window_value_of(&window);
        let window_id = window.id();
        let close_slot = slot.clone();
        let listener = runtime.add_event_listener(Rc::new(move |event, _target| {
          if let Event::WindowEvent { window_id: id, event: WindowEvent::CloseRequested, .. } = event {
            if *id == window_id {
              let inner = close_slot.borrow().upgrade();
              if let Some(inner) = inner {
                inner.own_window_closed();
              }
            }
          }
        }));
        (webview, HostWindow::Own { window, listener }, value)
      }
      Host::Fill(value) => {
        let webview = crate::window::with_mount_target(value, |parent| builder.build(parent)).ok_or_else(no_window)?.map_err(mount)?;
        (webview, HostWindow::Filled(value), value)
      }
      Host::Child(value, bounds) => {
        let built = crate::window::with_mount_target(value, |parent| builder.with_bounds(wry_rect(bounds)).build_as_child(parent));
        (built.ok_or_else(no_window)?.map_err(mount)?, HostWindow::Foreign(value), value)
      }
    };

    let token = drain_token(id);
    let extras = WebviewExtras::attach(&webview, ExtrasOptions { wake_ui: Arc::new(move || {
      runtime::wake(token);
    }) })
    .map_err(|code| Error::os("the webview's request handling could not be set up", format!("webview_error_t {}", code.code())))?;
    let responder = extras.responder();

    let inner = Rc::new(Inner {
      id,
      runtime: runtime.clone(),
      live: RefCell::new(Some(Live { extras, webview, window })),
      destroyed: Cell::new(false),
      window_value: Cell::new(window_value),
      own_window_shown: Cell::new(false),
      bindings: RefCell::new(BTreeMap::new()),
      next_generation: Cell::new(1),
      bind_script: RefCell::new(None),
      init_scripts: RefCell::new(Vec::new()),
      new_window,
      held: RefCell::new(VecDeque::new()),
      moves_told: Cell::new(0),
    });
    *slot.borrow_mut() = Rc::downgrade(&inner);

    // Held navigations and evaluations run on a later turn, once every script is registered:
    // the handler runs inside WebView2's completion callback.
    let release_target = Rc::downgrade(&inner);
    let release_runtime = Rc::downgrade(&runtime);
    inner.with_live(|live| {
      live.extras.set_scripts_registered_handler(Some(Rc::new(move || {
        let target = release_target.clone();
        if let Some(runtime) = release_runtime.upgrade() {
          runtime.defer(move || {
            if let Some(inner) = target.upgrade() {
              inner.release_held();
            }
          });
        }
      })));
    });

    let drain_target = Rc::downgrade(&inner);
    runtime.set_drain(
      token,
      Some(Rc::new(move || {
        if let Some(inner) = drain_target.upgrade() {
          inner.with_live(|live| live.extras.drain());
        }
      })),
    );
    ENGINES.with(|engines| engines.borrow_mut().insert(id, inner.clone()));
    register_responder(id, responder);

    // The page's `window.__webview__`, in every top-level document from now on.
    let engine = Engine { inner };
    engine.init(&bridge::init_script(bridge::POST_FUNCTION));
    Ok(engine)
  }

  /// The live webview named `id`, if there is one.
  pub fn from_id(id: EngineId) -> Option<Engine> {
    ENGINES.with(|engines| engines.borrow().get(&id).cloned()).map(|inner| Engine { inner })
  }

  pub fn id(&self) -> EngineId {
    self.inner.id
  }

  pub fn is_destroyed(&self) -> bool {
    self.inner.destroyed.get()
  }

  /// The handle value of the window the webview lives in.
  pub fn window_handle(&self) -> isize {
    self.inner.window_value.get()
  }

  // ---- the window -----------------------------------------------------------------

  pub fn set_title(&self, title: &str) {
    self.inner.with_live(|live| match &live.window {
      HostWindow::Own { window, .. } => window.set_title(title),
      HostWindow::Filled(window) | HostWindow::Foreign(window) => {
        crate::window::with_mount_target(*window, |window| sweetview_platform_window::set_title(window, title));
      }
    });
  }

  /// Sizes the window the webview lives in, in device-independent pixels.
  ///
  /// A window the webview was given (`Host::Fill`) is restyled and resized as
  /// the C++ library's `set_size` did it, and is not shown; see
  /// `sweetview_platform_window::apply_given_window_size`. A child webview's
  /// host window is left alone.
  pub fn set_size(&self, width: u32, height: u32, hint: SizeHint) {
    let shown = self.inner.with_live(|live| {
      let window = match &live.window {
        HostWindow::Own { window, .. } => window,
        HostWindow::Filled(window) => {
          crate::window::with_mount_target(*window, |window| {
            sweetview_platform_window::apply_given_window_size(window, width, height, given_hint(hint))
          });
          return false;
        }
        HostWindow::Foreign(_) => return false,
      };
      let size = LogicalSize::new(f64::from(width), f64::from(height));
      window.set_resizable(hint != SizeHint::Fixed);
      match hint {
        SizeHint::Min => window.set_min_inner_size(Some(size)),
        SizeHint::Max => window.set_max_inner_size(Some(size)),
        SizeHint::None | SizeHint::Fixed => window.set_inner_size(size),
      }
      true
    });
    if shown == Some(true) {
      self.show_own_window();
    }
  }

  /// The engine's own window appears when its size is first set, or when it runs.
  fn show_own_window(&self) {
    if self.inner.own_window_shown.replace(true) {
      return;
    }
    self.inner.with_live(|live| {
      if let HostWindow::Own { window, .. } = &live.window {
        window.set_visible(true);
        window.set_focus();
      }
    });
  }

  /// Moves a child webview inside its host window.
  pub fn set_bounds(&self, bounds: Bounds) {
    self.inner.with_live(|live| {
      let _ = live.webview.set_bounds(wry_rect(bounds));
    });
  }

  pub fn set_visible(&self, visible: bool) {
    self.inner.with_live(|live| {
      let _ = live.webview.set_visible(visible);
    });
  }

  /// Gives the page the keyboard focus.
  pub fn move_focus(&self) {
    // `wry`'s focus is `MoveFocus` with the programmatic reason, as the tabs library calls it.
    self.inner.with_live(|live| live.webview.focus());
  }

  /// Tells the webview its host window moved, so its popups follow.
  pub fn notify_moved(&self) {
    let told = self.inner.with_live(|live| live.extras.notify_parent_window_position_changed());
    if told.is_some() {
      self.inner.moves_told.set(self.inner.moves_told.get().saturating_add(1));
    }
  }

  /// Test hook: how many times [`Engine::notify_moved`] reached a live webview.
  pub fn moves_told(&self) -> u32 {
    self.inner.moves_told.get()
  }

  /// Moves the webview into another window without reloading it.
  pub fn reparent(&self, window: isize) -> Result<()> {
    let moved = crate::window::with_mount_target(window, |parent| self.inner.with_live(|live| reparent(&live.webview, parent)))
      .ok_or_else(|| Error::state("sweetview: the window handle given to reparent names no window"))?;
    match moved {
      Some(Ok(())) => {
        self.inner.window_value.set(window);
        Ok(())
      }
      Some(Err(error)) => Err(Error::os("the webview could not be moved to the window", error)),
      None => Err(Error::state("sweetview: the webview is destroyed")),
    }
  }

  // ---- content --------------------------------------------------------------------

  /// Navigates to `url`. Held back (see [`Inner::page_op`]) while a script added
  /// by `init` or `bind` is not yet registered, so the document has it.
  pub fn navigate(&self, url: &str) {
    self.inner.page_op(PageOp::Url(url.to_owned()));
  }

  /// Shows `html` as the document. Held back like [`navigate`](Self::navigate).
  pub fn set_html(&self, html: &str) {
    self.inner.page_op(PageOp::Html(html.to_owned()));
  }

  /// Runs `source` at the start of every document the webview opens from now
  /// on: every navigation asked for after this call returns.
  pub fn init(&self, source: &str) {
    let added = self.inner.with_live(|live| live.extras.add_user_script(source));
    if let Some(Ok(script)) = added {
      self.inner.init_scripts.borrow_mut().push(script);
    }
  }

  /// Runs `source` in the current document. The result is discarded. Held,
  /// in order, behind navigations and script registrations asked for before
  /// it (see [`Inner::page_op`]), so it reaches the document they lead to.
  pub fn eval(&self, source: &str) {
    self.inner.eval(source);
  }

  // ---- bindings -------------------------------------------------------------------

  /// Makes `name` a global async function of the page. `callback(seq, params)`
  /// runs on a later turn of the loop for each call; `params` is the JSON
  /// text of the argument array.
  pub fn bind(&self, name: &str, callback: BindingFn) -> ErrorCode {
    if self.inner.destroyed.get() {
      return ErrorCode::InvalidState;
    }
    if self.inner.bindings.borrow().contains_key(name) {
      return ErrorCode::Duplicate;
    }
    let generation = self.inner.next_generation.replace(self.inner.next_generation.get() + 1);
    self.inner.bindings.borrow_mut().insert(name.to_owned(), Binding { generation, callback });
    self.inner.refresh_bind_script();
    self.inner.eval(&bridge::on_bind_eval(name));
    ErrorCode::Ok
  }

  pub fn unbind(&self, name: &str) -> ErrorCode {
    if self.inner.destroyed.get() {
      return ErrorCode::InvalidState;
    }
    if self.inner.bindings.borrow_mut().remove(name).is_none() {
      return ErrorCode::NotFound;
    }
    self.inner.refresh_bind_script();
    self.inner.eval(&bridge::on_unbind_eval(name));
    ErrorCode::Ok
  }

  /// Settles the page's promise for call `seq`.
  pub fn return_value(&self, seq: &str, status: i32, result: &str) {
    self.inner.eval(&bridge::reply_eval(seq, status, result));
  }

  // ---- assets, requests, drops ----------------------------------------------------

  pub fn set_asset(&self, path: &str, mime: &str, data: Vec<u8>) -> ErrorCode {
    self.inner.with_extras(|extras| extras.set_asset(path, mime, data))
  }

  pub fn set_background_color(&self, r: u8, g: u8, b: u8, a: u8) -> ErrorCode {
    self.inner.with_live(|live| sweetview_platform_webview::set_background_color(&live.webview, r, g, b, a)).unwrap_or(ErrorCode::InvalidState)
  }

  pub fn set_allow_external_drop(&self, allow: bool) -> ErrorCode {
    self.inner.with_extras(|extras| extras.set_allow_external_drop(allow))
  }

  pub fn set_request_handler(&self, handler: Option<Rc<dyn Fn(RawRequest)>>) -> ErrorCode {
    let handler = handler.map(|handler| -> Rc<dyn Fn(RawRequest)> {
      Rc::new(move |request| {
        let _scope = CallbackScope::enter();
        handler(request);
      })
    });
    self.inner.with_extras(|extras| extras.set_request_handler(handler))
  }

  pub fn set_file_drop_handler(&self, handler: Option<Rc<dyn Fn(Vec<String>)>>) -> ErrorCode {
    let handler = handler.map(|handler| -> Rc<dyn Fn(Vec<String>)> {
      Rc::new(move |paths| {
        let _scope = CallbackScope::enter();
        handler(paths);
      })
    });
    self.inner.with_extras(|extras| extras.set_file_drop_handler(handler))
  }

  // ---- what the tabs library needs --------------------------------------------------

  /// `handler` returns true to mark the key handled.
  pub fn set_accelerator_key_handler(&self, handler: Option<Rc<dyn Fn(KeyData) -> bool>>) -> ErrorCode {
    let handler = handler.map(|handler| -> Rc<dyn Fn(KeyData) -> bool> {
      Rc::new(move |key| {
        let _scope = CallbackScope::enter();
        handler(key)
      })
    });
    self.inner.with_extras(|extras| extras.set_accelerator_key_handler(handler))
  }

  pub fn set_navigation_failed_handler(&self, handler: Option<Rc<dyn Fn(NavigationFailure)>>) -> ErrorCode {
    let handler = handler.map(|handler| -> Rc<dyn Fn(NavigationFailure)> {
      Rc::new(move |failure| {
        let _scope = CallbackScope::enter();
        handler(failure);
      })
    });
    self.inner.with_extras(|extras| extras.set_navigation_failed_handler(handler))
  }

  /// Sends a DevTools Protocol command to the webview.
  pub fn call_devtools_protocol_method(&self, method: &str, params_json: &str) -> ErrorCode {
    self.inner.with_extras(|extras| extras.call_devtools_protocol_method(method, params_json))
  }

  /// With a handler set, a popup (`window.open`, `target="_blank"`) is reported and not opened.
  pub fn set_new_window_handler(&self, handler: Option<Rc<dyn Fn(String)>>) {
    *self.inner.new_window.borrow_mut() = handler;
  }

  // ---- the loop and the end -----------------------------------------------------------

  /// Blocks in the loop until it is asked to exit or this webview's own window is closed.
  pub fn run(&self) -> Result<()> {
    self.show_own_window();
    self.inner.runtime.run_blocking()
  }

  /// Destroys the webview. It counts as destroyed at once; the drop itself
  /// waits until no callback of a webview is on the stack.
  pub fn destroy(&self) {
    self.inner.destroy();
  }
}

impl Inner {
  /// Runs `f` on the live webview. `None` once it is destroyed.
  fn with_live<R>(&self, f: impl FnOnce(&Live) -> R) -> Option<R> {
    if self.destroyed.get() {
      return None;
    }
    let live = self.live.try_borrow().ok()?;
    live.as_ref().map(f)
  }

  /// Runs `f` on what was added to the webview, or answers "destroyed" as the C API did.
  fn with_extras(&self, f: impl FnOnce(&WebviewExtras) -> ErrorCode) -> ErrorCode {
    self.with_live(|live| f(&live.extras)).unwrap_or(ErrorCode::InvalidState)
  }

  fn eval(&self, source: &str) {
    self.page_op(PageOp::Script(source.to_owned()));
  }

  /// Carries out `op`, or holds it while a script registration is
  /// outstanding or earlier operations are held, so everything the host asks
  /// of the page happens in the order asked and after the scripts added
  /// before it, as when adding a script waited for WebView2. A navigation
  /// started before a registration completes can create its document without
  /// the script, and an evaluation made before a held navigation starts would
  /// run in the document that navigation replaces.
  ///
  /// A held navigation stops the one in flight: the held one would cancel it
  /// anyway, and WebView2 reports a registration only once that navigation
  /// has its response or is stopped. A held evaluation stops nothing.
  fn page_op(&self, op: PageOp) {
    let hold = self.with_live(|live| live.extras.scripts_pending() || !self.held.borrow().is_empty());
    match hold {
      Some(true) => {
        let navigates = !matches!(op, PageOp::Script(_));
        self.held.borrow_mut().push_back(op);
        if navigates {
          self.with_live(|live| {
            // The host has asked for another navigation: the stopped one's end
            // is no longer current, as it would not be had the load started now.
            live.extras.note_host_navigation();
            live.extras.stop_navigation();
          });
        }
      }
      Some(false) => self.run_page_op(&op),
      None => {}
    }
  }

  /// Carries out the held operations, in order, while no script registration
  /// is outstanding.
  fn release_held(&self) {
    while self.with_live(|live| !live.extras.scripts_pending()) == Some(true) {
      let Some(op) = self.held.borrow_mut().pop_front() else { return };
      self.run_page_op(&op);
    }
  }

  fn run_page_op(&self, op: &PageOp) {
    self.with_live(|live| {
      let _ = match op {
        PageOp::Url(url) => {
          live.extras.note_host_navigation();
          live.webview.load_url(url)
        }
        PageOp::Html(html) => {
          live.extras.note_host_navigation();
          live.webview.load_html(html)
        }
        PageOp::Script(source) => live.webview.evaluate_script(source),
      };
    });
  }

  /// A message from the page. Called by `wry` from inside WebView2's own callback.
  fn on_page_message(self: &Rc<Self>, message: &str) {
    let Some(call) = bridge::parse_call(message) else { return };
    // The registration this call was made against: a binding removed (or
    // replaced) before the call runs never sees it.
    let Some(generation) = self.bindings.borrow().get(&call.name).map(|binding| binding.generation) else { return };
    let inner = self.clone();
    self.runtime.defer(move || inner.run_call(&call, generation));
  }

  fn run_call(&self, call: &BridgeCall, generation: u64) {
    if self.destroyed.get() {
      return;
    }
    // Cloned out, so the callback may unbind itself or destroy the webview.
    let callback = self.bindings.borrow().get(&call.name).filter(|binding| binding.generation == generation).map(|binding| binding.callback.clone());
    match callback {
      Some(callback) => callback(&call.seq, &call.params),
      None if !call.seq.is_empty() => self.eval(&bridge::reply_eval(&call.seq, 1, &bridge::removed_binding_message(&call.name))),
      None => {}
    }
  }

  /// Replaces the script that defines the bound functions in each new document.
  fn refresh_bind_script(&self) {
    let names: Vec<String> = self.bindings.borrow().keys().cloned().collect();
    let previous = self.bind_script.borrow_mut().take();
    let added = self.with_live(|live| {
      if let Some(previous) = previous {
        live.extras.remove_user_script(previous);
      }
      live.extras.add_user_script(&bridge::bind_script(names.iter().map(String::as_str)))
    });
    if let Some(Ok(script)) = added {
      *self.bind_script.borrow_mut() = Some(script);
    }
  }

  /// The engine's own window was asked to close: the webview goes, and a blocking run ends.
  fn own_window_closed(self: &Rc<Self>) {
    self.destroy();
    self.runtime.request_exit();
  }

  fn destroy(self: &Rc<Self>) {
    if self.destroyed.replace(true) {
      return;
    }
    // From here on no answer is accepted and no callback is delivered.
    forget_responder(self.id);
    ENGINES.with(|engines| engines.borrow_mut().remove(&self.id));
    self.runtime.set_drain(drain_token(self.id), None);
    *self.new_window.borrow_mut() = None;
    self.bindings.borrow_mut().clear();
    self.drop_live();
  }

  /// Drops the webview now, or on a later turn of the loop when a webview's
  /// callback is on the stack or the webview is in use further up it.
  fn drop_live(self: &Rc<Self>) {
    let in_callback = CALLBACK_DEPTH.with(Cell::get) > 0;
    let taken = if in_callback { None } else { self.live.try_borrow_mut().ok().and_then(|mut live| live.take()) };
    match taken {
      Some(live) => {
        let Live { extras, webview, window } = live;
        drop(extras);
        drop(webview);
        if let HostWindow::Own { window, listener } = window {
          self.runtime.remove_event_listener(listener);
          // Gone now, as the C++ library's `webview_destroy` closed it: `tao`
          // alone destroys a dropped window only when its loop next runs.
          sweetview_platform_window::destroy_now(window);
        }
      }
      None if self.live.try_borrow().map(|live| live.is_some()).unwrap_or(true) => {
        let _ = UNDROPPED.try_with(|all| {
          let mut all = all.borrow_mut();
          all.retain(|weak| weak.strong_count() > 0);
          all.push(Rc::downgrade(self));
        });
        let inner = self.clone();
        self.runtime.defer(move || inner.drop_live());
      }
      None => {}
    }
  }
}

fn given_hint(hint: SizeHint) -> sweetview_platform_window::GivenWindowSizeHint {
  use sweetview_platform_window::GivenWindowSizeHint as Given;
  match hint {
    SizeHint::None => Given::None,
    SizeHint::Min => Given::Min,
    SizeHint::Max => Given::Max,
    SizeHint::Fixed => Given::Fixed,
  }
}

fn wry_rect(bounds: Bounds) -> wry::Rect {
  wry::Rect {
    position: PhysicalPosition::new(bounds.x, bounds.y).into(),
    size: PhysicalSize::new(bounds.width, bounds.height).into(),
  }
}

#[cfg(windows)]
thread_local! {
  /// The process's WebView2 environment, made once on the UI thread and shared
  /// by every webview, as the C++ library's webviews shared theirs.
  static ENVIRONMENT: RefCell<Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment>> =
    const { RefCell::new(None) };
}

/// Tests only: lets go of this thread's WebView2 environment once its webviews
/// are gone, so it is released while the thread still runs. A test's thread
/// ends right after its body, and WebView2 faults (`0xc000041d`) when an
/// environment is released by the thread's own teardown.
#[cfg(all(test, windows))]
pub(crate) fn release_environment_for_tests() {
  drop(ENVIRONMENT.with(|cell| cell.borrow_mut().take()));
}

/// The WebView2 environment, created the way the C++ library created it: the
/// profile in `%APPDATA%\<executable file name>` (`WEBVIEW2_USER_DATA_FOLDER`
/// overrides it), no extra browser arguments, so a process on the old library
/// can share the profile. A failure is not kept: the next webview tries again.
#[cfg(windows)]
fn configure_for_platform(builder: WebViewBuilder<'_>) -> Result<WebViewBuilder<'_>> {
  use wry::WebViewBuilderExtWindows;
  let environment = ENVIRONMENT.with(|cell| {
    if let Some(environment) = cell.borrow().as_ref() {
      return Ok(environment.clone());
    }
    let folder = sweetview_platform_webview::default_user_data_folder();
    let environment = sweetview_platform_webview::create_environment(folder.as_deref()).map_err(|code| {
      Error::os("the WebView2 environment could not be created (is the WebView2 runtime installed?)", format!("webview_error_t {}", code.code()))
    })?;
    Ok(cell.borrow_mut().get_or_insert(environment).clone())
  })?;
  Ok(builder.with_environment(environment))
}

#[cfg(not(windows))]
fn configure_for_platform(builder: WebViewBuilder<'_>) -> Result<WebViewBuilder<'_>> {
  Ok(builder)
}

#[cfg(windows)]
fn window_value_of(window: &TaoWindow) -> isize {
  use tao::platform::windows::WindowExtWindows;
  window.hwnd()
}

#[cfg(not(windows))]
fn window_value_of(_window: &TaoWindow) -> isize {
  0
}

#[cfg(windows)]
fn reparent(webview: &WebView, parent: &BorrowedWindow<'_>) -> std::result::Result<(), wry::Error> {
  use wry::WebViewExtWindows;
  webview.reparent(sweetview_platform_window::handle_value(parent))
}

#[cfg(not(windows))]
fn reparent(_webview: &WebView, _parent: &BorrowedWindow<'_>) -> std::result::Result<(), wry::Error> {
  Ok(())
}

#[cfg(all(test, windows))]
#[path = "engine_tests.rs"]
mod tests;
