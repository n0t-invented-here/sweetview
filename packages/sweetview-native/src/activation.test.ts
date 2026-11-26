import { expect, test } from "bun:test";
import { parseSecondInstanceEvent } from "./activation";

test("ignores malformed single-instance handoff JSON", () => {
  for (const raw of [
    '{"url":{},"args":5}',
    '{"args":[],"cwd":"/tmp","url":{}}',
    '{"args":[5],"cwd":"/tmp"}',
    '{"args":[],"cwd":null}',
    '{"args":[]}',
    "null",
    "5",
    '"text"',
    "[]",
    "{",
  ]) {
    expect(parseSecondInstanceEvent(raw)).toBeUndefined();
  }
});

test("parses single-instance handoffs with or without a URL", () => {
  const event = { args: ["--open"], cwd: "/tmp" };
  const withUrl = { ...event, url: "sweetview-demo://open" };
  expect(parseSecondInstanceEvent(JSON.stringify(event))).toEqual(event);
  expect(parseSecondInstanceEvent(JSON.stringify(withUrl))).toEqual(withUrl);
});
