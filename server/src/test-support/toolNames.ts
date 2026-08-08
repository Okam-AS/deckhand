/**
 * How the guardrails read the MCP tool registry out of `mcp/tools.ts`.
 *
 * Three checks are keyed on this one parse — every tool must be documented in PLAN
 * (docs.test.ts), every tool must be wrapped in `audited()` (invariants.test.ts, PLAN §11.2),
 * and no dead name may appear in agent-facing text. A tool the parse cannot see is exempt from
 * all three, and none of them fails: the other nineteen tools keep their sentinels green, so a
 * PARTIAL miss is silent. That is why the pattern lives in one file instead of being written
 * out twice, and why it is wider than the names currently in use.
 *
 * The narrow version — `"([a-z_]+)"` — missed `"ui2"` (a digit killed the whole match) and
 * `'ui'` (single quotes). `TOOL_CALL_ANY_RE` is the backstop for the form no regex can read:
 * a computed or template name. Compare the two counts and a computed name fails loudly rather
 * than quietly opting out.
 */

export const TOOL_CALL_RE = /server\.registerTool\(\s*(["'`])([A-Za-z0-9_]+)\1/g;
export const TOOL_CALL_ANY_RE = /server\.registerTool\(/g;
export const AUDITED_CALL_RE = /audited\(\s*(["'`])([A-Za-z0-9_]+)\1/g;

export function registeredTools(toolsSrc: string): string[] {
  return [...toolsSrc.matchAll(TOOL_CALL_RE)].map((m) => m[2]!);
}

export function registerToolCallCount(toolsSrc: string): number {
  return [...toolsSrc.matchAll(TOOL_CALL_ANY_RE)].length;
}

export function auditedTools(toolsSrc: string): Set<string> {
  return new Set([...toolsSrc.matchAll(AUDITED_CALL_RE)].map((m) => m[2]!));
}

/** Every zod field name declared anywhere in the file, at any nesting depth (`share.pin` counts as `pin`). */
export function schemaFieldNames(toolsSrc: string): Set<string> {
  return new Set([...toolsSrc.matchAll(/([A-Za-z][A-Za-z0-9]*)\s*:\s*z\b/g)].map((m) => m[1]!));
}

/**
 * The text of every string literal, with comments dropped and `${…}` blanked.
 *
 * A regex cannot do this: the file is full of apostrophes inside double quotes
 * ("that repo's default branch"), and a `'…'` pattern pairs them across the real code
 * in between — which drags identifiers like `args.previewId` into what is supposed to
 * be a scan of PROSE. Reading the quotes as a lexer does is the only way the result
 * means what the check claims it means.
 *
 * KNOWN LIMIT — it does not lex REGEX LITERALS. It knows `//`, comment blocks and all
 * three quote characters; a regex containing a quote character (`/["']/`, or a character
 * class with an apostrophe in it) is read as an ordinary quote opening a string, and every
 * quote after it pairs one position out. The scan then silently reports code as prose and
 * prose as code, so the check keyed on it — "keeps dead parameter names out of agent-facing
 * text" — quietly changes what it examines rather than failing. Telling a regex apart from
 * a division needs the previous significant token, and `)` is genuinely ambiguous
 * (`if (x) /re/` versus `(a + b) / c`), so the heuristic has its own silent-misread case:
 * the limit is stated rather than half-fixed.
 *
 * So the precondition is NOT "the input has no regex literal" — `mcp/tools.ts`, the only
 * input today, has three (the two in `slug()` and the id check beside it). It is narrower and
 * it is what actually matters: no regex literal in the input contains a quote character. All
 * three satisfy that. Adding one that does not — `/["']/`, a class with an apostrophe in it —
 * desyncs this lexer silently, so extend it then, or scope the caller to the literals it can
 * trust. `quotedRegexLiterals` below is that precondition as a check, and the caller asserts
 * it — a precondition nothing fails on is the same as no precondition.
 */
export function stringLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let buf = "";
      i++;
      while (i < src.length) {
        const d = src[i]!;
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (quote === "`" && d === "$" && src[i + 1] === "{") {
          let depth = 1;
          i += 2;
          while (i < src.length && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            i++;
          }
          buf += " ";
          continue;
        }
        if (d === quote) {
          i++;
          break;
        }
        buf += d;
        i++;
      }
      out.push(buf);
    } else i++;
  }
  return out;
}

/**
 * Every `/…/` in `src` that contains a quote character — i.e. every regex literal that would
 * desync `stringLiterals`. Empty is the precondition holding.
 *
 * Why this is sound despite sharing the lexer's blind spot: the walk is CORRECT up to the
 * first offending regex, because the only thing that desyncs it is an offending regex. So the
 * first one is always seen, which is the one that has to be reported.
 *
 * Deliberately conservative about what counts as a candidate — `/` to the next unescaped `/`
 * on the SAME line, non-empty — so a division (`(a + b) / c`) has no closer and is not a
 * candidate at all, and a character class containing `/` closes early rather than swallowing
 * the rest of the line. Both directions err toward "not a regex", which is right: the caller
 * uses this to reject, and a guardrail that fires on correct code gets switched off.
 */
export function quotedRegexLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length) {
        const d = src[i]!;
        if (d === "\\") {
          i += 2;
          continue;
        }
        // `${…}` holds CODE, and skipping it as literal text ends the template early at the
        // first quote or backtick inside it. Same brace walk `stringLiterals` uses.
        if (c === "`" && d === "$" && src[i + 1] === "{") {
          let depth = 1;
          i += 2;
          while (i < src.length && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            i++;
          }
          continue;
        }
        i++;
        if (d === c) break;
      }
    } else if (c === "/") {
      let j = i + 1;
      let body = "";
      while (j < src.length && src[j] !== "\n" && src[j] !== "/") {
        if (src[j] === "\\") {
          body += src.slice(j, j + 2);
          j += 2;
          continue;
        }
        body += src[j]!;
        j++;
      }
      if (src[j] === "/" && body.length > 0) {
        if (/["'`]/.test(body)) out.push(`/${body}/`);
        // Consumed either way: a candidate's own slashes must not be re-read as a comment.
        i = j + 1;
      } else i++;
    } else i++;
  }
  return out;
}
