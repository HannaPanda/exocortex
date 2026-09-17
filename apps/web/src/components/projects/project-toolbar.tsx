'use client';

import { FileArchiveIcon, HammerIcon, PackageOpenIcon, SquareIcon, UploadIcon } from 'lucide-react';
import * as React from 'react';

import {
  type Project,
  type ProjectBibliography,
  type ProjectEngine,
  type ProjectFile,
  type UpdateProjectRequest,
} from '@exocortex/contracts';
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

/**
 * What a project is built from, and the button that builds it (issue #43).
 *
 * Its own component because everything here is one shape -- read a value off
 * the project, write it back through `PATCH /api/projects/:id` -- and because
 * the view underneath it should be about the three panes, not about five
 * dropdowns.
 */

const ENGINE_LABEL: Record<ProjectEngine, string> = {
  PDFLATEX: 'pdfLaTeX',
  XELATEX: 'XeLaTeX',
  LUALATEX: 'LuaLaTeX',
};

const BIBLIOGRAPHY_LABEL: Record<ProjectBibliography, string> = {
  AUTO: 'automatisch',
  BIBTEX: 'BibTeX',
  BIBER: 'Biber',
  NONE: 'keine',
};

interface ProjectToolbarProps {
  project: Project;
  files: readonly ProjectFile[];
  running: boolean;
  buildPending: boolean;
  archivePending: boolean;
  onUpdate: (request: UpdateProjectRequest) => void;
  onUpload: (file: File) => void;
  onImport: (file: File) => void;
  onExport: () => void;
  onBuild: () => void;
  onCancel: () => void;
}

export function ProjectToolbar({
  project,
  files,
  running,
  buildPending,
  archivePending,
  onUpdate,
  onUpload,
  onImport,
  onExport,
  onBuild,
  onCancel,
}: ProjectToolbarProps) {
  const uploadInput = React.useRef<HTMLInputElement | null>(null);
  const importInput = React.useRef<HTMLInputElement | null>(null);
  const rootCandidates = files.filter((file) => file.kind === 'TEXT' && file.path.endsWith('.tex'));

  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
      <h1 className="me-2 truncate text-sm font-medium">{project.title}</h1>

      <Label htmlFor="project-root" className="text-xs text-muted-foreground">
        Hauptdatei
      </Label>
      <Select
        value={project.rootFile}
        onValueChange={(value) => {
          if (value !== null) onUpdate({ rootFile: value });
        }}
      >
        <SelectTrigger id="project-root" size="sm" className="w-48">
          {/* The value is the path, so here it really is the label. */}
          <SelectValue>{() => project.rootFile}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {rootCandidates.map((file) => (
            <SelectItem key={file.path} value={file.path}>
              {file.path}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={project.engine}
        onValueChange={(value) => {
          if (value !== null) onUpdate({ engine: value as ProjectEngine });
        }}
      >
        <SelectTrigger size="sm" className="w-32" aria-label="Engine">
          <SelectValue>{() => ENGINE_LABEL[project.engine]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {Object.entries(ENGINE_LABEL).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={project.bibliography}
        onValueChange={(value) => {
          if (value !== null) onUpdate({ bibliography: value as ProjectBibliography });
        }}
      >
        <SelectTrigger size="sm" className="w-36" aria-label="Literaturverzeichnis">
          <SelectValue>{() => BIBLIOGRAPHY_LABEL[project.bibliography]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {Object.entries(BIBLIOGRAPHY_LABEL).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="ms-auto flex items-center gap-2">
        <input
          ref={uploadInput}
          type="file"
          className="hidden"
          data-testid="project-upload"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file !== undefined) onUpload(file);
          }}
        />
        <Button variant="ghost" size="sm" onClick={() => uploadInput.current?.click()}>
          <UploadIcon className="size-4" /> Datei hochladen
        </Button>

        <input
          ref={importInput}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          data-testid="project-import"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file !== undefined) onImport(file);
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={archivePending}
          onClick={() => importInput.current?.click()}
        >
          <PackageOpenIcon className="size-4" /> ZIP importieren
        </Button>

        <Button
          variant="ghost"
          size="sm"
          disabled={archivePending}
          data-testid="project-export"
          onClick={onExport}
        >
          <FileArchiveIcon className="size-4" /> Als ZIP
        </Button>

        {running ? (
          <Button variant="outline" size="sm" onClick={onCancel}>
            <SquareIcon className="size-4" /> Abbrechen
          </Button>
        ) : (
          <Button size="sm" data-testid="project-build" disabled={buildPending} onClick={onBuild}>
            <HammerIcon className="size-4" /> Bauen
          </Button>
        )}
      </div>
    </header>
  );
}
