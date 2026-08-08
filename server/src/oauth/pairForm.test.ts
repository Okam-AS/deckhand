import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PAIR_FORM_SCRIPT } from "./router.ts";

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

/** The browser hands back null for an id that is not on the page; here that is a test failure. */
class StubDocument {
  constructor(
    private readonly input: StubInput,
    private readonly button: StubButton,
  ) {}

  getElementById(id: string): StubInput | StubButton {
    if (id === "c") return this.input;
    if (id === "b") return this.button;
    throw new Error(`the script asked for #${id}, which the page does not have`);
  }
}

class StubWindow {
  private listener: ((e: { persisted: boolean }) => void) | null = null;

  addEventListener(type: string, fn: (e: { persisted: boolean }) => void): void {
    if (type === "pageshow") this.listener = fn;
  }

  /** Coming back to this page from the session history, heap and all. */
  restoreFromBfcache(): void {
    this.listener?.({ persisted: true });
  }
}

function runForm(restoredValue = ""): { input: StubInput; button: StubButton; form: StubForm; window: StubWindow } {
  const input = new StubInput();
  input.value = restoredValue;
  const button = new StubButton(input.form);
  const window = new StubWindow();
  new Function("document", "window", PAIR_FORM_SCRIPT)(new StubDocument(input, button), window);
  return { input, button, form: input.form, window };
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

  it("posts once even when the second submit never touches the button", () => {
    const { input, form } = runForm();
    input.type("GGE-DYW");
    // Enter in a single-field form submits implicitly, reaching no button and so no disabled
    // attribute. The guard on the submit event is the only thing standing there.
    form.requestSubmit();
    assert.equal(form.posts, 1);
  });

  it("is usable again when the visitor comes back to a restored page", () => {
    const { input, button, form, window } = runForm();
    input.type("GGE-DYW");
    window.restoreFromBfcache();
    assert.equal(button.disabled, false, "a POST that never landed must not lock the form for good");
    assert.equal(input.readOnly, false);
    button.click();
    assert.equal(form.posts, 2, "the second attempt is the visitor's retry, not the click that raced the first");
  });

  it("enables Connect for a code the browser restored on its own", () => {
    // A back-navigation puts the value back without running the page's script again, and the
    // markup's disabled attribute is written for an empty field.
    const { button } = runForm("GGE-DYW");
    assert.equal(button.disabled, false, "the visitor would be looking at their code above a dead button");
  });

  it("does not submit an incomplete code", () => {
    const { input, button, form } = runForm();
    input.type("GGE");
    assert.equal(form.posts, 0);
    button.click();
    assert.equal(form.posts, 0, "the button is what stops a half-typed code being spent as a guess");
  });
});
