//! The names, limits and wire format of one running instance per application
//! id, as today's code has them, so a build of the TypeScript native layer and a
//! build of the Rust binding hand off to each other.
//!
//! A named mutex, `Local\sweetview.instance.<id>`, decides which launch is the
//! primary. The primary keeps a message-only window of class
//! `SweetviewSingleInstanceWindow` titled `sweetview.instance.<id>`; a
//! secondary looks it up (10 lookups, 25 ms apart) and sends its JSON payload
//! with `WM_COPYDATA`, tagged `0x53575631` ("SWV1"), waiting at most 5000 ms.

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
}
