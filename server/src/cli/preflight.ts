// ---------------------------------------------------------------------------
// What a bare Mac is missing, and — the part that actually matters — WHO can fix it.
//
// Written for an agent that has been handed a repo URL and nothing else. Such an agent will
// happily run `cloudflared tunnel login`, which opens a browser and waits forever, or tell
// the user "installing Xcode…" and then not install Xcode. Both are worse than saying "I
// cannot do this one, here is exactly what to ask for".
//
// So every prerequisite carries its own answer to one question: can a non-interactive process
// with no sudo and no browser fix this? If yes, the fix is a command we print (or run). If no,
// it goes in the NEEDS YOU list, which is the whole point of this module.
// ---------------------------------------------------------------------------

export type Who = "agent" | "human";

export interface Prereq {
  name: string;
  /** Present and usable. */
  ok: boolean;
  /** iOS-only installs are legitimate: Android missing is a warning, not a failure. */
  optional?: boolean;
  detail?: string;
  /** Who can resolve it, and with what. Absent when `ok`. */
  fix?: { who: Who; how: string };
}

export interface Probe {
  which: (cmd: string) => boolean;
  run: (cmd: string, args: string[]) => { code: number; out: string };
  nodeMajor: number;
  env: Record<string, string | undefined>;
}

/**
 * The prerequisite list, as data.
 *
 * Pure apart from the injected probe, so the classification that decides what a user is asked
 * to do is testable — getting "who can fix this" wrong is how an agent ends up either waiting
 * on a browser prompt nobody sees, or asking a user to do something it could have done itself.
 */
export function checkPrereqs(p: Probe): Prereq[] {
  const out: Prereq[] = [];

  out.push({
    name: "node >= 22",
    ok: p.nodeMajor >= 22,
    detail: `v${p.nodeMajor}`,
    ...(p.nodeMajor >= 22
      ? {}
      : {
          fix: {
            who: "human",
            how: "Install Node 22 or newer (nvm: `nvm install 22 && nvm alias default 22`). Changing the default Node is a decision about your whole machine, not just deckhand.",
          },
        }),
  });

  // Xcode, not the Command Line Tools: simctl ships with the full app.
  const hasXcode = p.which("xcodebuild") && p.run("xcrun", ["simctl", "help"]).code === 0;
  out.push({
    name: "Xcode (simctl)",
    ok: hasXcode,
    ...(hasXcode
      ? {}
      : {
          fix: {
            who: "human",
            how: "Install Xcode from the App Store (~10 GB), open it once to accept the licence, then `sudo xcodebuild -license accept`. It needs your Apple ID and your password — I cannot do either.",
          },
        }),
  });

  const hasCloudflared = p.which("cloudflared");
  out.push({
    name: "cloudflared",
    ok: hasCloudflared,
    ...(hasCloudflared ? {} : { fix: { who: "agent", how: "brew install cloudflared" } }),
  });

  // Android is optional: an iOS-only install is a legitimate, working deckhand.
  const hasAdb = p.which("adb") || Boolean(p.env.ANDROID_HOME) || Boolean(p.env.ANDROID_SDK_ROOT);
  const hasEmulator = p.which("emulator") || hasAdb;
  out.push({
    name: "Android SDK (adb, emulator)",
    ok: hasAdb && hasEmulator,
    optional: true,
    detail: hasAdb && hasEmulator ? undefined : "iOS previews will work; Android will not",
    ...(hasAdb && hasEmulator
      ? {}
      : {
          fix: {
            who: "agent",
            how: "brew install --cask android-commandlinetools, then `sdkmanager 'platform-tools' 'emulator' 'system-images;android-34;google_apis;arm64-v8a'`",
          },
        }),
  });

  return out;
}

/**
 * What the tooling cannot supply — split by what the agent should DO about it.
 *
 * These are two different things and treating them alike produced exactly the wrong
 * behaviour: an agent handed a repo URL printed a status report and quoted a paragraph
 * of English at the user, when all it needed to say was "which domain?".
 *
 * `blockers` are errands: a browser, an account, someone's password. Relay them and stop —
 * there is nothing to proceed to.
 * `questions` are inputs: one short question with a one-word answer, after which the agent
 * carries on by itself. Never relay these as prose; just ask.
 */
export interface HumanInput {
  /** Errands. The agent cannot proceed until the user goes and does these. */
  blockers: string[];
  /**
   * Questions. Ask, take the answer, continue — `flag` is where the answer goes.
   * `ask` is the whole question and nothing else, so an agent can relay it verbatim and have
   * it read as a question. The example goes in `hint`, which is for the report, not the ask.
   */
  questions: { ask: string; hint: string; flag: string; optional?: boolean }[];
}

export function humanInput(p: Probe, opts: { hostnameGiven: boolean }): HumanInput {
  const blockers: string[] = [];
  const questions: HumanInput["questions"] = [];

  if (p.which("cloudflared")) {
    const list = p.run("cloudflared", ["tunnel", "list"]);
    if (list.code !== 0) {
      blockers.push(
        "`cloudflared tunnel login` — opens a browser and asks which of your Cloudflare domains to authorise. You must be signed in to Cloudflare, and the domain must already be on your account.",
      );
    }
  }
  if (!opts.hostnameGiven) {
    questions.push({
      ask: "Which hostname should deckhand use?",
      hint: "any subdomain on a domain you have in Cloudflare, e.g. deckhand.yourdomain.com",
      flag: "--hostname",
    });
    questions.push({
      ask: "Do you want to preview web apps too?",
      hint: "if yes, a second hostname for them, e.g. previews.yourdomain.com; if no, skip it",
      flag: "--web-host",
      optional: true,
    });
  }
  return { blockers, questions };
}

/**
 * The report. Blockers and questions are rendered DIFFERENTLY on purpose — the labels are
 * instructions to the agent reading them, and an agent that cannot tell an errand from a
 * question will relay both as prose and then wait.
 */
export function formatPrereqs(prereqs: Prereq[], human: HumanInput): string {
  const lines: string[] = [];
  for (const c of prereqs) {
    const mark = c.ok ? "✓" : c.optional ? "⚠" : "✗";
    lines.push(`  ${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    if (!c.ok && c.fix) lines.push(`      ${c.fix.who === "agent" ? "fix:" : "you:"} ${c.fix.how}`);
  }
  if (human.blockers.length) {
    lines.push("");
    lines.push("  BLOCKED — relay these and stop. They need a browser and the user's Cloudflare account:");
    for (const s of human.blockers) lines.push(`    • ${s}`);
  }
  if (human.questions.length) {
    lines.push("");
    lines.push("  ASK THE USER — one short question each, then run setup again with the answers.");
    lines.push("  Do NOT paste this report at them; just ask.");
    for (const q of human.questions) {
      lines.push(`    ${q.ask}${q.optional ? "  (optional)" : ""}`);
      lines.push(`        → ${q.flag}   ${q.hint}`);
    }
  }
  return lines.join("\n");
}

/** Blocking = a required prerequisite is missing. Optional ones only warn. */
export function blocking(prereqs: Prereq[]): Prereq[] {
  return prereqs.filter((c) => !c.ok && !c.optional);
}
