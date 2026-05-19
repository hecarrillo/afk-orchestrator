import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveChatId } from "../src/subscribers/telegram.ts";

test("resolveChatId: env var wins over config", () => {
  const got = resolveChatId({ envValue: "111", configValue: "222" });
  assert.equal(got, "111");
});

test("resolveChatId: falls back to config when env unset", () => {
  const got = resolveChatId({ envValue: undefined, configValue: "222" });
  assert.equal(got, "222");
});

test("resolveChatId: returns undefined when both missing", () => {
  const got = resolveChatId({ envValue: undefined, configValue: undefined });
  assert.equal(got, undefined);
});

test("resolveChatId: empty env string is treated as unset", () => {
  const got = resolveChatId({ envValue: "", configValue: "222" });
  assert.equal(got, "222");
});
