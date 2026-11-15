// What the user typed in "open a site", as an address a tab can load. Pure,
// so it is tested without a window (web-address.test.ts).

const LOCAL_HOST = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * "bun.sh" -> "https://bun.sh/", "localhost:3000" -> "http://localhost:3000/"
 * (a dev server speaks plain http). An address with a scheme of its own is
 * taken as written. Throws, in words for the user, on anything that is not an
 * http or https address.
 */
export function webAddress(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("Type a web address first.");
  // "name:" opens a scheme (mailto:, javascript:), unless digits follow: that is host:port.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[^/?#:]+:\d+([/?#]|$)/.test(trimmed);
  let url: URL;
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    if (!hasScheme && LOCAL_HOST.test(url.hostname)) url.protocol = "http:";
  } catch {
    throw new Error(`"${trimmed}" is not a web address.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https addresses open in a tab, not ${url.protocol.slice(0, -1)}.`);
  return url.href;
}
