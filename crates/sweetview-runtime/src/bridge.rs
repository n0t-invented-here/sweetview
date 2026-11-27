//! The page side of `bind`, `unbind` and `return`: the scripts injected into the
//! page and the message a bound function posts.
//!
//! The scripts are the C++ webview library's, text for text, so a page sees the
//! same `window.__webview__` object and the same promise behaviour as before.
//! Both start by leaving every frame but the top-level document: WebView2 runs
//! scripts added at document creation in every frame.

use serde::Deserialize;
use serde_json::value::RawValue;

/// How the page posts a message to the host on this platform.
#[cfg(windows)]
pub const POST_FUNCTION: &str = "function(message) {\n  return window.chrome.webview.postMessage(message);\n}";
/// How the page posts a message to the host on this platform.
#[cfg(not(windows))]
pub const POST_FUNCTION: &str =
  "function(message) {\n  return window.webkit.messageHandlers.__webview__.postMessage(message);\n}";

/// The script that defines `window.__webview__` in the top-level document.
pub fn init_script(post_function: &str) -> String {
  const BEFORE_POST: &str = r#"(function() {
  'use strict';
  if (window !== window.top) {
    return;
  }
  function generateId() {
    var crypto = window.crypto || window.msCrypto;
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.prototype.slice.call(bytes).map(function(n) {
      var s = n.toString(16);
      return ((s.length % 2) == 1 ? '0' : '') + s;
    }).join('');
  }
  var Webview = (function() {
    var _promises = {};
    function Webview_() {}
    Webview_.prototype.post = function(message) {
      return ("#;
  const AFTER_POST: &str = r#")(message);
    };
    Webview_.prototype.call = function(method) {
      var _id = generateId();
      var _params = Array.prototype.slice.call(arguments, 1);
      var _message = JSON.stringify({
        id: _id,
        method: method,
        params: _params
      });
      var promise = new Promise(function(resolve, reject) {
        _promises[_id] = { resolve: resolve, reject: reject };
      });
      try {
        this.post(_message);
      } catch (e) {
        delete _promises[_id];
        throw e;
      }
      return promise;
    };
    Webview_.prototype.onReply = function(id, status, result) {
      if (!Object.prototype.hasOwnProperty.call(_promises, id)) {
        return;
      }
      var promise = _promises[id];
      delete _promises[id];
      if (result !== undefined) {
        try {
          result = JSON.parse(result);
        } catch (e) {
          promise.reject(new Error("Failed to parse binding result as JSON"));
          return;
        }
      }
      if (status === 0) {
        promise.resolve(result);
      } else {
        promise.reject(result);
      }
    };
    Webview_.prototype.onBind = function(name) {
      if (window.hasOwnProperty(name)) {
        throw new Error('Property "' + name + '" already exists');
      }
      window[name] = (function() {
        var params = [name].concat(Array.prototype.slice.call(arguments));
        return Webview_.prototype.call.apply(this, params);
      }).bind(this);
    };
    Webview_.prototype.onUnbind = function(name) {
      if (!window.hasOwnProperty(name)) {
        throw new Error('Property "' + name + '" does not exist');
      }
      delete window[name];
    };
    return Webview_;
  })();
  window.__webview__ = new Webview();
})()"#;
  format!("{BEFORE_POST}{post_function}{AFTER_POST}")
}

/// The script that defines every bound function in a new top-level document.
pub fn bind_script<'a>(names: impl IntoIterator<Item = &'a str>) -> String {
  let names: Vec<String> = names.into_iter().map(json_string).collect();
  format!(
    r#"(function() {{
  'use strict';
  if (window !== window.top || !window.__webview__) {{
    return;
  }}
  var methods = [{}];
  methods.forEach(function(name) {{
    window.__webview__.onBind(name);
  }});
}})()"#,
    names.join(",")
  )
}

/// Evaluated in the current document when a function is bound after it loaded.
pub fn on_bind_eval(name: &str) -> String {
  format!("if (window.__webview__) {{\nwindow.__webview__.onBind({})\n}}", json_string(name))
}

/// Evaluated in the current document when a function is unbound.
pub fn on_unbind_eval(name: &str) -> String {
  format!("if (window.__webview__) {{\nwindow.__webview__.onUnbind({})\n}}", json_string(name))
}

