# Writing a `deckhand verify` scenario

A scenario is one JSON or YAML file. `server/src/verify/scenario.ts` is the parser and owns
the rules; this page shows the shapes. Check a file before you run it:

```sh
deckhand verify --lint --scenario checkout.yaml
```

It builds nothing and boots nothing. It prints one JSON object on stdout and exits 0 when the
scenario is valid, 3 when it is not:

```json
{"ok":false,"scenario":"/abs/checkout.json","steps":0,"diagnostics":[
  {"step":2,"field":"waitFor.selector",
   "message":"\"{\\\"present\\\": \\\"#done\\\"}\" is JSON/YAML written inside a string; write the object itself, not a quoted string",
   "allowed":"\"#id\", \"id=…\", \"text=…\", \"label=…\", \"value=…\", or { id | text | label | value: \"…\", index?: n, regex?: true }"}]}
```

`step` is 1-based, or `null` for a top-level field. Every problem is reported in one pass.
A real run refuses the same scenarios with exit 3 before it builds anything.

## The file

| Key | Required | Shape |
|---|---|---|
| `steps` | yes | a non-empty list; each step is an object with exactly one action key |
| `name` | no | the run's name; defaults to the file name |
| `device` | no | `{ model?, runtime?, orientation?: landscape \| portrait }`; defaults to iPad (9th generation), iOS 26.5, landscape |
| `env` | no | `{ KEY: string \| number \| boolean }`, passed to Metro and the build |
| `ready` | no | a selector to wait for before the first step, instead of waiting for the screen to settle |

Any other key, at the top, in `device`, in a step or in a selector object, is refused.

## Selectors

A selector is a string in one of these forms, or an object:

| Form | Matches |
|---|---|
| `"#save"` | accessibility id `save` (no spaces) |
| `"id=save"` | the same, spelled out |
| `"text=Sign in"` | visible text; everything after the first `=` is the value, so `text=a=b` is fine |
| `"label=Close"` | accessibility label |
| `"value=3"` | accessibility value |
| `{ id: "row", index: 2 }` | an object with one or more of `id`, `text`, `label`, `value`, plus `index` (0-based, which match) and `regex: true` |

Refused, with the reason: bare text (`"Sign in"` — write `"text=Sign in"`), an unknown prefix
(`"role=button"`), an empty value (`""`, `"#"`, `"text="`), and anything starting with `{` or
`[` — an object or list written inside a string is a mistake, never a selector. Write the
object itself.

## Steps

| Step | Value | Fails as |
|---|---|---|
| `openUrl` | a URL string; confirms iOS's «Open in …?» prompt | navigation |
| `tap` | a selector; waits for it, refuses one that is off screen | navigation |
| `type` | text, into the focused field; recorded by length only | navigation |
| `scroll` | `up`, `down`, `left` or `right` | navigation |
| `scrollUntilVisible` | a selector; scrolls until it is on screen | navigation |
| `waitFor` | a selector, or `{ selector: <sel> }` / `{ absent: <sel> }` with optional `timeoutMs` (default 15000) | navigation |
| `assert` | a selector (on screen now), or exactly one of `{ visible: <sel> }`, `{ present: <sel> }` (anywhere in the tree), `{ absent: <sel> }` | assert |
| `assertNot` | a selector; the same as `assert: { absent: … }` | assert |
| `sleep` | whole milliseconds, 0 to 60000 | — |
| `screenshot` | a file name (letters, digits, `.` `_` `-`, unique in the scenario) | navigation |

`present` and `absent` are `assert` modes; `absent` is also a `waitFor` form. `present` is not
a `waitFor` key and never a selector key.

A failed step in `result.json` carries `kind`: `assert` when the app reached the screen and an
assertion about it was wrong, `navigation` when the scenario could not drive the app there.

## Examples

YAML:

```yaml
name: settings-diagnostics
ready: "#home"
steps:
  - openUrl: myapp://settings
  - waitFor: { selector: "#settings-diagnostics", timeoutMs: 20000 }
  - scrollUntilVisible: text=Delivered by
  - assert: { present: "#settings-diagnostics-delivered-by" }
  - assertNot: text=Error
  - screenshot: diagnostics
```

The same in JSON:

```json
{
  "name": "settings-diagnostics",
  "ready": "#home",
  "steps": [
    { "openUrl": "myapp://settings" },
    { "waitFor": { "selector": "#settings-diagnostics", "timeoutMs": 20000 } },
    { "scrollUntilVisible": "text=Delivered by" },
    { "assert": { "present": "#settings-diagnostics-delivered-by" } },
    { "assertNot": "text=Error" },
    { "screenshot": "diagnostics" }
  ]
}
```

Refused:

```json
{ "waitFor": { "selector": "{\"present\": \"#settings-diagnostics-delivered-by\"}" } }
{ "waitFor": { "present": "#settings-diagnostics-delivered-by" } }
{ "tap": "Save" }
{ "tap": "#save", "timeoutMs": 5000 }
```

The first puts an object in a string, the second gives `waitFor` an `assert` mode (use
`assert: { present: … }`, or `waitFor: "#…"` to wait until it appears), the third is bare text
(`text=Save`), the fourth puts two keys in one step.
