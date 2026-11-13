// The window's content, built from the row table and repainted from each
// snapshot. Knows nothing of the bridge, so it renders the same from any data.

import type { Group, Row, RowStatus, Snapshot } from "../rows";

const STATUS_LABEL: Record<RowStatus, string> = {
  granted: "Granted",
  limited: "Limited",
  "not-determined": "Not asked",
  denied: "Denied",
  restricted: "Restricted",
  missing: "Not granted",
  "not-applicable": "Not applicable",
  unknown: "Ask to find out",
};

export type Handlers = { ask(row: Row): void; settings(row: Row): void };
export type View = {
  update(snapshot: Snapshot): void;
  /** The line at the bottom: what the last click did. */
  notice(text: string, kind?: "info" | "error"): void;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const identity = ({ bundleId, platform }: Snapshot): string =>
  platform !== "darwin"
    ? "These are macOS permissions; on this system every one reads Not applicable."
    : bundleId
      ? `macOS files the answers under this app, ${bundleId}.`
      : "Running as a bare binary: macOS files the answers under the app that launched it, such as your terminal. The .app asks in its own name.";

export function createView(root: HTMLElement, groups: Group[], handlers: Handlers): View {
  const header = el("header");
  header.append(el("h1", undefined, "Permissions"), el("p", "identity"));
  const who = header.lastElementChild as HTMLParagraphElement;
  root.append(header);

  const paint = new Map<string, (status: RowStatus) => void>();
  for (const group of groups) {
    const section = el("section");
    section.append(el("h2", undefined, group.title));
    const list = el("ul");
    for (const row of group.rows) {
      const item = el("li");
      const what = el("div", "what");
      what.append(el("span", "label", row.label), el("span", "caption", row.caption));
      const pill = el("span", "pill");
      const ask = el("button", "ask", "Ask");
      ask.addEventListener("click", () => handlers.ask(row));
      const settings = el("button", "settings", "Settings");
      settings.addEventListener("click", () => handlers.settings(row));
      if (row.settingsOnly) ask.hidden = true;
      const buttons = el("div", "buttons");
      buttons.append(ask, settings);
      item.append(what, pill, buttons);
      list.append(item);

      let shown: RowStatus | undefined;
      paint.set(row.id, (status) => {
        if (status === shown) return;
        const changed = shown !== undefined;
        shown = status;
        pill.className = `pill ${status}`;
        pill.textContent = STATUS_LABEL[status];
        if (changed) {
          // Restart the highlight so a second change flashes again.
          pill.classList.remove("changed");
          void pill.offsetWidth;
          pill.classList.add("changed");
        }
        const nothingToAsk = status === "granted" || status === "not-applicable";
        const answeredNo = status === "denied" || status === "restricted";
        ask.disabled = nothingToAsk;
        settings.disabled = status === "not-applicable";
        // The accent goes on the button that moves this row forward: macOS shows a prompt once, after a no it is Settings.
        ask.classList.toggle("secondary", nothingToAsk || answeredNo);
        settings.classList.toggle("secondary", !(answeredNo || (row.settingsOnly && !nothingToAsk)));
      });
    }
    section.append(list);
    root.append(section);
  }

  const footer = el("footer");
  footer.hidden = true;
  root.append(footer);

  return {
    update(snapshot) {
      who.textContent = identity(snapshot);
      for (const [id, status] of Object.entries(snapshot.statuses)) paint.get(id)?.(status);
    },
    notice(text, kind = "info") {
      footer.textContent = text;
      footer.className = kind;
      footer.hidden = false;
    },
  };
}
