// Preloaded into an unedited example (`bun --preload <this file> <example>`), so a test can read
// the example's page without touching the example and without a DevTools port (a hosted runner
// refuses the connection to one). It wraps `Webview#setHTML`: before the example's page is set,
// the webview gets one more binding and one more user script, and the script has the page report
// the text of `#state` and `#log`, at load and on every change, through the binding. Each report
// is one line on stdout: `PAGE {"id":"log","text":"..."}`.

import { Webview } from "../../src/index";

const BINDING = "__sweetviewTestPageText";

const reporter = `(() => {
  if (window !== window.top) return;
  const start = () => {
    for (const id of ["state", "log"]) {
      const element = document.getElementById(id);
      if (!element) continue;
      const report = () => window.${BINDING}(id, element.textContent ?? "");
      report();
      new MutationObserver(report).observe(element, { childList: true, characterData: true, subtree: true });
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();`;

const prepared = new WeakSet<Webview>();
const setHTML = Webview.prototype.setHTML;
Webview.prototype.setHTML = function (this: Webview, html: string) {
  if (!prepared.has(this)) {
    prepared.add(this);
    this.bind(BINDING, (id: string, text: string) => {
      console.log(`PAGE ${JSON.stringify({ id, text })}`);
    });
    this.init(reporter);
  }
  return setHTML.call(this, html);
};
