// What the user typed in "open a site", as an address a tab can load. Pure,
// so it is tested without a window (web-address.test.ts).

// Hosts that speak plain http when no scheme is typed: this machine, and any bare IPv4 address
// (a dev server on the LAN; a certificate is hardly ever issued for a number).
import { domainToUnicode } from "node:url";

const PLAIN_HTTP_HOST = /^(localhost|.*\.localhost|\d{1,3}(\.\d{1,3}){3}|\[::1\])$/i;
// "name:digits" is host:port, except after a name that is a scheme everyone knows: tel:911 is not a host.
const KNOWN_SCHEME = /^(mailto|tel|sms|javascript|data|file|about|blob|ftp|ws|wss|view-source):/i;

/**
 * "bun.sh" -> "https://bun.sh/", "localhost:3000" -> "http://localhost:3000/"
 * (a dev server speaks plain http; so does a bare IPv4 address). An address
 * with a scheme of its own is taken as written. Throws, in words for the
 * user, on anything that is not an http or https address.
 */
export function webAddress(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("Type a web address first.");
  // "name:" opens a scheme (mailto:, javascript:), unless digits follow: that is host:port.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && (KNOWN_SCHEME.test(trimmed) || !/^[^/?#:]+:\d+([/?#]|$)/.test(trimmed));
  let url: URL;
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    if (!hasScheme && PLAIN_HTTP_HOST.test(url.hostname)) url.protocol = "http:";
  } catch {
    throw new Error(`"${trimmed}" is not a web address.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https addresses open in a tab, not ${url.protocol.slice(0, -1)}.`);
  return url.href;
}

/** The host of an address as a person reads it: an international name in its own script, not as punycode. */
export const displayHost = (address: string): string => domainToUnicode(new URL(address).hostname) + (new URL(address).port ? `:${new URL(address).port}` : "");
