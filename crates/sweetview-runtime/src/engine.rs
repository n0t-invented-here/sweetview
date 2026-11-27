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
use std::path::PathBuf;
use std::rc::{Rc, Weak};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use sweetview_platform_webview::{ErrorCode, ExtrasOptions, Responder, UserScript, WebviewExtras};
pub use sweetview_platform_webview::{KeyData, NavigationFailure, RawRequest};
use sweetview_platform_window::ForeignWindow;
use tao::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use tao::event::{Event, WindowEvent};
use tao::window::{Window as TaoWindow, WindowBuilder};
use wry::{NewWindowResponse, WebContext, WebView, WebViewBuilder};

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
  Foreign(ForeignWindow),
}

/// What exists only while the webview does. Fields drop in this order: what
/// was added to the webview, the webview, its context, then its own window.
struct Live {
  extras: WebviewExtras,
  webview: WebView,
  _context: WebContext,
  window: HostWindow,
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// The answering half of each live webview, for the functions any thread may call.
static RESPONDERS: Mutex<Option<HashMap<EngineId, Responder>>> = Mutex::new(None);

thread_local! {
  static ENGINES: RefCell<HashMap<EngineId, Rc<Inner>>> = RefCell::new(HashMap::new());
  /// How many webview-originated callbacks are on the stack. A webview is not dropped while one is.
  static CALLBACK_DEPTH: Cell<u32> = const { Cell::new(0) };
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

/// Where WebView2 keeps the profile: `%APPDATA%\<executable file name>`, the
/// folder the C++ library used, so an application keeps its cookies and storage.
fn user_data_folder() -> Option<PathBuf> {
  let roaming = std::env::var_os("APPDATA")?;
  let exe = std::env::current_exe().ok()?;
  Some(PathBuf::from(roaming).join(exe.file_name()?))
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
}

/// One webview. Cheap to clone; every clone names the same webview.
#[derive(Clone)]
pub struct Engine {
  inner: Rc<Inner>,
}

impl Engine {
  /// Makes a webview. `debug` enables the developer tools and the default context menu.
  pub fn create(debug: bool, host: Host) -> Result<Engine> {
    let runtime = Runtime::get()?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let slot: Rc<RefCell<Weak<Inner>>> = Rc::new(RefCell::new(Weak::new()));
    let new_window: NewWindowSlot = Rc::new(RefCell::new(None));

    let mut context = WebContext::new(user_data_folder());
    let message_slot = slot.clone();
    let popup_handler = new_window.clone();
    let popup_runtime = Rc::downgrade(&runtime);
    let builder = WebViewBuilder::new_with_web_context(&mut context)
      .with_devtools(debug)
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
    let builder = configure_for_platform(builder, debug);

    let mount = |error: wry::Error| Error::os("the webview could not be created (is the WebView2 runtime installed?)", error);
    let foreign = |value: isize| {
      crate::window::mount_target(value).ok_or_else(|| Error::state("sweetview: the window handle given for the webview names no window"))
    };
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
        let parent = foreign(value)?;
        (builder.build(&parent).map_err(mount)?, HostWindow::Foreign(parent), value)
      }
      Host::Child(value, bounds) => {
        let parent = foreign(value)?;
        let webview = builder.with_bounds(wry_rect(bounds)).build_as_child(&parent).map_err(mount)?;
        (webview, HostWindow::Foreign(parent), value)
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
      live: RefCell::new(Some(Live { extras, webview, _context: context, window })),
      destroyed: Cell::new(false),
      window_value: Cell::new(window_value),
      own_window_shown: Cell::new(false),
      bindings: RefCell::new(BTreeMap::new()),
      next_generation: Cell::new(1),
      bind_script: RefCell::new(None),
      init_scripts: RefCell::new(Vec::new()),
      new_window,
    });
    *slot.borrow_mut() = Rc::downgrade(&inner);

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
      HostWindow::Foreign(window) => {
        sweetview_platform_window::set_title(window, title);
      }
    });
  }

  /// Sizes the window the webview lives in, in device-independent pixels.
  pub fn set_size(&self, width: u32, height: u32, hint: SizeHint) {
    let shown = self.inner.with_live(|live| {
      let HostWindow::Own { window, .. } = &live.window else { return false };
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
    self.inner.with_live(|live| live.extras.move_focus());
  }

  /// Tells the webview its host window moved, so its popups follow.
  pub fn notify_moved(&self) {
    self.inner.with_live(|live| live.extras.notify_parent_window_position_changed());
  }

  /// Moves the webview into another window without reloading it.
  pub fn reparent(&self, window: isize) -> Result<()> {
    let parent = crate::window::mount_target(window)
      .ok_or_else(|| Error::state("sweetview: the window handle given to reparent names no window"))?;
    let moved = self.inner.with_live(|live| reparent(&live.webview, &parent));
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

  pub fn navigate(&self, url: &str) {
    self.inner.with_live(|live| {
      live.extras.note_host_navigation();
      let _ = live.webview.load_url(url);
    });
  }

  pub fn set_html(&self, html: &str) {
    self.inner.with_live(|live| {
      live.extras.note_host_navigation();
      let _ = live.webview.load_html(html);
    });
  }

  /// Runs `source` at the start of every document the webview opens from now on.
  pub fn init(&self, source: &str) {
    let added = self.inner.with_live(|live| live.extras.add_user_script(source));
    if let Some(Ok(script)) = added {
      self.inner.init_scripts.borrow_mut().push(script);
    }
  }

  /// Runs `source` in the current document. The result is discarded.
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
    self.inner.with_extras(|extras| extras.set_background_color(r, g, b, a))
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
    self.with_live(|live| {
      let _ = live.webview.evaluate_script(source);
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
        if let HostWindow::Own { listener, .. } = &live.window {
          self.runtime.remove_event_listener(*listener);
        }
        drop(live);
      }
      None if self.live.try_borrow().map(|live| live.is_some()).unwrap_or(true) => {
        let inner = self.clone();
        self.runtime.defer(move || inner.drop_live());
      }
      None => {}
    }
  }
}

fn wry_rect(bounds: Bounds) -> wry::Rect {
  wry::Rect {
    position: PhysicalPosition::new(bounds.x, bounds.y).into(),
    size: PhysicalSize::new(bounds.width, bounds.height).into(),
  }
}

#[cfg(windows)]
fn configure_for_platform(builder: WebViewBuilder<'_>, debug: bool) -> WebViewBuilder<'_> {
  use wry::WebViewBuilderExtWindows;
  // As the C++ library set them: the default context menu only with `debug`.
  builder.with_default_context_menus(debug)
}

#[cfg(not(windows))]
fn configure_for_platform(builder: WebViewBuilder<'_>, _debug: bool) -> WebViewBuilder<'_> {
  builder
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
fn reparent(webview: &WebView, parent: &ForeignWindow) -> std::result::Result<(), wry::Error> {
  use wry::WebViewExtWindows;
  webview.reparent(sweetview_platform_window::handle_value(parent))
}

#[cfg(not(windows))]
fn reparent(_webview: &WebView, _parent: &ForeignWindow) -> std::result::Result<(), wry::Error> {
  Ok(())
}
