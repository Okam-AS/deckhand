import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App.tsx";

test("local run console presents simultaneous targets without fake platform UI", () => {
  const markup = renderToStaticMarkup(createElement(App));

  assert.doesNotMatch(markup, /role="tablist"/);
  assert.doesNotMatch(markup, /device-preview-screen/);
  assert.doesNotMatch(markup, />All devices</);
  assert.match(markup, /LOCAL · YOUR MAC/);
  assert.match(markup, /iPhone 17 Pro · iOS 26/);
  assert.match(markup, /Pixel 7 · API 29/);
  assert.match(markup, /Local web process/);
  assert.match(markup, /Vite · 127\.0\.0\.1/);
  assert.match(markup, /One stable viewer URL/);
  assert.match(markup, /Source, builds, and device control never leave this machine\./);
});
