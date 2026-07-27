import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App.tsx";

test("hero demonstrates the local request-to-preview workflow", () => {
  const markup = renderToStaticMarkup(createElement(App));

  assert.match(markup, /Your code\./);
  assert.match(markup, /Always on your machine\./);
  assert.match(markup, /Local workspace/);
  assert.match(markup, /Source and native toolchains stay here/);
  assert.doesNotMatch(markup, /theatre-viewer/);
  assert.doesNotMatch(markup, /deckhand\.sharghi\.no\/s\/local-preview/);
});

test("verified product proof follows the hero", () => {
  const markup = renderToStaticMarkup(createElement(App));

  assert.match(markup, /Fully local tester/);
  assert.match(markup, /Build once per platform/);
  assert.match(markup, /Parallel device boots/);
  assert.match(markup, /Stable share links/);
});
