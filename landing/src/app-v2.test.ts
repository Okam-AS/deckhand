import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App.tsx";

test("workflow explains the complete local request path", () => {
  const markup = renderToStaticMarkup(createElement(App));

  assert.match(markup, /Agent request/);
  assert.match(markup, /Local MCP server/);
  assert.match(markup, /Device previews/);
  assert.match(markup, /Stable share link/);
});

test("architecture makes local ownership explicit", () => {
  const markup = renderToStaticMarkup(createElement(App));

  assert.match(markup, /Your machine · your tester · your code\./);
  assert.match(
    markup,
    /The backend validates your API key; source, builds, devices, previews, and streams remain on your Mac\./,
  );
});

test("pricing treats the trial as universal and renders three purchase options", () => {
  const markup = renderToStaticMarkup(createElement(App));

  assert.match(markup, /14 days free/);
  assert.equal((markup.match(/class="price-card/g) ?? []).length, 3);
  assert.doesNotMatch(markup, /<h3>Trial<\/h3>/);
  assert.match(markup, /Trial access is currently provisioned directly\./);
});

test("trial actions open an honest GitHub request flow", () => {
  const markup = renderToStaticMarkup(createElement(App));

  assert.match(markup, /Request a trial key/);
  assert.match(markup, /github\.com\/Okam-AS\/deckhand\/issues\/new\?/);
  assert.match(markup, /Trial\+access\+request/);
});
