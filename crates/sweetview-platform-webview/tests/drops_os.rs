//! What the page's own drop listener sees while a file drop handler is set, with external drops
//! allowed: a real file drop (driven through WebView2's DevTools protocol, as `file_drop.rs`
//! drives one, so the `File` carries a path) arrives with its default already prevented by the
//! drop script, and an in-page drag of text arrives untouched. Moved here from the native
//! package's `webview.test.ts` (W2.6).
#![cfg(windows)]

mod common;

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use common::Ctx;
use serde_json::{json, Value};
use sweetview_platform_webview::ErrorCode;

#[test]
fn the_page_sees_a_real_file_drop_already_prevented_and_an_in_page_text_drag_untouched() {
    let mut ctx = Ctx::new();
    let view = ctx.view();
    ctx.load_index(&view);
    let extras = view.extras();

    let folder = std::env::temp_dir().join(format!("sweetview-platform-webview-drops-os-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    let path = folder.join("dropped ü.txt");
    std::fs::write(&path, "drop").unwrap();
    let path = path.to_str().unwrap().to_string();

    assert_eq!(extras.set_allow_external_drop(false), ErrorCode::Ok);
    assert_eq!(extras.set_allow_external_drop(true), ErrorCode::Ok);
    let handled: Rc<RefCell<Vec<Vec<String>>>> = Rc::default();
    {
        let handled = handled.clone();
        assert_eq!(extras.set_file_drop_handler(Some(Rc::new(move |paths: Vec<String>| handled.borrow_mut().push(paths)))), ErrorCode::Ok);
    }
    view.eval(
        r#"document.body.style.cssText = "margin:0;height:100vh";
        addEventListener("dragover", (e) => e.preventDefault());
        addEventListener("drop", (e) => {
          const defaultPrevented = e.defaultPrevented;
          e.preventDefault();
          post({ tag: "drop", text: e.dataTransfer.getData("text/plain"), files: e.dataTransfer.files.length, defaultPrevented, handlerSet: window.__webview_file_drop_enabled__ === true });
        });
        post({ tag: "listening" });"#,
    );
    ctx.wait(&view, "listening");
    let drag = |data: Value| {
        for kind in ["dragEnter", "dragOver", "drop"] {
            let params = json!({ "type": kind, "x": 60, "y": 60, "data": data });
            assert_eq!(extras.call_devtools_protocol_method("Input.dispatchDragEvent", &params.to_string()), ErrorCode::Ok, "{kind}");
        }
    };

    drag(json!({ "items": [], "files": [path], "dragOperationsMask": 1 }));
    let file_drop = ctx.wait(&view, "drop");
    assert_eq!(file_drop, json!({ "tag": "drop", "text": "", "files": 1, "defaultPrevented": true, "handlerSet": true }), "the file drop, already prevented");
    assert!(ctx.pump(Some(&view), Duration::from_secs(8), || !handled.borrow().is_empty()), "the handler got the drop");

    drag(json!({ "items": [{ "mimeType": "text/plain", "data": "in-page text" }], "dragOperationsMask": 1 }));
    let text_drop = ctx.wait(&view, "drop");
    assert_eq!(text_drop, json!({ "tag": "drop", "text": "in-page text", "files": 0, "defaultPrevented": false, "handlerSet": true }), "the text drag, untouched");
    ctx.settle(Some(&view), Duration::from_millis(200));
    assert_eq!(*handled.borrow(), vec![vec![path.clone()]], "the handler got the one file's real path, once, and not the text drag");
    drop(view);
    ctx.settle(None, Duration::from_millis(200));
    let _left_for_the_os = std::fs::remove_dir_all(&folder);
}
