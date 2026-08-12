'use client';

import {
  ArchiveIcon,
  BellIcon,
  BookmarkIcon,
  BookOpenIcon,
  BrainIcon,
  BriefcaseIcon,
  BugIcon,
  CalendarIcon,
  CarIcon,
  ChartBarIcon,
  ChartLineIcon,
  CircleCheckIcon,
  ClipboardListIcon,
  ClockIcon,
  CodeIcon,
  CoffeeIcon,
  CompassIcon,
  CpuIcon,
  DatabaseIcon,
  DumbbellIcon,
  FilesIcon,
  FileTextIcon,
  FlagIcon,
  FlameIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  GiftIcon,
  GitBranchIcon,
  GlobeIcon,
  GraduationCapIcon,
  HeartIcon,
  HouseIcon,
  InboxIcon,
  KeyIcon,
  LeafIcon,
  LightbulbIcon,
  ListChecksIcon,
  LockIcon,
  MailIcon,
  MapIcon,
  MapPinIcon,
  MessageCircleIcon,
  MicroscopeIcon,
  MoonIcon,
  MountainIcon,
  NetworkIcon,
  NewspaperIcon,
  NotebookPenIcon,
  PackageIcon,
  PaletteIcon,
  PaperclipIcon,
  PenToolIcon,
  PinIcon,
  PlaneIcon,
  ServerIcon,
  SettingsIcon,
  ShieldIcon,
  SparklesIcon,
  StarIcon,
  StickyNoteIcon,
  SunIcon,
  TableIcon,
  TargetIcon,
  TerminalIcon,
  TimerIcon,
  TrendingUpIcon,
  TriangleAlertIcon,
  TrophyIcon,
  UsersIcon,
  UtensilsIcon,
  WrenchIcon,
  ZapIcon,
} from 'lucide-react';
import { Icon as LucideIcon } from 'lucide-react';
import * as React from 'react';

import {
  type CuratedDocumentIconName,
  DOCUMENT_ICON_NAME_PREFIX,
  type DocumentIconColor,
  type DocumentIconName,
  type DocumentType,
} from '@exocortex/contracts';
import { cn } from '@exocortex/ui';

import { useLucideIconData } from './lucide-icon-store';

/**
 * The one place a page icon turns into pixels.
 *
 * `Document.icon` holds either a literal character (an emoji) or
 * `lucide:<name>`. Every surface that shows a page — tree, breadcrumb, search,
 * overview — renders through here, so a page looks the same wherever it appears
 * and a new kind of icon has exactly one place to be taught.
 *
 * The name-to-component map lives in `apps/web` and not in the contract for the
 * same reason the block catalog's does: the contract must stay renderer-free so
 * the worker and the API can read it headlessly.
 *
 * The map covers the curated names only. Any of Lucide's 1,756 icons can be
 * stored, and the rest are drawn from the path data in `lucide-icon-store`, which
 * loads on demand. Curated ones stay static imports because they are the ones a
 * freshly loaded page tree is likely to be full of, and those must not blink.
 */
const ICON_COMPONENTS: Readonly<
  Record<CuratedDocumentIconName, React.ComponentType<{ className?: string }>>
> = {
  'file-text': FileTextIcon,
  files: FilesIcon,
  folder: FolderIcon,
  'folder-open': FolderOpenIcon,
  'folder-tree': FolderTreeIcon,
  'book-open': BookOpenIcon,
  'notebook-pen': NotebookPenIcon,
  'sticky-note': StickyNoteIcon,
  bookmark: BookmarkIcon,
  archive: ArchiveIcon,
  inbox: InboxIcon,
  paperclip: PaperclipIcon,
  star: StarIcon,
  heart: HeartIcon,
  flag: FlagIcon,
  pin: PinIcon,
  sparkles: SparklesIcon,
  flame: FlameIcon,
  zap: ZapIcon,
  target: TargetIcon,
  trophy: TrophyIcon,
  bell: BellIcon,
  'circle-check': CircleCheckIcon,
  'triangle-alert': TriangleAlertIcon,
  briefcase: BriefcaseIcon,
  calendar: CalendarIcon,
  clock: ClockIcon,
  timer: TimerIcon,
  'list-checks': ListChecksIcon,
  'clipboard-list': ClipboardListIcon,
  'chart-bar': ChartBarIcon,
  'chart-line': ChartLineIcon,
  'trending-up': TrendingUpIcon,
  users: UsersIcon,
  mail: MailIcon,
  'message-circle': MessageCircleIcon,
  code: CodeIcon,
  terminal: TerminalIcon,
  database: DatabaseIcon,
  server: ServerIcon,
  cpu: CpuIcon,
  'git-branch': GitBranchIcon,
  bug: BugIcon,
  wrench: WrenchIcon,
  settings: SettingsIcon,
  lock: LockIcon,
  key: KeyIcon,
  shield: ShieldIcon,
  network: NetworkIcon,
  package: PackageIcon,
  brain: BrainIcon,
  lightbulb: LightbulbIcon,
  'graduation-cap': GraduationCapIcon,
  microscope: MicroscopeIcon,
  palette: PaletteIcon,
  'pen-tool': PenToolIcon,
  globe: GlobeIcon,
  map: MapIcon,
  compass: CompassIcon,
  newspaper: NewspaperIcon,
  house: HouseIcon,
  'map-pin': MapPinIcon,
  plane: PlaneIcon,
  car: CarIcon,
  coffee: CoffeeIcon,
  utensils: UtensilsIcon,
  dumbbell: DumbbellIcon,
  leaf: LeafIcon,
  mountain: MountainIcon,
  sun: SunIcon,
  moon: MoonIcon,
  gift: GiftIcon,
};

