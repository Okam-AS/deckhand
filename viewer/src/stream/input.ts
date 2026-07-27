// ---------------------------------------------------------------------------
// Pointer → simulator input over serve-sim's HID `/ws` (via Deckhand's proxy).
// Wire format (verified from serve-sim client + CLI source): binary frame
// [tag:u8][JSON]. Tags: 0x03 touch { type: "begin"|"move"|"end", x, y } with
// x,y normalized 0..1; 0x04 button { button: "home"|... }; 0x06 key
// { type: "down"|"up", usage: <HID usage> }; 0x07 orientation
// { orientation: "portrait"|"landscape_left"|... }. Moves are rAF-throttled
// (latest only); WS auto-reconnects. Coordinates map 1:1 because the canvas
// element's aspect-ratio is set to the device frame's (see DeviceFrame), so
// there is no letterbox within the box. Deckhand's Android bridge speaks the
// same tags, so the viewer needs no platform switch.
// ---------------------------------------------------------------------------

const WS_MSG_TOUCH = 0x03;
const WS_MSG_BUTTON = 0x04;
const WS_MSG_KEY = 0x06;
const WS_MSG_ORIENTATION = 0x07;
const RECONNECT_MS = 350;
// serve-sim's own CLI paces HID key events 4 ms apart; match it so down/up
// ordering never races in the native session.
const KEY_EVENT_SPACING_MS = 4;
const SHIFT_USAGE = 225;

// US-keyboard char → HID usage (mirrors serve-sim's `type` encoding, Apache-2.0).
// The sim interprets usages through its active hardware layout — US by default.
// Characters outside this map (æ, ø, å, emoji, …) cannot be sent over HID.
const CHAR_USAGES: Record<string, { usage: number; shift: boolean }> = (() => {
  const m: Record<string, { usage: number; shift: boolean }> = {};
  for (let i = 0; i < 26; i++) {
    m[String.fromCharCode(97 + i)] = { usage: 4 + i, shift: false };
    m[String.fromCharCode(65 + i)] = { usage: 4 + i, shift: true };
  }
  const digits = ")!@#$%^&*(";
  for (let d = 1; d <= 10; d++) {
    const ch = String(d % 10);
    m[ch] = { usage: 29 + d, shift: false };
    m[digits[d % 10]!] = { usage: 29 + d, shift: true };
  }
  const pairs: Array<[string, string, number]> = [
    ["-", "_", 45], ["=", "+", 46], ["[", "{", 47], ["]", "}", 48], ["\\", "|", 49],
    [";", ":", 51], ["'", '"', 52], ["`", "~", 53], [",", "<", 54], [".", ">", 55], ["/", "?", 56],
  ];
  for (const [plain, shifted, usage] of pairs) {
    m[plain] = { usage, shift: false };
    m[shifted] = { usage, shift: true };
  }
  m[" "] = { usage: 44, shift: false };
  m["\n"] = { usage: 40, shift: false };
  m["\t"] = { usage: 43, shift: false };
  return m;
})();

export type SpecialKey = "return" | "backspace" | "tab" | "escape" | "delete" | "left" | "right" | "up" | "down";
const SPECIAL_USAGES: Record<SpecialKey, number> = {
  return: 40,
  escape: 41,
  backspace: 42,
  tab: 43,
  delete: 76,
  right: 79,
  left: 80,
  down: 81,
  up: 82,
};

export type Orientation = "portrait" | "landscape_left" | "portrait_upside_down" | "landscape_right";

/** Rotate toggles between the two useful positions: portrait and landscape.
 *  (Upside-down and the second landscape are omitted — they aren't useful here.) */
export const ORIENTATION_CYCLE: readonly Orientation[] = ["portrait", "landscape_left"];

type Phase = "begin" | "move" | "end";

export class DeviceInput {
  private ws: WebSocket | null = null;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private down = false;
  private moveScheduled = false;
  private lastMove: { x: number; y: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly wsUrl: string, // wss://host/s/<shareId>/dev/<deviceId>/ws
  ) {}

  start(): void {
    this.connect();
    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointermove", this.onMove);
    this.canvas.addEventListener("pointerup", this.onUp);
    this.canvas.addEventListener("pointercancel", this.onUp);
    this.canvas.style.touchAction = "none";
  }

