//! One running instance per application id, with a second launch's payload
//! handed to the first.
//!
//! On Windows: a named mutex, `Local\sweetview.instance.<id>`, decides which
//! launch is the primary. The primary keeps a message-only window of class
//! `SweetviewSingleInstanceWindow` titled `sweetview.instance.<id>`; a
//! secondary looks it up (10 lookups, 25 ms apart) and sends its JSON payload
//! with `WM_COPYDATA`, tagged `0x53575631` ("SWV1"), waiting at most 5000 ms.
//! These are today's names, limits and wire format, so a build of the
//! TypeScript native layer and a build of this crate hand off to each other.

use crate::ShellError;

/// The class of the primary's window.
pub const WINDOW_CLASS: &str = "SweetviewSingleInstanceWindow";
/// `COPYDATASTRUCT.dwData` of a handoff: "SWV1".
pub const COPYDATA_MAGIC: usize = 0x5357_5631;
/// How many times a secondary looks for the primary's window.
pub const LOOKUPS: u32 = 10;
/// The pause before each lookup after the first.
pub const LOOKUP_INTERVAL_MS: u64 = 25;
/// How long a secondary waits for the primary to take the payload.
pub const SEND_TIMEOUT_MS: u32 = 5000;

/// The id used in the names: every UTF-16 unit outside `[a-zA-Z0-9._-]`
/// becomes `_`, as today's JavaScript `replace` does (so a character outside
/// the Basic Multilingual Plane becomes two).
pub fn safe_id(app_id: &str) -> String {
  let mut id = String::with_capacity(app_id.len());
  for c in app_id.chars() {
    if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
      id.push(c);
    } else {
      id.extend(std::iter::repeat_n('_', c.len_utf16()));
    }
  }
  id
}

/// `Local\sweetview.instance.<id>`.
pub fn mutex_name(app_id: &str) -> String {
  format!("Local\\sweetview.instance.{}", safe_id(app_id))
}

/// `sweetview.instance.<id>`.
pub fn window_title(app_id: &str) -> String {
  format!("sweetview.instance.{}", safe_id(app_id))
}

/// Today's `parseSecondInstanceEvent` check: an object with `args`, an array
/// of strings, `cwd`, a string, and `url` absent or a string. The primary
/// accepts (answers 1 to) only such a payload.
pub fn is_valid_payload(payload_json: &str) -> bool {
  let Ok(serde_json::Value::Object(payload)) = serde_json::from_str::<serde_json::Value>(payload_json) else { return false };
  let args_ok = payload.get("args").and_then(serde_json::Value::as_array).is_some_and(|args| args.iter().all(serde_json::Value::is_string));
  let cwd_ok = payload.get("cwd").is_some_and(serde_json::Value::is_string);
  let url_ok = payload.get("url").is_none_or(serde_json::Value::is_string);
  args_ok && cwd_ok && url_ok
}

#[cfg(windows)]
mod imp {
  use std::panic::{catch_unwind, AssertUnwindSafe};
  use std::time::Duration;