/**
 * German name of every icon, used as its accessible label and as what the search
 * field matches. A picker whose entries are unnamed pictures cannot be searched
 * and cannot be read out.
 */
export const DOCUMENT_ICON_LABELS: Readonly<Record<CuratedDocumentIconName, string>> = {
  'file-text': 'Seite',
  files: 'Mehrere Seiten',
  folder: 'Ordner',
  'folder-open': 'Offener Ordner',
  'folder-tree': 'Ordnerbaum',
  'book-open': 'Buch',
  'notebook-pen': 'Notizbuch',
  'sticky-note': 'Notizzettel',
  bookmark: 'Lesezeichen',
  archive: 'Archiv',
  inbox: 'Eingang',
  paperclip: 'Anhang',
  star: 'Stern',
  heart: 'Herz',
  flag: 'Fahne',
  pin: 'Pinnadel',
  sparkles: 'Funkeln',
  flame: 'Flamme',
  zap: 'Blitz',
  target: 'Ziel',
  trophy: 'Pokal',
  bell: 'Glocke',
  'circle-check': 'Haken',
  'triangle-alert': 'Warnung',
  briefcase: 'Aktentasche',
  calendar: 'Kalender',
  clock: 'Uhr',
  timer: 'Timer',
  'list-checks': 'Aufgabenliste',
  'clipboard-list': 'Klemmbrett',
  'chart-bar': 'Balkendiagramm',
  'chart-line': 'Liniendiagramm',
  'trending-up': 'Wachstum',
  users: 'Menschen',
  mail: 'Post',
  'message-circle': 'Nachricht',
  code: 'Quelltext',
  terminal: 'Terminal',
  database: 'Datenbank',
  server: 'Server',
  cpu: 'Prozessor',
  'git-branch': 'Git-Branch',
  bug: 'Fehler',
  wrench: 'Schraubenschlüssel',
  settings: 'Einstellungen',
  lock: 'Schloss',
  key: 'Schlüssel',
  shield: 'Schild',
  network: 'Netzwerk',
  package: 'Paket',
  brain: 'Gehirn',
  lightbulb: 'Idee',
  'graduation-cap': 'Studium',
  microscope: 'Mikroskop',
  palette: 'Farbpalette',
  'pen-tool': 'Zeichenstift',
  globe: 'Globus',
  map: 'Landkarte',
  compass: 'Kompass',
  newspaper: 'Zeitung',
  house: 'Haus',
  'map-pin': 'Ort',
  plane: 'Flugzeug',
  car: 'Auto',
  coffee: 'Kaffee',
  utensils: 'Essen',
  dumbbell: 'Sport',
  leaf: 'Blatt',
  mountain: 'Berg',
  sun: 'Sonne',
  moon: 'Mond',
  gift: 'Geschenk',
};

/**
 * Extra search words per icon, for the times the label is not what someone
 * types. Only where it earns its keep; most icons are found by their name.
 */
export const DOCUMENT_ICON_KEYWORDS: Partial<
  Readonly<Record<CuratedDocumentIconName, readonly string[]>>