  dispose(): void {
    this.disposed = true;
    if (this.keyTimer) clearTimeout(this.keyTimer);
    this.keyTimer = null;
    this.keyQueue.length = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointercancel", this.onUp);
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
  }

  private connect(): void {
    if (this.disposed) return;
    const ws = new WebSocket(this.wsUrl);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (!this.disposed) this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS);
    };
    ws.onerror = () => ws.close();
  }

  private coords(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
    return {
      x: clamp((e.clientX - r.left) / (r.width || 1)),
      y: clamp((e.clientY - r.top) / (r.height || 1)),
    };
  }

  private sendTagged(tag: number, payload: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const msg = new Uint8Array(1 + json.length);
    msg[0] = tag;
    msg.set(json, 1);
    ws.send(msg);
  }

  private send(type: Phase, x: number, y: number): void {
    this.sendTagged(WS_MSG_TOUCH, { type, x, y });
  }

  /** Hardware button press (home, volume-up, …). */
  sendButton(name = "home"): void {
    this.sendTagged(WS_MSG_BUTTON, { button: name });
  }

  /** Set the device orientation. */
  sendOrientation(orientation: Orientation): void {
    this.sendTagged(WS_MSG_ORIENTATION, { orientation });
  }

  // --- keyboard (HID key events, paced through a small queue) ---------------

  // `char` rides along on printable key-downs: serve-sim's native side reads
  // only type+usage and ignores it, while Deckhand's Android bridge uses it to
  // `input text` directly (no HID-usage reverse map needed there).
  private keyQueue: Array<{ type: "down" | "up"; usage: number; char?: string }> = [];
  private keyTimer: ReturnType<typeof setTimeout> | null = null;

  private drainKeys(): void {
    if (this.keyTimer) return;
    const step = () => {
      this.keyTimer = null;
      const ev = this.keyQueue.shift();
      if (!ev || this.disposed) return;
      this.sendTagged(WS_MSG_KEY, ev);
      if (this.keyQueue.length) this.keyTimer = setTimeout(step, KEY_EVENT_SPACING_MS);
    };
    step();
  }

  /** Type one character. Returns false when it has no US-keyboard HID mapping. */
  sendChar(ch: string): boolean {
    const key = CHAR_USAGES[ch];
    if (!key) return false;
    if (key.shift) this.keyQueue.push({ type: "down", usage: SHIFT_USAGE });
    this.keyQueue.push({ type: "down", usage: key.usage, char: ch }, { type: "up", usage: key.usage });
    if (key.shift) this.keyQueue.push({ type: "up", usage: SHIFT_USAGE });
    this.drainKeys();
    return true;
  }

  /** Press a non-printing key (return, backspace, arrows, …). */
  sendKey(name: SpecialKey): boolean {
    const usage = SPECIAL_USAGES[name];
    this.keyQueue.push({ type: "down", usage }, { type: "up", usage });
    this.drainKeys();
    return true;
  }

  /** Type a string; returns the characters that had no HID mapping (skipped). */
  sendText(text: string): string[] {
    const skipped: string[] = [];
    for (const ch of text) {
      if (ch === "\r") continue;
      if (!this.sendChar(ch)) skipped.push(ch);
    }
    return skipped;
  }

  private onDown = (e: PointerEvent) => {
    this.down = true;
    this.canvas.setPointerCapture?.(e.pointerId);
    const { x, y } = this.coords(e);
    this.send("begin", x, y);
    e.preventDefault();
  };

  private onMove = (e: PointerEvent) => {
    if (!this.down) return;
    this.lastMove = this.coords(e);
    if (!this.moveScheduled) {
      this.moveScheduled = true;
      requestAnimationFrame(() => {
        this.moveScheduled = false;
        if (this.down && this.lastMove) this.send("move", this.lastMove.x, this.lastMove.y);
      });
    }
    e.preventDefault();
  };

  private onUp = (e: PointerEvent) => {
    if (!this.down) return;
    this.down = false;
    const { x, y } = this.coords(e);
    this.send("end", x, y);
    e.preventDefault();
  };
}
