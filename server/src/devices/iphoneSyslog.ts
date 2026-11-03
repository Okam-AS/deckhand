import { spawn, type ChildProcess } from "node:child_process";
import { IPHONE_MARKER_ENV } from "./iproxy.ts";

// ---------------------------------------------------------------------------
// A physical iPhone's log, from `idevicesyslog`. It only streams — there is no `logcat -d` for the
// past — so it must be started BEFORE the app is launched, and what it holds is bounded. Deckhand
// reports facts (lines, crash markers the OS writes); judging a run stays with the caller.
// ---------------------------------------------------------------------------

export type SyslogLevel = "D" | "I" | "W" | "E" | "F";

export interface SyslogLine {
  at: Date;
  process: string;
  subsystem?: string;
  pid: number;
  level: SyslogLevel;
  message: string;
}

/** `Oct 23 16:31:52.062552 proc(Subsystem)[135] <Notice>: message` */
const LINE = /^([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))? (\S+?)(?:\(([^)]*)\))?\[(\d+)\] <(\w+)>: ?(.*)$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LEVELS: Record<string, SyslogLevel> = { Debug: "D", Info: "I", Notice: "I", Warning: "W", Error: "E", Fault: "F", Critical: "F" };

/**
 * The lines carry no year: it is `now`'s, minus one when that would put the line more than a day in
 * the future (a December line read in January). Continuation lines of a multi-line message are
 * appended to the line they continue.
 */
export function parseIdeviceSyslog(text: string, now = new Date(), continues?: SyslogLine): SyslogLine[] {
  const out: SyslogLine[] = [];
  for (const raw of text.split("\n")) {
    const m = LINE.exec(raw);
    if (!m) {
      const last = out.at(-1) ?? continues;
      if (last && raw.trim() && !raw.startsWith("[connected") && !raw.startsWith("[disconnected")) last.message += `\n${raw}`;
      continue;
    }
    const month = MONTHS.indexOf(m[1]!);
    if (month < 0) continue;
    const ms = m[6] ? Math.floor(Number(`0.${m[6]}`) * 1000) : 0;
    const make = (y: number) => new Date(y, month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), ms);
    let at = make(now.getFullYear());
    if (at.getTime() - now.getTime() > 24 * 3600_000) at = make(now.getFullYear() - 1);
    out.push({ at, process: m[7]!, ...(m[8] ? { subsystem: m[8] } : {}), pid: Number(m[9]), level: LEVELS[m[10]!] ?? "I", message: m[11]! });
  }
  return out;
}

const APP_CRASH = /Terminating app due to uncaught exception|\bEXC_(BAD_ACCESS|CRASH|BAD_INSTRUCTION|GUARD|RESOURCE)\b|^Fatal error: |\bRCTFatal\b|Unhandled JS Exception/;
const REPORTERS = /^(ReportCrash|osanalyticshelper)$/;

/**
 * Lines that record the app crashing: its own fatal messages, or the crash reporter naming its
 * process. Facts, not a verdict — a terminate deckhand sent is not among them.
 */
export function crashMarkers(lines: SyslogLine[], app: { process: string; bundleId: string }): SyslogLine[] {
  return lines.filter(
    (l) =>
      (l.process === app.process && APP_CRASH.test(l.message)) ||
      (REPORTERS.test(l.process) && (new RegExp(`\\b${escape(app.process)}\\b`).test(l.message) || l.message.includes(app.bundleId)) && /crash|corpse|exception|EXC_/i.test(l.message)),
  );
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface IphoneSyslogOptions {
  udid: string;
  maxLines?: number;
  spawnImpl?: typeof spawn;
  now?: () => Date;
}

export class IphoneSyslog {
  readonly udid: string;
  private readonly maxLines: number;
  private readonly spawnImpl: typeof spawn;
  private readonly now: () => Date;
  private child: ChildProcess | undefined;
  private buffer: SyslogLine[] = [];
  private rest = "";
  /** Set when the stream ended without stop(): what it holds stops at that moment. */
  ended: string | undefined;

  constructor(opts: IphoneSyslogOptions) {
    this.udid = opts.udid;
    this.maxLines = opts.maxLines ?? 20_000;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.now = opts.now ?? (() => new Date());
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  livePids(): number[] {
    return this.running && this.child?.pid ? [this.child.pid] : [];
  }

  /** Start streaming; idempotent. Call before launching the app. */
  start(): void {
    if (this.running) return;
    this.ended = undefined;
    const child = this.spawnImpl("idevicesyslog", ["-u", this.udid, "--no-colors", "-K"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, [IPHONE_MARKER_ENV]: "1" },
    });
    this.child = child;
    child.on("error", (e) => {
      if (this.child === child) this.ended = `idevicesyslog could not start (${e.message}): install libimobiledevice (\`brew install libimobiledevice\`)`;
    });
    child.on("exit", (code, sig) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.ended ??= `idevicesyslog exited (${code ?? sig}); lines after that were not captured`;
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.push(chunk));
  }

  private push(chunk: string): void {
    this.rest += chunk;
    const cut = this.rest.lastIndexOf("\n");
    if (cut < 0) return;
    const text = this.rest.slice(0, cut);
    this.rest = this.rest.slice(cut + 1);
    this.buffer.push(...parseIdeviceSyslog(text, this.now(), this.buffer.at(-1)));
    if (this.buffer.length > this.maxLines) this.buffer.splice(0, this.buffer.length - this.maxLines);
  }

  /** Lines held now, optionally since a time and from one process (the app's executable name). */
  lines(filter: { since?: Date; process?: string } = {}): SyslogLine[] {
    return this.buffer.filter((l) => (!filter.since || l.at >= filter.since) && (!filter.process || l.process === filter.process));
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }
}