> =
  {
    'file-text': ['dokument', 'datei'],
    folder: ['projekt', 'sammlung'],
    'book-open': ['lesen', 'wissen'],
    'notebook-pen': ['notiz', 'schreiben', 'tagebuch'],
    bookmark: ['merken', 'gespeichert'],
    star: ['favorit', 'wichtig'],
    heart: ['liebe', 'lieblings'],
    flame: ['dringend', 'heiß'],
    zap: ['schnell', 'energie', 'strom'],
    target: ['fokus', 'okr'],
    'circle-check': ['fertig', 'erledigt', 'ok'],
    'triangle-alert': ['achtung', 'risiko'],
    briefcase: ['arbeit', 'job', 'beruf'],
    calendar: ['termin', 'datum', 'planung'],
    'list-checks': ['todo', 'aufgaben', 'checkliste'],
    'chart-bar': ['statistik', 'auswertung', 'zahlen'],
    'trending-up': ['metrik', 'kpi', 'umsatz'],
    users: ['team', 'personen', 'kontakte'],
    mail: ['e-mail', 'brief', 'nachricht'],
    code: ['programmieren', 'entwicklung', 'software'],
    terminal: ['konsole', 'shell', 'cli'],
    database: ['daten', 'sql', 'db'],
    server: ['hosting', 'infrastruktur', 'deploy'],
    'git-branch': ['version', 'repository', 'merge'],
    bug: ['fehler', 'issue', 'problem'],
    wrench: ['werkzeug', 'wartung', 'reparatur'],
    settings: ['konfiguration', 'zahnrad', 'setup'],
    lock: ['sicherheit', 'privat', 'passwort'],
    key: ['zugang', 'token', 'secret'],
    shield: ['schutz', 'sicherheit', 'backup'],
    package: ['paket', 'abhängigkeit', 'release'],
    brain: ['denken', 'second brain', 'gedächtnis'],
    lightbulb: ['idee', 'einfall', 'tipp'],
    'graduation-cap': ['lernen', 'kurs', 'ausbildung'],
    microscope: ['forschung', 'analyse'],
    palette: ['design', 'farben', 'kreativ'],
    'pen-tool': ['design', 'zeichnen', 'entwurf'],
    globe: ['welt', 'web', 'internet'],
    map: ['karte', 'reise', 'übersicht'],
    house: ['zuhause', 'wohnung', 'start'],
    'map-pin': ['adresse', 'standort'],
    plane: ['reise', 'urlaub', 'flug'],
    coffee: ['pause', 'café'],
    utensils: ['kochen', 'rezept', 'restaurant'],
    dumbbell: ['fitness', 'training', 'gesundheit'],
    leaf: ['natur', 'garten', 'pflanze'],
    sun: ['wetter', 'sommer', 'tag'],
    moon: ['nacht', 'schlaf'],
    gift: ['geburtstag', 'geschenk', 'weihnachten'],
  };

/** The icon grid, grouped the way the emoji picker is. */
export const DOCUMENT_ICON_GROUPS: readonly {
  label: string;
  names: readonly CuratedDocumentIconName[];
}[] = [
  {
    label: 'Ablage',
    names: [
      'file-text',
      'files',
      'folder',
      'folder-open',
      'folder-tree',
      'book-open',
      'notebook-pen',
      'sticky-note',
      'bookmark',
      'archive',
      'inbox',
      'paperclip',
    ],
  },
  {
    label: 'Markierung',
    names: [
      'star',
      'heart',
      'flag',
      'pin',
      'sparkles',
      'flame',
      'zap',
      'target',
      'trophy',
      'bell',
      'circle-check',
      'triangle-alert',
    ],
  },
  {
    label: 'Arbeit',
    names: [
      'briefcase',
      'calendar',
      'clock',
      'timer',
      'list-checks',
      'clipboard-list',
      'chart-bar',
      'chart-line',
      'trending-up',
      'users',
      'mail',
      'message-circle',
    ],
  },
  {
    label: 'Technik',
    names: [
      'code',
      'terminal',
      'database',
      'server',
      'cpu',
      'git-branch',
      'bug',
      'wrench',
      'settings',
      'lock',
      'key',
      'shield',
      'network',
      'package',
    ],
  },
  {
    label: 'Wissen',
    names: [
      'brain',
      'lightbulb',
      'graduation-cap',
      'microscope',
      'palette',
      'pen-tool',
      'globe',
      'map',
      'compass',
      'newspaper',
    ],
  },
  {
    label: 'Leben',
    names: [
      'house',
      'map-pin',
      'plane',
      'car',
      'coffee',
      'utensils',
      'dumbbell',
      'leaf',
      'mountain',
      'sun',
      'moon',
      'gift',
    ],
  },
];

