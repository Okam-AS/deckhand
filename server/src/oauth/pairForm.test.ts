import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PAIR_FORM_SCRIPT } from "./router.js";

type Listener = (e: { preventDefault: () => void }) => void;

/**
 * Enough of a form to run the page's own script: a submit is delivered to the listeners, and only
 * counts as a POST if none of them prevented it — which is what a browser does for both
 * requestSubmit() and a click on the submit button.
 */
class StubForm {
  readonly listeners: Listener[] = [];
  posts = 0;

  addEventListener(type: string, fn: Listener): void {
    if (type === "submit") this.listeners.push(fn);
  }

  requestSubmit(): void {
    let prevented = false;
    const event = {
      preventDefault: () => {
        prevented = true;
      },
    };
    for (const listener of [...this.listeners]) listener(event);
    if (!prevented) this.posts++;
  }
}

class StubInput {
  value = "";
  readOnly = false;
  readonly form = new StubForm();
  private listener: (() => void) | null = null;

  addEventListener(type: string, fn: () => void): void {
    if (type === "input") this.listener = fn;
  }

  /** Typing and pasting are the same event; the difference is only how much arrives at once. */
  type(text: string): void {
    if (this.readOnly) return;
    this.value += text;
    this.listener?.();
  }
}

class StubButton {
  disabled = true;
  constructor(private readonly form: StubForm) {}

  click(): void {
    if (this.disabled) return;
    this.form.requestSubmit();
  }
}

function runForm(): { input: StubInput; button: StubButton; form: StubForm } {
  const input = new StubInput();
  const button = new StubButton(input.form);
  const document = {
    getElementById: (id: string): StubInput | StubButton => (id === "c" ? input : button),
  };
  new Function("document", PAIR_FORM_SCRIPT)(document);
  return { input, button, form: input.form };
}

describe("the pairing form", () => {
  it("tidies the code and submits itself once it is complete", () => {
    const { input, form } = runForm();
    input.type("gge dyw");
    assert.equal(input.value, "GGE-DYW", "the visitor should not have to type the hyphen or shift");
    assert.equal(form.posts, 1);
  });

  it("posts a pasted code once, even if Connect is clicked straight after", () => {
    const { input, button, form } = runForm();
    input.type("GGE-DYW");
    button.click();
    assert.equal(form.posts, 1, "a second post spends nothing: the code is single-use, so it reports the working code as invalid");
    assert.equal(button.disabled, true);
    assert.equal(input.readOnly, true);
  });

  it("does not submit an incomplete code", () => {
    const { input, button, form } = runForm();
    input.type("GGE");
    assert.equal(form.posts, 0);
    button.click();
    assert.equal(form.posts, 0, "the button is what stops a half-typed code being spent as a guess");
  });
});
