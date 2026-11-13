// macOS. Loads a page in a WKWebView, lets the pets drop in, then drives the
// first one with synthetic pointer events (hover, pick up, carry, release)
// and reports what the page says at each step, with a PNG of the window at
// the end. Needs no screen-recording permission: the snapshot is WebKit's own.
//
//   swift scripts/probe.swift http://127.0.0.1:4748/ build/probe.png

import Cocoa
import WebKit

let args = CommandLine.arguments
if args.count != 3 || URL(string: args[1]) == nil {
    print("usage: swift probe.swift <url> <out.png>")
    exit(2)
}
let url = URL(string: args[1])!
let out = URL(fileURLWithPath: args[2])

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let rect = NSRect(x: 0, y: 0, width: 1280, height: 800)
let window = NSWindow(contentRect: rect, styleMask: [.titled], backing: .buffered, defer: false)
window.title = "web-pets probe"
let config = WKWebViewConfiguration()
// The page's console errors and the probe's own reports come back through this handler.
class Reporter: NSObject, WKScriptMessageHandler {
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { print("page:", m.body) }
}
config.userContentController.add(Reporter(), name: "probe")
config.userContentController.addUserScript(WKUserScript(source: """
    window.addEventListener('error', e => webkit.messageHandlers.probe.postMessage('error ' + e.message));
    window.addEventListener('unhandledrejection', e => webkit.messageHandlers.probe.postMessage('rejection ' + (e.reason && e.reason.message || e.reason)));
    const err = console.error; console.error = (...a) => { webkit.messageHandlers.probe.postMessage('console.error ' + a.map(String).join(' ')); err(...a); };
    """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
let web = WKWebView(frame: rect, configuration: config)
window.contentView = web
window.orderFrontRegardless() // WebGL paints only in a window that is on screen

/// What the probe reads from the page: the first pet canvas's place and pointer state.
let readState = """
    (() => {
      const c = document.querySelector('canvas.web-pet');
      if (!c) return 'no canvas';
      const r = c.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), bottomGap: Math.round(innerHeight - r.bottom), pointerEvents: c.style.pointerEvents, cursor: c.style.cursor, count: document.querySelectorAll('canvas.web-pet').length });
    })()
    """

/// A pointer move on the page at a fraction of the first canvas's box.
func hover(_ fx: Double, _ fy: Double) -> String {
    return """
        (() => {
          const r = document.querySelector('canvas.web-pet').getBoundingClientRect();
          const x = r.left + r.width * \(fx), y = r.top + r.height * \(fy);
          document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
          return 'at ' + Math.round(x) + ',' + Math.round(y);
        })()
        """
}

var steps: [(Double, String, String)] = [] // delay after the previous step, label, script
func step(_ delay: Double, _ label: String, _ js: String) { steps.append((delay, label, js)) }

func run(_ i: Int) {
    guard i < steps.count else { return snapshot() }
    let (delay, label, js) = steps[i]
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
        web.evaluateJavaScript(js) { r, e in
            print("\(label): \(r.map { "\($0)" } ?? "")\(e.map { " error \($0)" } ?? "")")
            run(i + 1)
        }
    }
}

func snapshot() {
    web.takeSnapshot(with: nil) { img, err in
        guard let img = img, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else {
            print("snapshot failed: \(err.map { "\($0)" } ?? "no image")")
            exit(1)
        }
        try! png.write(to: out)
        print("wrote \(out.path)")
        exit(0)
    }
}

class Delegate: NSObject, WKNavigationDelegate {
    func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
        print("loaded \(url)")
        // The first pet drops in on its own; the model takes a moment to fetch.
        step(0.6, "falling", readState)
        step(3.0, "landed", readState)
        // Hover: the canvas should take pointer events only over the model.
        step(0.2, "hover beside the pet (top-left corner of the canvas, transparent)", hover(0.02, 0.02))
        step(0.1, "state", readState)
        step(0.1, "hover on the pet (middle of the canvas, lower third)", hover(0.5, 0.7))
        step(0.1, "state", readState)
        step(0.1, "pick up and carry 300px up", """
            (() => { const c = document.querySelector('canvas.web-pet'); const r = c.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height * 0.7;
              const ev = (type, cx, cy) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
              ev('pointerdown', x, y); ev('pointermove', x + 40, y - 150); ev('pointermove', x + 80, y - 300); return 'from ' + Math.round(x) + ',' + Math.round(y); })()
            """)
        step(0.2, "carried", readState)
        step(0.1, "release", """
            (() => { const c = document.querySelector('canvas.web-pet'); const r = c.getBoundingClientRect(); c.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height * 0.7, button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true })); return 'released'; })()
            """)
        step(0.15, "falling again", readState)
        step(2.5, "landed again", readState)
        step(0.1, "click the page to drop a second pet", """
            (() => { document.querySelector('.page').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 300, clientY: 200 })); return 'clicked 300,200'; })()
            """)
        step(0.3, "second pet", readState)
        step(2.5, "both down", "JSON.stringify([...document.querySelectorAll('canvas.web-pet')].map(c => { const r = c.getBoundingClientRect(); return { x: Math.round(r.left), bottomGap: Math.round(innerHeight - r.bottom), w: Math.round(r.width) }; }))")
        run(0)
    }
    func webView(_ w: WKWebView, didFail nav: WKNavigation!, withError error: Error) { print("load failed: \(error)"); exit(1) }
    func webView(_ w: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) { print("load failed: \(error)"); exit(1) }
}
let delegate = Delegate()
web.navigationDelegate = delegate
web.load(URLRequest(url: url))
DispatchQueue.main.asyncAfter(deadline: .now() + 30) { print("timed out"); exit(1) }
app.run()
