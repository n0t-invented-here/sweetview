// What both platforms put in a tab: the markup of this demo's own page, and
// the script that makes a site's tab follow the site's title. No native code
// here, so each platform's app imports it freely.

export type TabPageWords = {
  /** After "One webview per tab": what a tab is made of on this platform. HTML. */
  lede: string;
  /** The other things to try, under the form. HTML. */
  hint: string;
};

/** The body of a tab's page; frontend/main.ts brings it to life. */
export const tabPageBody = ({ lede, hint }: TabPageWords) => `<main>
<p class="eyebrow">One webview per tab</p>
<h1><input id="title" aria-label="Tab title" spellcheck="false" autocomplete="off" /></h1>
<p class="lede">${lede} <span id="count"></span></p>
<dl class="proof">
<div><dt>Page instance</dt><dd id="instance"></dd></div>
<div><dt>Alive for</dt><dd id="alive"></dd></div>
<div><dt>Clicks in this tab</dt><dd id="clicks">0</dd></div>
</dl>
<div class="actions">
<button id="click" type="button">Click Me</button>
<button id="new" type="button" class="secondary">New Tab</button>
<button id="close" type="button" class="quiet">Close Tab</button>
</div>
<form id="open">
<label for="address">Open a site in a new tab</label>
<div class="row"><input id="address" value="bun.sh" spellcheck="false" autocomplete="off" autocapitalize="off" /><button type="submit" class="secondary">Open</button></div>
<p id="error" role="alert" hidden></p>
</form>
<p class="hint">${hint}</p>
</main>`;

/** Runs in a site's page at document start: the tab's title follows the site's. The app binds `__nativeTabsTitle`. */
export const FOLLOW_TITLE = `(() => {
  let last;
  const report = () => {
    const title = document.title;
    if (title && title !== last && typeof window.__nativeTabsTitle === "function") window.__nativeTabsTitle((last = title));
  };
  new MutationObserver(report).observe(document, { subtree: true, childList: true, characterData: true });
  addEventListener("DOMContentLoaded", report);
  addEventListener("load", report);
})();`;
