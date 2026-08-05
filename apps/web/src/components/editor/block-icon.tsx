'use client';

import {
  AtSignIcon,
  AudioLinesIcon,
  BookmarkIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CodeIcon,
  Columns2Icon,
  FileTextIcon,
  GlobeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ImageIcon,
  InfoIcon,
  LayoutGridIcon,
  LightbulbIcon,
  Link2Icon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  ListTodoIcon,
  ListTreeIcon,
  MinusIcon,
  OctagonAlertIcon,
  PaperclipIcon,
  QuoteIcon,
  SigmaIcon,
  SmileIcon,
  TableIcon,
  TriangleAlertIcon,
  TypeIcon,
  VideoIcon,
} from 'lucide-react';
import * as React from 'react';

import { type BlockIconName } from '@exocortex/editor';

/**
 * Resolves the icon *name* a block catalog entry carries into a component.
 *
 * The catalog lives in `packages/editor`, which must stay renderer-free so the
 * worker and the API can use it headlessly. That is why entries name their icon
 * instead of importing one, and why this mapping lives here.
 */
const BLOCK_ICONS: Readonly<Record<BlockIconName, React.ComponentType<{ className?: string }>>> = {
  Type: TypeIcon,
  Heading1: Heading1Icon,
  Heading2: Heading2Icon,
  Heading3: Heading3Icon,
  List: ListIcon,
  ListOrdered: ListOrderedIcon,
  ListChecks: ListChecksIcon,
  ListTree: ListTreeIcon,
  Quote: QuoteIcon,
  Code: CodeIcon,
  Minus: MinusIcon,
  Table: TableIcon,
  Image: ImageIcon,
  Paperclip: PaperclipIcon,
  Video: VideoIcon,
  AudioLines: AudioLinesIcon,
  FileText: FileTextIcon,
  Bookmark: BookmarkIcon,
  Globe: GlobeIcon,
  Info: InfoIcon,
  Lightbulb: LightbulbIcon,
  CircleCheck: CircleCheckIcon,
  TriangleAlert: TriangleAlertIcon,
  OctagonAlert: OctagonAlertIcon,
  ChevronRight: ChevronRightIcon,
  Columns2: Columns2Icon,
  Sigma: SigmaIcon,
  ListTodo: ListTodoIcon,
  Link2: Link2Icon,
  AtSign: AtSignIcon,
  Smile: SmileIcon,
  LayoutGrid: LayoutGridIcon,
};

export function BlockIcon({ name, className }: { name: BlockIconName; className?: string }) {
  const Icon = BLOCK_ICONS[name];
  return <Icon className={className} />;
}