  use sweetview_platform_loop::MessageWindow;
  use windows::core::HSTRING;
  use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, HWND, LPARAM, WPARAM};
  use windows::Win32::System::DataExchange::COPYDATASTRUCT;
  use windows::Win32::System::Threading::CreateMutexW;
  use windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, FindWindowExW, GetWindowThreadProcessId, SendMessageTimeoutW, HWND_MESSAGE, SMTO_ABORTIFHUNG,
    WM_CLOSE, WM_COPYDATA,
  };

  use super::{is_valid_payload, mutex_name, window_title, COPYDATA_MAGIC, LOOKUPS, LOOKUP_INTERVAL_MS, SEND_TIMEOUT_MS, WINDOW_CLASS};
  use crate::win::{last_error, OwnedHandle};
  use crate::ShellError;

  /// The primary's hold on an application id. Not `Send`: its window belongs
  /// to the thread that acquired it, whose message loop delivers handoffs.
  /// Dropping it destroys the window (and with it the handler) and then
  /// releases the mutex.
  pub struct SingleInstance {
    _window: MessageWindow,
    /// Declared after the window so it is released after the window is gone, as today.
    _mutex: OwnedHandle,
  }

  /// The outcome of [`acquire`].
  pub enum Acquired {
    /// This process holds the id; later launches hand their payload to it.
    Primary(SingleInstance),
    /// Another instance holds the id. `handed_off` is true when its window
    /// took the payload (answered `WM_COPYDATA` with 1); it reports transport
    /// delivery, not that the primary's handler succeeded.
    Secondary { handed_off: bool },
  }

  pub fn acquire(app_id: &str, payload_json: &str, on_second: impl Fn(&str) + 'static) -> Result<Acquired, ShellError> {
    if app_id.is_empty() {
      return Err(ShellError("sweetview: singleInstance requires appId or identity".into()));
    }
    let name = mutex_name(app_id);
    let wide_name = HSTRING::from(name.as_str());
    // SAFETY: `wide_name` is a NUL-terminated wide string that outlives the call; no security
    // attributes are passed and the mutex is not taken.
    let created = unsafe { CreateMutexW(None, false, &wide_name) };
    // Read before anything else can overwrite the thread's last error.
    let existed = last_error() == ERROR_ALREADY_EXISTS.0 as i32;
    let mutex = OwnedHandle(created.map_err(|_| ShellError(format!("sweetview: CreateMutexW({name}) failed ({})", last_error())))?);
    let title = HSTRING::from(window_title(app_id).as_str());
    if existed {
      let handed_off = hand_off(&title, payload_json);
      drop(mutex);
      return Ok(Acquired::Secondary { handed_off });
    }
    // On failure the mutex is dropped, and so released, on the way out.
    // The window procedure: called by the OS through `MessageWindow`, which also
    // catches a panic; this one is caught here first so it is reported as today.
    let procedure = move |message: u32, _wparam: usize, lparam: isize| match message {
      WM_COPYDATA if lparam != 0 => Some(catch_unwind(AssertUnwindSafe(|| receive(LPARAM(lparam), &on_second))).unwrap_or_else(|_| {
        eprintln!("sweetview: singleInstance WM_COPYDATA handler threw: a panic in the handler");
        0
      })),
      // Only the owner tears this window down; an external WM_CLOSE is ignored.
      WM_CLOSE => Some(0),
      _ => None,
    };
    let window = MessageWindow::new(WINDOW_CLASS, &window_title(app_id), procedure)
      .map_err(|e| ShellError(format!("sweetview: {}({WINDOW_CLASS}) failed ({})", e.call(), e.code())))?;
    Ok(Acquired::Primary(SingleInstance { _window: window, _mutex: mutex }))
  }

  /// Looks for the primary's window and sends it the payload once found.
  fn hand_off(title: &HSTRING, payload_json: &str) -> bool {
    let class = HSTRING::from(WINDOW_CLASS);
    for attempt in 0..LOOKUPS {
      if attempt > 0 {
        std::thread::sleep(Duration::from_millis(LOOKUP_INTERVAL_MS));
      }
      // SAFETY: the class and window names are NUL-terminated wide strings that outlive the
      // call; HWND_MESSAGE searches message-only windows.
      let found = unsafe { FindWindowExW(Some(HWND_MESSAGE), None, &class, title) };
      if let Ok(target) = found {
        return send_copy_data(target, payload_json);
      }
    }
    false
  }

  /// Sends the payload to another instance's window. The window is used only
  /// for the calls below; the OS validates the handle on each, so a window
  /// that closed in between makes them fail, not misbehave.
  fn send_copy_data(target: HWND, payload_json: &str) -> bool {
    let mut process_id = 0u32;
    // SAFETY: `process_id` is a valid u32 for the call to fill; `target` is checked by the OS.
    unsafe { GetWindowThreadProcessId(target, Some(&mut process_id)) };
    if process_id > 0 {
      // SAFETY: takes a process id by value; reads no memory of ours.
      let allowed = unsafe { AllowSetForegroundWindow(process_id) };
      let _ = allowed;
    }
    let bytes = payload_json.as_bytes();
    let Ok(length) = u32::try_from(bytes.len()) else { return false };
    let data = COPYDATASTRUCT { dwData: COPYDATA_MAGIC, cbData: length, lpData: bytes.as_ptr().cast_mut().cast() };
    let mut result = 0usize;
    // SAFETY: `data` and the payload it points to are owned by this frame and outlive the
    // call, which returns only once the receiver is done with them (or the timeout passed and
    // the OS stopped copying them); WM_COPYDATA gives the receiver read access only. `result`
    // is a valid usize for the call to fill.
    let sent = unsafe {
      SendMessageTimeoutW(
        target,
        WM_COPYDATA,
        WPARAM(0),
        LPARAM(&raw const data as isize),
        SMTO_ABORTIFHUNG,
        SEND_TIMEOUT_MS,
        Some(&mut result),
      )
    };
    sent.0 != 0 && result == 1
  }

  /// Reads a handoff. Answers 1 for a valid payload, 0 otherwise, as today.
  /// The handler may drop the lock whose window this runs in.
  fn receive(lparam: LPARAM, on_second: &dyn Fn(&str)) -> isize {
    // SAFETY: for WM_COPYDATA the OS passes in lParam a COPYDATASTRUCT, copied into this
    // process, that stays valid until this window procedure returns; `lparam` was checked
    // to be non-null by the caller, and the struct's layout is the `windows` crate's.
    let data: &COPYDATASTRUCT = unsafe { &*(lparam.0 as *const COPYDATASTRUCT) };
    if data.dwData != COPYDATA_MAGIC || data.cbData == 0 || data.lpData.is_null() {
      return 0;
    }
    // SAFETY: `lpData` points at `cbData` bytes the OS copied into this process for this
    // message; they stay valid and unchanged until the window procedure returns.
    let bytes = unsafe { std::slice::from_raw_parts(data.lpData.cast::<u8>(), data.cbData as usize) };
    let payload = String::from_utf8_lossy(bytes);
    if !is_valid_payload(&payload) {
      return 0;
    }
    on_second(&payload);
    1
  }
}

