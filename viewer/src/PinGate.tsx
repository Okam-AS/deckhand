import { useCallback, useEffect, useRef, useState } from "react";
import { verifyPin } from "./api.ts";
import { BackspaceIcon } from "./icons.tsx";

interface Props {
  shareId: string;
  pinLength: number;
  onUnlocked: () => void;
}

/**
 * The numeric PIN pad shown before a protected preview. No submit button — it
 * auto-verifies the moment the last digit lands; a wrong code shakes the dots
 * and clears. Numeric only; the physical keyboard works too on desktop.
 */
export function PinGate({ shareId, pinLength, onUnlocked }: Props) {
  const len = Math.min(6, Math.max(4, pinLength || 4));
  const [entered, setEntered] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(0);
  const busy = useRef(false);

  const fail = useCallback((text: string) => {
    setMsg(text);
    setShake(true);
    setEntered("");
    if (navigator.vibrate) navigator.vibrate(60);
    setTimeout(() => setShake(false), 420);
  }, []);

  const submit = useCallback(
    async (pin: string) => {
      busy.current = true;
      const r = await verifyPin(shareId, pin);
      busy.current = false;
      if (r.ok) {
        onUnlocked();
      } else if (r.lockedMs > 0) {
        setLockedUntil(Date.now() + r.lockedMs);
        fail(`Too many attempts — wait ${Math.ceil(r.lockedMs / 1000)}s`);
      } else {
        fail("Wrong PIN");
      }
    },
    [shareId, onUnlocked, fail],
  );

  const press = useCallback(
    (d: string) => {
      if (busy.current || Date.now() < lockedUntil) return;
      setMsg(null);
      setEntered((prev) => {
        if (prev.length >= len) return prev;
        const next = prev + d;
        if (next.length === len) void submit(next);
        return next;
      });
    },
    [len, lockedUntil, submit],
  );

  const back = useCallback(() => {
    if (busy.current) return;
    setEntered((p) => p.slice(0, -1));
  }, []);

  // Physical keyboard (desktop): digits type, Backspace deletes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key >= "0" && e.key <= "9") press(e.key);
      else if (e.key === "Backspace") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, back]);

  // Count the lockout down in the message, then clear it.
  useEffect(() => {
    if (!lockedUntil) return;
    const t = setInterval(() => {
      const left = lockedUntil - Date.now();
      if (left <= 0) {
        setLockedUntil(0);
        setMsg(null);
      } else {
        setMsg(`Too many attempts — wait ${Math.ceil(left / 1000)}s`);
      }
    }, 500);
    return () => clearInterval(t);
  }, [lockedUntil]);

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"];
  return (
    <main className="centered">
      <div className="pinpad">
        <p className="pin-title">Enter PIN to view</p>
        <div className={`pin-dots ${shake ? "err" : ""}`}>
          {Array.from({ length: len }).map((_, i) => (
            <span key={i} className={`pin-dot ${i < entered.length ? "on" : ""}`} />
          ))}
        </div>
        <div className="pin-keys">
          {keys.map((k, i) =>
            k === "" ? (
              <span key={i} className="pin-key pin-key--blank" aria-hidden />
            ) : k === "back" ? (
              <button key={i} type="button" className="pin-key" onClick={back} aria-label="Delete last digit">
                <BackspaceIcon size={22} />
              </button>
            ) : (
              <button key={i} type="button" className="pin-key" onClick={() => press(k)} aria-label={`Digit ${k}`}>
                {k}
              </button>
            ),
          )}
        </div>
        <p className={`pin-msg ${msg ? "show" : ""}`}>{msg ?? ""}</p>
      </div>
    </main>
  );
}
