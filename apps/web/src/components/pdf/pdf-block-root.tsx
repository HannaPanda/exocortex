'use client';

import { type AbstractIntlMessages, type Locale, NextIntlClientProvider } from 'next-intl';

import { PdfView } from '@/components/pdf/pdf-view';

/** What a separate React root needs to speak the reader's language. */
export interface ReaderIntl {
  locale: Locale;
  messages: AbstractIntlMessages;
  timeZone: string | undefined;
}

/**
 * The PDF viewer as a page block mounts it: in a React root of its own,
 * outside every provider of the page (`attachment-info.ts`). It reads its
 * labels through `useTranslations` since issue #98, so the language is handed
 * in and provided again here; without it the viewer threw on its first render
 * and the block stayed empty.
 */
export function PdfBlockRoot({ url, intl }: { url: string; intl: ReaderIntl }) {
  return (
    <NextIntlClientProvider locale={intl.locale} messages={intl.messages} timeZone={intl.timeZone}>
      <PdfView url={url} />
    </NextIntlClientProvider>
  );
}
