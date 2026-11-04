// ---------------------------------------------------------------------------
// WebDriverAgent's `GET /source?format=json` → the `{roots}` tree `describe` returns for a
// simulator, so `screen.ts` refs, selectors and `ui` read a physical iPhone unchanged.
// Frames are points, as WDA reports them and as a WDA tap takes them.
// ---------------------------------------------------------------------------

export interface WdaNode {
  type?: string;
  label?: string | null;
  name?: string | null;
  value?: string | null;
  /** The real accessibilityIdentifier (RN `testID`); `name` falls back to the label when there is none. */
  rawIdentifier?: string | null;
  rect?: { x: number; y: number; width: number; height: number };
  isEnabled?: string | boolean;
  isVisible?: string | boolean;
  isAccessible?: string | boolean;
  isFocused?: string | boolean;
  traits?: string;
  children?: WdaNode[];
}

export interface PhoneNode {
  role: string;
  label?: string;
  value?: string;
  id?: string;
  frame: { x: number; y: number; width: number; height: number };
  enabled?: false;
  focused?: true;
  checked?: boolean;
  secure?: true;
  tappable?: true;
  scrollable?: true;
  children?: PhoneNode[];
}

export interface PhoneTree {
  roots: PhoneNode[];
}

export class WdaSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WdaSourceError";
  }
}

const yes = (v: string | boolean | undefined) => v === true || v === "1";

const INPUT = /^(TextField|SecureTextField|SearchField|TextView)$/;
const TAPPABLE = /^(Button|Cell|Link|Switch|Toggle|TextField|SecureTextField|SearchField|Tab|Key|MenuItem|SegmentedControl|Slider|Stepper|PickerWheel|Image)$/;
const SCROLLER = /^(ScrollView|Table|CollectionView|WebView)$/;
/** Kept even when VoiceOver would skip them: a reader needs to see a spinner or a field. */
const ALWAYS_KEEP = /^(ActivityIndicator|ProgressIndicator|TextField|SecureTextField|SearchField|Switch|Alert|WebView)$/;

/**
 * WDA reports every XCUIElement, including the StaticTexts inside a button that repeat its label.
 * Kept: what VoiceOver reads (`isAccessible`), scrollers and ALWAYS_KEEP; never invisible or
 * zero-area nodes, nor the Application/Window chrome. A nested Application (SpringBoard's alert
 * window over the app) becomes a root of its own, the way SimDeck lists a system alert.
 */
export function wdaSourceToTree(source: unknown): PhoneTree {
  const root = unwrap(source);
  const rootFrame = rectOf(root) ?? { x: 0, y: 0, width: 0, height: 0 };
  const appRoot: PhoneNode = { role: "Application", frame: rootFrame, children: [] };
  const appLabel = str(root.label) ?? str(root.name);
  if (appLabel) appRoot.label = appLabel;
  const roots: PhoneNode[] = [appRoot];

  const walk = (n: WdaNode, parent: PhoneNode, keptRole: string): void => {
    let into = parent;
    let role = keptRole;
    if (n !== root && n.type === "Application") {
      const alert: PhoneNode = { role: "Application", label: str(n.label) ?? str(n.name) ?? "SpringBoard", frame: rectOf(n) ?? rootFrame, children: [] };
      roots.push(alert);
      into = alert;
      role = "";
    } else {
      const el = n === root ? null : toNode(n);
      // A non-accessible Switch inside an accessible Switch is the same control drawn twice.
      if (el && !(el.role === keptRole && !yes(n.isAccessible))) {
        (parent.children ??= []).push(el);
        into = el;
        role = el.role;
      }
    }
    for (const c of n.children ?? []) walk(c, into, role);
  };
  walk(root, appRoot, "");
  for (const r of roots) prune(r);
  return { roots };
}

function prune(n: PhoneNode): void {
  if (!n.children) return;
  if (n.children.length === 0) {
    delete n.children;
    return;
  }
  for (const c of n.children) prune(c);
}

function unwrap(source: unknown): WdaNode {
  let s = source;
  if (typeof s === "string") {
    try {
      s = JSON.parse(s) as unknown;
    } catch {
      throw new WdaSourceError("WDA source is not JSON");
    }
  }
  const v = (s as { value?: unknown } | null)?.value ?? s;
  if (!v || typeof v !== "object" || typeof (v as WdaNode).type !== "string") throw new WdaSourceError("not a WDA JSON source (no root element)");
  return v as WdaNode;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function rectOf(n: WdaNode): PhoneNode["frame"] | undefined {
  const r = n.rect;
  if (!r || ![r.x, r.y, r.width, r.height].every((x) => typeof x === "number" && Number.isFinite(x))) return undefined;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function toNode(n: WdaNode): PhoneNode | null {
  const role = n.type ?? "";
  if (role === "Application" || role === "Window" || !role) return null;
  if (!yes(n.isVisible)) return null;
  const frame = rectOf(n);
  if (!frame || frame.width <= 0 || frame.height <= 0) return null;
  const scrollable = SCROLLER.test(role);
  if (!yes(n.isAccessible) && !scrollable && !ALWAYS_KEEP.test(role)) return null;

  const traits = n.traits ?? "";
  const rawLabel = str(n.label);
  const rawValue = str(n.value);
  const id = str(n.rawIdentifier);
  const isSwitch = role === "Switch" || role === "Toggle";

  let label: string | undefined;
  let value: string | undefined;
  if (INPUT.test(role)) {
    // A TextView is editable: its contents are a value, which navigate never sends, never a label.
    label = rawLabel !== rawValue ? rawLabel : undefined;
    value = rawValue;
  } else if (isSwitch) {
    label = rawLabel;
    value = rawValue;
  } else {
    label = rawLabel ?? rawValue;
    if (rawLabel && rawValue && rawValue !== rawLabel) value = rawValue;
  }
  const tappable = !scrollable && (TAPPABLE.test(role) || /\b(Button|Link|Keyboard Key|Toggle)\b/.test(traits));
  if (!label && !value && !id && !tappable && !scrollable && !ALWAYS_KEEP.test(role)) return null;

  const out: PhoneNode = { role, frame };
  if (label) out.label = label;
  if (value) out.value = value;
  if (id) out.id = id;
  if ((n.isEnabled !== undefined && !yes(n.isEnabled)) || /\bNotEnabled\b/.test(traits)) out.enabled = false;
  if (yes(n.isFocused)) out.focused = true;
  if (isSwitch) out.checked = rawValue === "1";
  if (role === "SecureTextField") out.secure = true;
  if (tappable) out.tappable = true;
  if (scrollable) out.scrollable = true;
  return out;
}