#[cfg(not(windows))]
mod imp {
  use std::marker::PhantomData;

  use crate::{unported, ShellError};

  /// See the Windows implementation for the contract.
  pub struct SingleInstance {
    _not_send: PhantomData<*const ()>,
  }

  /// See the Windows implementation for the contract.
  pub enum Acquired {
    Primary(SingleInstance),
    Secondary { handed_off: bool },
  }

  pub fn acquire(_app_id: &str, _payload_json: &str, _on_second: impl Fn(&str) + 'static) -> Result<Acquired, ShellError> {
    Err(unported("singleInstance"))
  }
}

pub use imp::{Acquired, SingleInstance};

/// Takes the single-instance lock for `app_id`, or hands `payload_json` (the
/// JSON `{args, cwd, url?}`, carried unchanged) to the instance that holds it.
///
/// On the primary, `on_second(payload_json)` runs on this thread, from its
/// message loop, once per later launch whose payload is valid. A secondary
/// returns after at most 10 lookups 25 ms apart and a 5000 ms send, blocking
/// the calling thread meanwhile, as today's code does between its awaits.
pub fn acquire(app_id: &str, payload_json: &str, on_second: impl Fn(&str) + 'static) -> Result<Acquired, ShellError> {
  imp::acquire(app_id, payload_json, on_second)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn names_are_todays() {
    assert_eq!(safe_id("dev.sweetview.test-1_A"), "dev.sweetview.test-1_A");
    assert_eq!(safe_id("com example/app:\u{e9}"), "com_example_app__");
    assert_eq!(safe_id("a\u{1f600}b"), "a__b", "an astral character is two UTF-16 units, as in JavaScript");
    assert_eq!(mutex_name("my.app"), "Local\\sweetview.instance.my.app");
    assert_eq!(window_title("my app"), "sweetview.instance.my_app");
    assert_eq!(COPYDATA_MAGIC.to_be_bytes()[4..], *b"SWV1");
  }

  #[test]
  fn payloads_are_checked_like_parse_second_instance_event() {
    assert!(is_valid_payload(r#"{"args":[],"cwd":"C:\\"}"#));
    assert!(is_valid_payload(r#"{"args":["a","b"],"cwd":"/","url":"x://y","extra":1}"#));
    for bad in [
      "",
      "not json",
      "[]",
      "null",
      r#"{"cwd":"/"}"#,
      r#"{"args":"a","cwd":"/"}"#,
      r#"{"args":[1],"cwd":"/"}"#,
      r#"{"args":[]}"#,
      r#"{"args":[],"cwd":1}"#,
      r#"{"args":[],"cwd":"/","url":null}"#,
      r#"{"args":[],"cwd":"/","url":5}"#,
    ] {
      assert!(!is_valid_payload(bad), "{bad}");
    }
  }

  #[cfg(windows)]
  mod live {
    use std::cell::RefCell;
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Child, Command, Stdio};
    use std::rc::Rc;
    use std::sync::mpsc;
    use std::time::Duration;

    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, SetWindowTextW, HWND_MESSAGE};

    use super::super::*;
    use crate::win::test_support::{counts, pump, pump_until};

    const ROLE: &str = "SWEETVIEW_SINGLE_INSTANCE_ROLE";
    const APP_ID: &str = "SWEETVIEW_SINGLE_INSTANCE_APP_ID";
    const PAYLOAD: &str = "SWEETVIEW_SINGLE_INSTANCE_PAYLOAD";

    fn unique_app_id(kind: &str) -> String {
      let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
      format!("dev.sweetview.test.{kind}-{}-{nanos}", std::process::id())
    }

    fn payload(args: &[&str]) -> String {
      serde_json::json!({ "args": args, "cwd": "C:\\sweetview-test" }).to_string()
    }

    type Received = Rc<RefCell<Vec<String>>>;

    fn primary(app_id: &str) -> (SingleInstance, Received) {
      let received: Received = Rc::new(RefCell::new(Vec::new()));
      let sink = received.clone();
      match acquire(app_id, &payload(&["primary"]), move |p| sink.borrow_mut().push(p.to_owned())).expect("acquire") {
        Acquired::Primary(lock) => (lock, received),
        Acquired::Secondary { .. } => panic!("{app_id} is already held"),
      }
    }

    fn secondary(app_id: &str, payload_json: &str) -> bool {
      match acquire(app_id, payload_json, |_| panic!("a secondary never receives")).expect("acquire") {
        Acquired::Primary(_) => panic!("expected a secondary"),
        Acquired::Secondary { handed_off } => handed_off,
      }
    }

    #[test]
    fn a_second_acquisition_hands_its_payload_to_the_primary() {
      let _serial = crate::serial();
      let app_id = unique_app_id("same-process");
      let (lock, received) = primary(&app_id);
      // In the same process the send is a direct call into the primary's window procedure.
      let sent = payload(&["--second", "svtest://warm/1"]);
      assert!(secondary(&app_id, &sent));
      assert_eq!(*received.borrow(), std::slice::from_ref(&sent), "carried unchanged");
      // An invalid payload is refused (answered 0) and never reaches the handler.
      assert!(!secondary(&app_id, r#"{"args":"not an array","cwd":"/"}"#));
      assert_eq!(received.borrow().len(), 1);
      drop(lock);
      // Released: the next acquisition is a primary again.
      let (again, _) = primary(&app_id);
      drop(again);
      assert!(acquire("", "{}", |_| {}).is_err());
    }

    /// What `activation.test.ts` "singleInstance retries when the mutex exists
    /// before its message window is discoverable" proves.
    #[test]
    fn a_secondary_retries_until_the_primarys_window_is_found() {
      let _serial = crate::serial();
      let app_id = unique_app_id("race");
      let (lock, received) = primary(&app_id);
      let class = HSTRING::from(WINDOW_CLASS);
      let title = HSTRING::from(window_title(&app_id).as_str());
      // SAFETY: the class and window names are NUL-terminated wide strings that outlive the call.
      let hwnd = unsafe { FindWindowExW(Some(HWND_MESSAGE), None, &class, &title) }.expect("the primary's window");
      // SAFETY: `hwnd` is the window of `lock`, alive on this thread for this whole test.
      unsafe { SetWindowTextW(hwnd, &HSTRING::from("not yet discoverable")) }.expect("hide");
      let (app, sent) = (app_id.clone(), payload(&["--raced"]));
      let expected = sent.clone();
      let racer = std::thread::spawn(move || secondary(&app, &sent));
      std::thread::sleep(Duration::from_millis(60));
      // SAFETY: as above; the window still belongs to `lock` on this thread.
      unsafe { SetWindowTextW(hwnd, &title) }.expect("show");
      // The racer's WM_COPYDATA is a message sent to this thread: pumping delivers it.
      assert!(pump_until(Duration::from_secs(5), || racer.is_finished()));
      assert!(racer.join().expect("racer"), "handed off after retrying");
      pump();
      assert_eq!(*received.borrow(), [expected]);
      drop(lock);
    }

    fn spawn_child(role: &str, app_id: &str, payload_json: &str) -> Child {
      Command::new(std::env::current_exe().expect("test executable"))
        .args(["--exact", "single_instance::tests::live::child_process_role", "--nocapture", "--test-threads=1"])
        .env(ROLE, role)
        .env(APP_ID, app_id)
        .env(PAYLOAD, payload_json)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn the child")
    }

    /// Forwards a child's stdout lines that start with `SWEETVIEW-`.
    fn marker_lines(child: &mut Child) -> mpsc::Receiver<String> {
      let stdout = child.stdout.take().expect("stdout");
      let (sender, receiver) = mpsc::channel();
      std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
          if let Some(start) = line.find("SWEETVIEW-") {
            let _ = sender.send(line[start..].to_owned());
          }
        }
      });
      receiver
    }

    /// Not a test of its own: the body a child process runs. It does nothing
    /// unless a parent test set the role.
    #[test]
    fn child_process_role() {
      let Ok(role) = std::env::var(ROLE) else { return };
      let app_id = std::env::var(APP_ID).expect("app id");
      let payload_json = std::env::var(PAYLOAD).expect("payload");
      let received: Received = Rc::new(RefCell::new(Vec::new()));
      let sink = received.clone();
      let acquired = acquire(&app_id, &payload_json, move |p| sink.borrow_mut().push(p.to_owned())).expect("acquire");
      let mut out = std::io::stdout();
      match (role.as_str(), acquired) {
        ("secondary", Acquired::Secondary { handed_off }) => {
          writeln!(out, "SWEETVIEW-RESULT handed_off={handed_off}").expect("write");
        }
        ("primary", Acquired::Primary(lock)) => {
          writeln!(out, "SWEETVIEW-READY").expect("write");
          out.flush().expect("flush");
          pump_until(Duration::from_secs(15), || !received.borrow().is_empty());
          let got = received.borrow().first().cloned().unwrap_or_default();
          writeln!(out, "SWEETVIEW-RECEIVED {got}").expect("write");
          drop(lock);
        }
        (role, _) => writeln!(out, "SWEETVIEW-WRONG-ROLE {role}").expect("write"),
      }
      out.flush().expect("flush");
    }

    #[test]
    fn a_secondary_process_hands_off_to_this_primary() {
      let _serial = crate::serial();
      let app_id = unique_app_id("child-secondary");
      let (lock, received) = primary(&app_id);
      let sent = payload(&["--extra", "svtest://warm/42"]);
      let mut child = spawn_child("secondary", &app_id, &sent);
      let lines = marker_lines(&mut child);
      // The child's WM_COPYDATA reaches this thread only while it pumps.
      assert!(pump_until(Duration::from_secs(30), || child.try_wait().ok().flatten().is_some()));
      assert!(child.wait().expect("child").success());
      assert_eq!(lines.recv_timeout(Duration::from_secs(5)).expect("result line"), "SWEETVIEW-RESULT handed_off=true");
      assert_eq!(*received.borrow(), [sent]);
      drop(lock);
    }

    #[test]
    fn this_process_hands_off_to_a_primary_process() {
      let _serial = crate::serial();
      let app_id = unique_app_id("child-primary");
      let mut child = spawn_child("primary", &app_id, &payload(&["child"]));
      let lines = marker_lines(&mut child);
      assert_eq!(lines.recv_timeout(Duration::from_secs(30)).expect("ready line"), "SWEETVIEW-READY");
      let sent = payload(&["--from-parent", "svtest://cold/7"]);
      assert!(secondary(&app_id, &sent));
      assert_eq!(lines.recv_timeout(Duration::from_secs(30)).expect("received line"), format!("SWEETVIEW-RECEIVED {sent}"));
      assert!(child.wait().expect("child").success());
    }

    #[test]
    fn acquiring_and_releasing_returns_every_handle() {
      let _serial = crate::serial();
      let app_id = unique_app_id("handles");
      drop(primary(&app_id));
      let before = counts();
      for round in 0..100 {
        let (lock, received) = primary(&app_id);
        assert!(secondary(&app_id, &payload(&[&round.to_string()])));
        assert_eq!(received.borrow().len(), 1);
        drop(lock);
      }
      let after = counts();
      // `<=`: an earlier test's thread may still be exiting, freeing its own USER objects.
      assert!(after.0 <= before.0 && after.1 <= before.1, "USER and GDI objects returned to the starting count: {before:?} -> {after:?}");
      assert!(after.2 <= before.2 + 2, "kernel handles returned to the starting count: {before:?} -> {after:?}");
    }

    /// The repository root, where `bun` resolves `@n1h/sweetview-native`.
    fn repository_root() -> std::path::PathBuf {
      std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
    }

    fn spawn_bun(script: &str) -> Child {
      Command::new("bun")
        .args(["-e", script])
        .current_dir(repository_root())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn bun")
    }

    /// Checklist W6.2 in both directions against today's TypeScript native
    /// layer (`packages/sweetview-native/src/win32/activation.ts`), run by bun.
    /// Ignored by default: it needs bun and the TypeScript layer as it is
    /// before the binding replaces it.
    #[test]
    #[ignore = "drives the TypeScript single-instance through bun; run with --ignored"]
    fn hands_off_to_and_from_the_typescript_implementation() {
      let _serial = crate::serial();

      // This crate's primary, a TypeScript secondary.
      let app_id = unique_app_id("ts-secondary");
      let (lock, received) = primary(&app_id);
      let script = format!(
        "import {{ singleInstance }} from \"@n1h/sweetview-native\";\
         const lock = await singleInstance({{ appId: {app}, urlSchemes: [\"svtest\"], args: [\"--extra\", \"svtest://warm/42\"] }});\
         console.log(\"SWEETVIEW-RESULT \" + JSON.stringify({{ isPrimary: lock.isPrimary, handedOff: lock.handedOff }}));\
         lock.dispose();",
        app = serde_json::to_string(&app_id).expect("json")
      );
      let mut child = spawn_bun(&script);
      let lines = marker_lines(&mut child);
      assert!(pump_until(Duration::from_secs(60), || child.try_wait().ok().flatten().is_some()));
      assert_eq!(lines.recv_timeout(Duration::from_secs(5)).expect("result"), r#"SWEETVIEW-RESULT {"isPrimary":false,"handedOff":true}"#);
      let got: serde_json::Value = serde_json::from_str(&received.borrow()[0]).expect("payload json");
      assert_eq!(got["args"], serde_json::json!(["--extra", "svtest://warm/42"]));
      assert_eq!(got["url"], "svtest://warm/42");
      assert!(got["cwd"].is_string());
      drop(lock);

      // A TypeScript primary, this crate's secondary.
      let app_id = unique_app_id("ts-primary");
      let script = format!(
        "import {{ pumpEvents, singleInstance }} from \"@n1h/sweetview-native\";\
         let got;\
         const lock = await singleInstance({{ appId: {app}, args: [], onSecondInstance: (event) => {{ got = event; }} }});\
         console.log(\"SWEETVIEW-READY \" + lock.isPrimary);\
         const deadline = Date.now() + 30000;\
         while (!got && Date.now() < deadline) {{ pumpEvents(); await Bun.sleep(10); }}\
         console.log(\"SWEETVIEW-RECEIVED \" + JSON.stringify(got ?? null));\
         lock.dispose();",
        app = serde_json::to_string(&app_id).expect("json")
      );
      let mut child = spawn_bun(&script);
      let lines = marker_lines(&mut child);
      assert_eq!(lines.recv_timeout(Duration::from_secs(60)).expect("ready"), "SWEETVIEW-READY true");
      let sent = serde_json::json!({ "args": ["--from-rust", "svtest://x/1"], "cwd": "C:\\sweetview-test", "url": "svtest://x/1" }).to_string();
      assert!(secondary(&app_id, &sent));
      let line = lines.recv_timeout(Duration::from_secs(60)).expect("received");
      let got: serde_json::Value = serde_json::from_str(line.trim_start_matches("SWEETVIEW-RECEIVED ")).expect("json");
      assert_eq!(got, serde_json::from_str::<serde_json::Value>(&sent).expect("json"));
      assert!(child.wait().expect("bun").success());
    }
  }
}
