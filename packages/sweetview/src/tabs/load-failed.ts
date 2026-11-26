// The page a URL tab shows when its navigation fails, shared by the macOS
// (./darwin-tabs) and Windows (./win-tabs) tab drivers.

const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** A self-contained error page naming `address` and `reason`, with a Try Again link back to `address`. */
export const loadFailedPage = (address: string, reason: string): string => `<!doctype html>
<html lang="en"><meta charset="utf-8" /><meta name="color-scheme" content="light dark" />
<title>${escapeHtml(address)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px;font:15px/1.5 -apple-system,system-ui,sans-serif;background:Canvas;color:CanvasText}main{max-width:520px}</style>
<main><h1>This site did not open</h1><p>${escapeHtml(address)}</p><p>${escapeHtml(reason)}</p><a href="${escapeHtml(address)}">Try Again</a></main></html>`;
