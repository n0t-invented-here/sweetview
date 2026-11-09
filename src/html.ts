// The page's index document, served as an asset like everything else. It only
// references the bundle and stylesheet by relative URL; the bytes of those are
// assets too (see createWebviewApp's `assets`). Nothing is inlined, so there
// is no size cap (webview_set_html on Windows stops at 2 MB).
//
//   assets: { "index.html": indexHtml({ title: "My App" }), "main.js": js, "main.css": css }

export type IndexHtmlOptions = {
  title: string;
  /** Asset path of the page bundle, loaded as a module. Default "main.js". */
  js?: string;
  /** Asset path of the stylesheet. Default "main.css"; "" for none. */
  css?: string;
  /** Extra markup for <head>. */
  head?: string;
  /** Markup for <body> before the script; defaults to a #root div. */
  body?: string;
};

const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  map: "application/json",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  wasm: "application/wasm",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
};

/** Content-Type for an asset path, from its extension. */
export const assetMime = (path: string): string => MIME[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

export function indexHtml({ title, js = "main.js", css = "main.css", head = "", body = '<div id="root"></div>' }: IndexHtmlOptions): Blob {
  return new Blob([indexHtmlText({ title, js, css, head, body })], { type: "text/html; charset=utf-8" });
}

/** The same document as a string. */
export function indexHtmlText({ title, js = "main.js", css = "main.css", head = "", body = '<div id="root"></div>' }: IndexHtmlOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
${css ? `<link rel="stylesheet" href="${escapeHtml(css)}" />` : ""}
${head}
</head>
<body>
${body}
<script type="module" src="${escapeHtml(js)}"></script>
</body>
</html>`;
}