/// Evaluated to settle the page's promise for call `seq`. An empty `result`
/// is the library's `undefined`; anything else is JSON text the page parses.
pub fn reply_eval(seq: &str, status: i32, result: &str) -> String {
  let result = if result.is_empty() { "undefined".to_owned() } else { json_string(result) };
  format!("window.__webview__.onReply({}, {status}, {result})", json_string(seq))
}

/// The text of the rejection a call gets when its binding was removed before the call ran.
pub fn removed_binding_message(name: &str) -> String {
  json_string(&format!("binding \"{name}\" was removed before the call ran"))
}

/// A JavaScript string literal for `text`. JSON, with the two line separators
/// JSON allows raw and JavaScript source does not escaped as well.
pub fn json_string(text: &str) -> String {
  let json = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned());
  json.replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029")
}

/// One call a bound function posted: `{"id": .., "method": .., "params": [..]}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeCall {
  /// The page's id for the call; `return` echoes it.
  pub seq: String,
  /// The name the function was bound under.
  pub name: String,
  /// The arguments, as the JSON text of an array, exactly as the page wrote it.
  pub params: String,
}

#[derive(Deserialize)]
struct WireCall<'a> {
  id: String,
  method: String,
  #[serde(borrow)]
  params: Option<&'a RawValue>,
}

/// Reads a posted message. `None` for anything that is not a bridge call
/// (another script's `postMessage`, a file-drop notice).
pub fn parse_call(message: &str) -> Option<BridgeCall> {
  let wire: WireCall<'_> = serde_json::from_str(message).ok()?;
  Some(BridgeCall {
    seq: wire.id,
    name: wire.method,
    params: wire.params.map_or_else(String::new, |params| params.get().to_owned()),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_init_script_guards_the_top_frame_and_posts_through_the_given_function() {
    let script = init_script("function(m) { return post(m); }");
    assert!(script.starts_with("(function() {\n  'use strict';\n  if (window !== window.top) {\n    return;\n  }"));
    assert!(script.contains("return (function(m) { return post(m); })(message);"));
    assert!(script.ends_with("window.__webview__ = new Webview();\n})()"));
  }

  #[test]
  fn the_bind_script_lists_names_as_json_and_guards_the_top_frame() {
    let script = bind_script(["__sweetview_rpc", "say \"hi\""]);
    assert!(script.contains("if (window !== window.top || !window.__webview__) {"));
    assert!(script.contains(r#"var methods = ["__sweetview_rpc","say \"hi\""];"#));
    assert!(bind_script([]).contains("var methods = [];"));
  }

  #[test]
  fn a_reply_passes_json_text_as_a_string_and_empty_as_undefined() {
    assert_eq!(reply_eval("ab12", 0, r#"{"a":1}"#), r#"window.__webview__.onReply("ab12", 0, "{\"a\":1}")"#);
    assert_eq!(reply_eval("ab12", 1, ""), r#"window.__webview__.onReply("ab12", 1, undefined)"#);
  }

  #[test]
  fn line_separators_are_escaped_so_the_literal_is_valid_javascript() {
    assert_eq!(json_string("a\u{2028}b\u{2029}c"), r#""a\u2028b\u2029c""#);
  }

  #[test]
  fn a_call_keeps_its_params_text_exactly_and_other_messages_are_not_calls() {
    let call = parse_call(r#"{"id":"0f","method":"greet","params":[{"z":1,"a":[2, 3]},"x"]}"#).expect("a call");
    assert_eq!(call, BridgeCall { seq: "0f".into(), name: "greet".into(), params: r#"[{"z":1,"a":[2, 3]},"x"]"#.into() });
    assert_eq!(parse_call("hello"), None);
    assert_eq!(parse_call(r#"{"kind":"drop"}"#), None);
    assert_eq!(parse_call(r#""a string""#), None);
  }

  #[test]
  fn bind_and_unbind_notices_name_the_function_as_json() {
    assert_eq!(on_bind_eval("f"), "if (window.__webview__) {\nwindow.__webview__.onBind(\"f\")\n}");
    assert_eq!(on_unbind_eval("f"), "if (window.__webview__) {\nwindow.__webview__.onUnbind(\"f\")\n}");
    assert_eq!(removed_binding_message("f"), r#""binding \"f\" was removed before the call ran""#);
  }
}
