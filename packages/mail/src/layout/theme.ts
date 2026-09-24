/**
 * The look of every mail, in one place (issue #109).
 *
 * A mail cannot read `packages/ui/src/tokens.css`: most clients drop a
 * `<style>` block or a custom property, so every value below ends up inlined
 * into a `style` attribute. That is why the mail has its own small token layer
 * instead of borrowing the product's -- and why it is the one file in this
 * package that writes a colour as a value.
 *
 * The names are roles, not colours, so the corporate design can move without
 * a template noticing. What the values are today is a starting point derived
 * from the three brand colours in `tokens.css` (slate, amber, light), laid out
 * on a light sheet because a mail is read inside somebody else's interface and
 * most of them are light. Nothing here is a decision about the future CD; it
 * is the one place that decision will be written down when it is made.
 */
export interface MailTheme {
  /** Behind the sheet: the part of the window around the mail. */
  canvas: string;
  /** The sheet the text sits on. */
  sheet: string;
  /** The band at the top carrying the wordmark. */
  header: string;
  /** The wordmark on the header band. */
  headerText: string;
  /** The one letter of the wordmark that carries the signal colour. */
  headerSignal: string;
  /** Body text. */
  text: string;
  /** Secondary text: the footer, labels, counts. */
  mutedText: string;
  /** Inline links and the secondary action. */
  link: string;
  /** The primary action's fill. */
  actionFill: string;
  /** Text on the primary action. */
  actionText: string;
  /** Hairlines between sections. */
  rule: string;
  /** Behind an info block and a quoted excerpt. */
  panel: string;
  /** The stripe at the left edge of an info block. */
  panelAccent: string;
  fontFamily: string;
  monoFontFamily: string;
  /** The widest the sheet grows, in pixels. 600 is what every client renders. */
  maxWidth: number;
  /** The sheet's corners, in pixels. Clients that ignore it get square ones. */
  radius: number;
}

export const mailTheme: MailTheme = {
  canvas: '#EEF0F2',
  sheet: '#FFFFFF',
  header: '#344955',
  headerText: '#E7E9EB',
  headerSignal: '#F9AA33',
  text: '#1F2C33',
  mutedText: '#5A6B75',
  link: '#2B5F7A',
  actionFill: '#F9AA33',
  actionText: '#1F2C33',
  rule: '#DDE1E4',
  panel: '#F4F6F7',
  panelAccent: '#F9AA33',
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  monoFontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  maxWidth: 600,
  radius: 8,
};
