/**
 * An example at a real phone width. The product's components switch at the
 * window's breakpoints, not the box's, so a 390 px box on a desktop would show
 * the desktop layout squeezed. An iframe has a window of its own; the page in
 * it is `/design-system/rahmen/<probe>` and shows the probe and nothing else.
 * That path is the one with `frame-src 'self'` in the Content-Security-Policy.
 */
export function DsNarrowFrame({
  probe,
  title,
  height = 560,
}: {
  probe: string;
  title: string;
  height?: number;
}) {
  return (
    <iframe
      src={`/design-system/rahmen/${probe}`}
      title={title}
      loading="lazy"
      data-testid={`ds-frame-${probe}`}
      className="w-[390px] max-w-full rounded-md border border-border bg-background"
      style={{ height }}
    />
  );
}
