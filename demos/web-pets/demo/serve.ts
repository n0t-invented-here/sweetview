// The demo page from Bun.serve: the prebuilt React page and the model files
// the build put beside it.
//
//   just demos web-pets demo            (PORT=4748 by default)

const PORT = Number(process.env.PORT ?? 4748);
const HOST = process.env.HOST ?? "127.0.0.1";
const build = new URL("../build/demo/", import.meta.url);

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Web Pets</title>
<link rel="stylesheet" href="/main.css" />
</head>
<body>
<div id="root"></div>
<script type="module" src="/main.js"></script>
</body>
</html>`;

/** A file under `root`, or nothing when the path leaves it or the file is not there. */
const fileUnder = async (root: URL, relative: string) => {
  const url = new URL(relative, root);
  if (!url.href.startsWith(root.href)) return undefined;
  const file = Bun.file(url);
  return (await file.exists()) ? file : undefined;
};

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    const file = await fileUnder(build, pathname.slice(1));
    return file ? new Response(file) : new Response("not found", { status: 404 });
  },
});

console.log(`Web Pets on http://${HOST}:${server.port}  (Ctrl+C to stop)`);
