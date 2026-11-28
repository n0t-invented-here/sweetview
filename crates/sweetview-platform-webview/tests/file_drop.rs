//! A file drop driven through WebView2's DevTools protocol, as the repository's
//! live fixture does it: `Input.dispatchDragEvent` `dragEnter`, `dragOver`,
//! `drop` carrying a real file. WebView2 hands the dropped `File` to the drop
//! script, which posts it with `postMessageWithAdditionalObjects`; the
//! `WebMessageReceived` handler reads its path through `ICoreWebView2File`.
#![cfg(windows)]

mod common;

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use common::Ctx;
use sweetview_platform_webview::ErrorCode;

#[test]
fn a_dropped_file_reaches_the_handler_with_its_path() {
    let mut ctx = Ctx::new();
    let view = ctx.view();
    ctx.load_index(&view);
    let extras = view.extras();

    let folder = std::env::temp_dir().join(format!("sweetview-platform-webview-drop-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    let path = folder.join("dropped ü.txt");
    std::fs::write(&path, "file drop fixture").unwrap();
    let path = path.to_str().unwrap().to_string();

    let delivered: Rc<RefCell<Vec<Vec<String>>>> = Rc::default();
    {
        let delivered = delivered.clone();
        let handler = Rc::new(move |paths: Vec<String>| {
            // Delivered from `drain`, after WebView2's message event returned.
            assert!(common::IN_DRAIN.with(|d| d.get()), "the handler runs from drain");
            delivered.borrow_mut().push(paths);
        });
        assert_eq!(extras.set_file_drop_handler(Some(handler)), ErrorCode::Ok);
    }
    view.eval("post({ tag: 'flag', flag: window.__webview_file_drop_enabled__ })");
    assert_eq!(ctx.wait(&view, "flag")["flag"], true);

    let data = serde_json::json!({ "items": [], "files": [path], "dragOperationsMask": 1 });
    for kind in ["dragEnter", "dragOver", "drop"] {
        let params = serde_json::json!({ "type": kind, "x": 20, "y": 20, "data": data });
        assert_eq!(extras.call_devtools_protocol_method("Input.dispatchDragEvent", &params.to_string()), ErrorCode::Ok);
    }
    let arrived = ctx.pump(Some(&view), Duration::from_secs(8), || !delivered.borrow().is_empty());
    assert!(arrived, "the drop reached the file drop handler");
    assert_eq!(*delivered.borrow(), vec![vec![path.clone()]], "exactly the dropped file's path, once");
    ctx.settle(Some(&view), Duration::from_millis(200));
    assert_eq!(delivered.borrow().len(), 1);
    // The drop script's message is the extras' own: the page message handler never sees it,
    // as the C++ fork's `on_message` never did.
    assert!(!view.drain_raw().iter().any(|m| sweetview_platform_webview::is_file_drop_message(m)));
    drop(view);
    ctx.settle(None, Duration::from_millis(200));
}
