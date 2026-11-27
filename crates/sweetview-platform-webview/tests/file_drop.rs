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
    let in_drop_event = Rc::new(std::cell::Cell::new(false));
    {
        let delivered = delivered.clone();
        let in_drop_event = in_drop_event.clone();
        let handler = Rc::new(move |paths: Vec<String>| {
            assert!(!in_drop_event.get());
            delivered.borrow_mut().push(paths);
        });
        assert_eq!(extras.set_file_drop_handler(Some(handler)), ErrorCode::Ok);
    }
    view.eval("post({ tag: 'flag', flag: window.__webview_file_drop_enabled__ })");
    assert_eq!(ctx.wait(&view, "flag")["flag"], true);

    view.eval("window.addEventListener('drop', (e) => post({ tag: 'pagedrop', prevented: e.defaultPrevented, types: Array.from(e.dataTransfer.types), files: e.dataTransfer.files.length })); window.addEventListener('dragover', (e) => post({ tag: 'pageover', prevented: e.defaultPrevented }), { once: true });");
    let data = serde_json::json!({ "items": [], "files": [path], "dragOperationsMask": 1 });
    for kind in ["dragEnter", "dragOver", "drop"] {
        let params = serde_json::json!({ "type": kind, "x": 20, "y": 20, "data": data });
        assert_eq!(extras.call_devtools_protocol_method("Input.dispatchDragEvent", &params.to_string()), ErrorCode::Ok);
    }
    ctx.settle(Some(&view), Duration::from_secs(2));
    eprintln!("DBG page {:?}", view.messages.borrow());
    let arrived = ctx.pump(Some(&view), Duration::from_secs(8), || !delivered.borrow().is_empty());
    assert!(arrived, "the drop reached the file drop handler");
    assert_eq!(*delivered.borrow(), vec![vec![path.clone()]], "exactly the dropped file's path, once");
    ctx.settle(Some(&view), Duration::from_millis(200));
    assert_eq!(delivered.borrow().len(), 1);
    drop(view);
    ctx.settle(None, Duration::from_millis(200));
}
