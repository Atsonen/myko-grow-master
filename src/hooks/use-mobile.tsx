import * as React from "react";

const MOBILE_BREAKPOINT = 768;
/** Touch-first devices (phones in landscape, large phones, small tablets) up to this width also get the mobile UI. */
const TOUCH_COMPACT_MAX = 1100;

function compact() {
  const w = window.innerWidth;
  if (w < MOBILE_BREAKPOINT) return true;
  const coarse = window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(any-pointer: fine)").matches;
  return coarse && w < TOUCH_COMPACT_MAX;
}

/** True for phone-sized or touch-compact viewports: off-canvas sidebar (closed by default), stacked dashboard. */
export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const onChange = () => setIsMobile(compact());
    const mqls = [
      window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`),
      window.matchMedia(`(max-width: ${TOUCH_COMPACT_MAX - 1}px)`),
      window.matchMedia("(pointer: coarse)"),
    ];
    mqls.forEach((m) => m.addEventListener("change", onChange));
    window.addEventListener("orientationchange", onChange);
    onChange();
    return () => {
      mqls.forEach((m) => m.removeEventListener("change", onChange));
      window.removeEventListener("orientationchange", onChange);
    };
  }, []);

  return !!isMobile;
}
