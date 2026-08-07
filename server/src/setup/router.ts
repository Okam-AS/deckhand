import { writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import express from "express";
import type { SetupStore } from "./setupStore.ts";

// ---------------------------------------------------------------------------
// The one-time credential setup page (PLAN §6). Reachable through the tunnel at
// `/setup/<nonce>`; the nonce is the only capability. GET renders a tiny form,
// POST writes the pasted credential to a mode-0600 file on the mini and burns
// the nonce. No secret ever touches MCP, the chat, or a log line.
// ---------------------------------------------------------------------------

export interface SetupRouterDeps {
  store: SetupStore;
  /** Absolute path the PAT is written to (mode 0600). */
  patPath: string;
  /** Called after a credential is saved, so the resolver can be nudged if needed. */
  onCredentialSet?: () => void;
}

/** Fine-grained (`github_pat_`), classic (`ghp_`), or server/OAuth (`ghs_`/`gho_`) tokens. */
function isPlausiblePat(token: string): boolean {
  return /^(github_pat_|ghp_|ghs_|gho_)[A-Za-z0-9_]{16,}$/.test(token);
}

function atomicWrite600(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · deckhand</title>
<style>
/* The viewer's palette (viewer/src/global.css), because a user meets these pages and the
   device grid in one sitting: neutral dark, no warm cast, hue reserved for failure. */
:root{
  --bg:#1e1e1e;--bg-3:#202020;--panel-2:#151515;
  --line:rgba(252,252,246,0.06);--line-strong:rgba(252,252,246,0.12);
  --ink:#fcfcf6;--ink-soft:#c6c7c1;--ink-faint:#8a8a86;
  --accent:#fcfcf6;--coral:#c98b7f;--hairline:#3b3b3b;
  color-scheme:dark;
}
*{box-sizing:border-box}
body{
  font-family:"SF Pro Rounded",ui-rounded,system-ui,-apple-system,sans-serif;
  font-size:16px;line-height:1.55;color:var(--ink);
  max-width:34rem;margin:0 auto;padding:9vh 1.25rem 4rem;min-height:100%;
  background:var(--bg);-webkit-font-smoothing:antialiased;
}
body::before{content:"";position:fixed;inset:0;z-index:-1;background:var(--bg);}
h1{position:relative;display:inline-block;
  font-family:"New York","Iowan Old Style",Georgia,ui-serif,serif;font-weight:650;
  font-size:1.5rem;letter-spacing:-0.01em;margin:0 0 .6rem;padding-bottom:8px;}
h1::after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;background:var(--hairline);}
.muted{color:var(--ink-soft);font-size:.92rem}
label{display:block;font-weight:600;margin:1.4rem 0 .4rem;font-size:.8rem;
  text-transform:uppercase;letter-spacing:.14em;color:var(--ink-faint)}
input[type=password]{width:100%;padding:.7rem .8rem;font:inherit;color:var(--ink);
  border:1px solid var(--line-strong);border-radius:11px;background:var(--panel-2);outline:none}
input[type=password]:focus{border-color:color-mix(in srgb,var(--ink) 35%,transparent)}
button{margin-top:1.5rem;padding:.7rem 1.3rem;font:inherit;font-weight:600;border:0;border-radius:999px;
  color:#141414;cursor:pointer;background:var(--ink);
  box-shadow:0 8px 22px rgba(0,0,0,0.35);transition:transform .15s ease}
button:hover{transform:translateY(-1px)}
button:active{transform:scale(.98)}
.err{color:var(--coral);font-size:.9rem;margin-top:.6rem}
ol{padding-left:1.2rem;color:var(--ink-soft)}ol li{margin:.35rem 0}
code{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:.85em;color:var(--ink)}
a{color:var(--ink)}
.btn-link{display:inline-block;margin:.6rem 0;padding:.6rem 1rem;font-weight:600;text-decoration:none;color:var(--ink);
  border:1px solid color-mix(in srgb,var(--amber) 34%,transparent);border-radius:11px;
  background:linear-gradient(135deg,color-mix(in srgb,var(--amber) 16%,transparent),color-mix(in srgb,var(--coral) 10%,transparent));
  transition:transform .15s ease}
.btn-link:hover{transform:translateY(-1px)}
</style></head><body>${body}</body></html>`;
}

function formPage(owner: string | undefined, error?: string): string {
  const scope = owner ? ` to read <code>${esc(owner)}</code>'s repo(s)` : "";
  return page(
    "Grant repo access",
    `<h1>Grant deckhand read access</h1>
<p class="muted">Paste a GitHub <strong>fine-grained personal access token</strong>${scope}. It's stored only on this Mac (mode 0600) and used to clone your repo — it never passes through the chat.</p>
<p><a class="btn-link" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">→ Generate a fine-grained token on GitHub</a></p>
<ol class="muted">
<li>Create it on your <strong>personal account</strong> (Settings → Developer settings → Personal access tokens → Fine-grained) — <em>not</em> the org settings page.</li>
${owner ? `<li><strong>Resource owner:</strong> <code>${esc(owner)}</code> — then Repository access → only the repo you want.</li>` : `<li>Repository access → only the repo(s) you want to preview.</li>`}
<li>Permissions → Repository → <strong>Contents: Read-only</strong>.</li>
<li>Generate, copy, and paste it below.</li>
</ol>
${owner ? `<p class="muted">If <code>${esc(owner)}</code> requires approval for fine-grained tokens, an org owner must approve it (Org → Settings → Personal access tokens → Pending requests) before it works.</p>` : ""}
<form method="post">
<label for="token">Token</label>
<input id="token" name="token" type="password" autocomplete="off" placeholder="github_pat_…" autofocus>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<button type="submit">Save on this Mac</button>
</form>`,
  );
}

export function createSetupRouter(deps: SetupRouterDeps): express.Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: "64kb" }));

  const expired = page(
    "Link expired",
    `<h1>This setup link is no longer valid</h1>
<p class="muted">It may have already been used or expired (links last 15 minutes). Ask the agent to generate a new one.</p>`,
  );

  router.get("/:nonce", (req, res) => {
    const e = deps.store.peek(req.params.nonce);
    if (!e) {
      res.status(404).type("html").send(expired);
      return;
    }
    res.type("html").send(formPage(e.owner));
  });

  router.post("/:nonce", (req, res) => {
    const e = deps.store.peek(req.params.nonce);
    if (!e) {
      res.status(404).type("html").send(expired);
      return;
    }
    const token = String((req.body as { token?: unknown })?.token ?? "").trim();
    if (!isPlausiblePat(token)) {
      res
        .status(400)
        .type("html")
        .send(formPage(e.owner, "That doesn't look like a GitHub token — fine-grained tokens start with github_pat_."));
      return;
    }
    atomicWrite600(deps.patPath, token + "\n");
    deps.store.consume(req.params.nonce);
    deps.onCredentialSet?.();
    res
      .type("html")
      .send(
        page(
          "Saved",
          `<h1>✓ Credential saved</h1><p class="muted">Return to the agent and ask it to continue — it can now reach your repo.</p>`,
        ),
      );
  });

  return router;
}
