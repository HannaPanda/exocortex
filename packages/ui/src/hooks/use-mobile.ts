'use client';

import * as React from 'react';

const MOBILE_BREAKPOINT = 768;

/**
 * Below this width, panels overlay the canvas instead of sharing it (see
 * `Sheet` in `../components/ui/sheet.tsx`). Undefined until the first effect
 * runs so server and client agree on the initial render; callers get `false`
 * for that one frame, then the real value.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = (): void => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    query.addEventListener('change', onChange);
    onChange();
    return () => query.removeEventListener('change', onChange);
  }, []);

  return isMobile ?? false;
}