/**
 * Tailwind class per colour name.
 *
 * Written out rather than interpolated because Tailwind only emits classes it can
 * see in the source; `text-content-${name}` would produce no CSS at all. Same
 * tokens as the editor's text colours, so the two palettes cannot drift.
 */
export const DOCUMENT_ICON_COLOR_CLASS: Readonly<Record<DocumentIconColor, string>> = {
  gray: 'text-content-gray',
  brown: 'text-content-brown',
  orange: 'text-content-orange',
  yellow: 'text-content-yellow',
  green: 'text-content-green',
  blue: 'text-content-blue',
  purple: 'text-content-purple',
  pink: 'text-content-pink',
  red: 'text-content-red',
};

export const DOCUMENT_ICON_COLOR_LABELS: Readonly<Record<DocumentIconColor, string>> = {
  gray: 'Grau',
  brown: 'Braun',
  orange: 'Orange',
  yellow: 'Gelb',
  green: 'Grün',
  blue: 'Blau',
  purple: 'Violett',
  pink: 'Pink',
  red: 'Rot',
};

/** The name behind a `lucide:` icon, or `null` for an emoji or no icon at all. */
export function documentIconName(icon: string | null): DocumentIconName | null {
  if (icon === null || !icon.startsWith(DOCUMENT_ICON_NAME_PREFIX)) return null;
  const name = icon.slice(DOCUMENT_ICON_NAME_PREFIX.length);
  return name.length === 0 ? null : name;
}

/** Builds the stored value for a picked icon name. */
export function documentIconValue(name: DocumentIconName): string {
  return `${DOCUMENT_ICON_NAME_PREFIX}${name}`;
}

/**
 * What to call an icon out loud.
 *
 * The curated ones have a German name. The other 1,700 have only Lucide's
 * English one, which is at least a real word and beats reading out
 * `square-dashed-bottom-code`: it becomes "Square dashed bottom code". A made-up
 * German translation would be worse than the honest English label, because it is
 * not what the search field matches either.
 */
export function documentIconLabel(name: DocumentIconName): string {
  const curated = (DOCUMENT_ICON_LABELS as Readonly<Record<string, string | undefined>>)[name];
  if (curated !== undefined) return curated;
  const words = name.replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Draws one of the icons that is not in the static map.
 *
 * Its own component so that the subscription to the loaded path data exists only
 * for the rows that actually need it — a tree full of curated icons subscribes
 * nothing at all.
 */
function LazyDrawnIcon({ name, className }: { name: string; className?: string }) {
  const data = useLucideIconData();
  const node = data?.nodes[data.aliases[name] ?? name];
  if (node === undefined) return null;
  return <LucideIcon iconNode={node} className={className} />;
}

export interface DocumentIconProps {
  icon: string | null;
  iconColor: DocumentIconColor | null;
  /** Decides the default icon when none is set: a table for a database. */
  type: DocumentType;
  /**
   * Sizes the box and, through `1em`, the glyph inside it. Also carries the
   * fallback colour, which `iconColor` overrides when one is set.
   */
  className?: string;
}

/**
 * A page's icon at its call site.
 *
 * An emoji is text and brings its own colours, so the colour only reaches a
 * drawn icon. The default icon is drawn too and therefore takes the colour as
 * well: otherwise picking a colour and then removing the symbol would silently
 * throw the colour away.
 *
 * Decorative by default: every surface that shows this icon shows the page title
 * right next to it, so a screen reader announcing the icon would only repeat
 * what the label already says.
 */
export function DocumentIcon({ icon, iconColor, type, className }: DocumentIconProps) {
  const name = documentIconName(icon);
  const isEmoji = icon !== null && name === null;
  const Curated =
    name === null
      ? null
      : ((ICON_COMPONENTS as Readonly<Record<string, React.ComponentType<{ className?: string }>>>)[
          name
        ] ?? null);
  const Fallback = type === 'COLLECTION' ? TableIcon : FileTextIcon;

  return (
    <span
      aria-hidden
      data-icon={icon ?? 'default'}
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center text-sm leading-none',
        // The caller's classes come first so a surface can resize the box, and
        // the picked colour last so it beats the fallback colour they pass.
        className,
        !isEmoji && iconColor !== null && DOCUMENT_ICON_COLOR_CLASS[iconColor],
      )}
    >
      {isEmoji ? (
        icon
      ) : name === null ? (
        <Fallback className="size-[1em]" />
      ) : Curated !== null ? (
        <Curated className="size-[1em]" />
      ) : (
        <LazyDrawnIcon name={name} className="size-[1em]" />
      )}
    </span>
  );
}
