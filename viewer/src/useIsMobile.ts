import { useEffect, useState } from "react";

const MOBILE_QUERY = "(max-width: 700px)";

/** Phone-sized viewports get the one-device-at-a-time layout instead of side-by-side. */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}
