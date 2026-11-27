// Evaluated inside the web-app page by the Electron and Tauri demo shells when
// WEB_APP_PROBE=1, to write down what the page itself shows. It reads the
// header badge and the Runtime card (filled from the `info.get` reply), then
// adds a note through the form and waits for it to appear in the list, which
// the page renders only from the `notes.changed` event. The expression
// evaluates to a promise of the report object.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (what, fn, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = fn();
      if (value) return value;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(50);
    }
  };
  const row = (label) => {
    for (const tr of document.querySelectorAll("tr")) {
      if (tr.querySelector("th")?.textContent.trim() === label) return tr.querySelector("td")?.textContent.trim() ?? null;
    }
    return null;
  };
  const notesCount = () => {
    for (const card of document.querySelectorAll(".mantine-Card-root")) {
      if (card.querySelector("h4")?.textContent.trim() === "Notes") return card.querySelector(".mantine-Badge-label")?.textContent.trim() ?? null;
    }
    return null;
  };

  const report = { location: location.href };
  report.transportBadge = await until("the header badge", () => document.querySelector("header .mantine-Badge-label")?.textContent.trim());
  report.infoGet = {
    host: await until("the info.get reply in the Runtime card", () => row("Host")),
    runtime: row("Runtime"),
    platform: row("Platform"),
  };
  const input = await until("the note input", () => document.querySelector('input[placeholder^="Round-trips"]'));
  report.notePlaceholder = input.placeholder;
  report.notesBefore = await until("the notes.list reply", () => (notesCount() !== "0" ? notesCount() : null));

  const text = `Added by the shell probe at ${new Date().toISOString()}`;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const add = await until("the Add button", () => {
    const b = input.form?.querySelector('button[type="submit"]');
    return b && !b.disabled ? b : null;
  });
  const t0 = performance.now();
  add.click();
  await until("the new note, rendered from notes.changed", () => document.body.innerText.includes(text));
  report.notesChangedEvent = { noteShown: text, notesAfter: notesCount(), msFromClick: Math.round(performance.now() - t0) };
  return report;
})()
