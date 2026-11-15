import { expect, test } from "bun:test";
import { webAddress } from "./web-address";

test("a bare host is taken as https", () => {
  expect(webAddress("bun.sh")).toBe("https://bun.sh/");
  expect(webAddress("  example.com/a?b=1  ")).toBe("https://example.com/a?b=1");
});

test("a host on this machine is taken as http, with or without a port", () => {
  expect(webAddress("localhost:3000")).toBe("http://localhost:3000/");
  expect(webAddress("localhost")).toBe("http://localhost/");
  expect(webAddress("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
  expect(webAddress("app.localhost:5173")).toBe("http://app.localhost:5173/");
});

test("a host with a port elsewhere is still https", () => {
  expect(webAddress("example.com:8443")).toBe("https://example.com:8443/");
});

test("an address with its own scheme is taken as written", () => {
  expect(webAddress("http://example.com")).toBe("http://example.com/");
  expect(webAddress("https://localhost:3000")).toBe("https://localhost:3000/");
});

test("anything that is not http or https is refused, naming what it was", () => {
  expect(() => webAddress("ftp://files.example")).toThrow("Only http and https addresses open in a tab, not ftp.");
  expect(() => webAddress("mailto:x@y.z")).toThrow("not mailto.");
  expect(() => webAddress("javascript:alert(1)")).toThrow("not javascript.");
  expect(() => webAddress("file:///etc/passwd")).toThrow("not file.");
  expect(() => webAddress("about:blank")).toThrow("not about.");
});

test("what is not an address at all is refused", () => {
  expect(() => webAddress("")).toThrow("Type a web address first.");
  expect(() => webAddress("   ")).toThrow("Type a web address first.");
  expect(() => webAddress("a b")).toThrow('"a b" is not a web address.');
  expect(() => webAddress("http://")).toThrow("is not a web address.");
});
