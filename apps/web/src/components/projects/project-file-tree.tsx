'use client';

import { FileIcon, FileTextIcon, FolderIcon, ImageIcon, PlusIcon, TrashIcon } from 'lucide-react';
import * as React from 'react';

import { type ProjectFile } from '@exocortex/contracts';
import { Button, cn } from '@exocortex/ui';

/**
 * The file tree of a project (issue #43, ADR-027).
 *
 * Built from the paths, not from a stored tree: directories are not rows in the
 * domain, so they are not nodes here either -- they are the prefixes the paths
 * share, computed on render. That is what makes an empty directory impossible
 * and a directory rename a single move.
 */

interface TreeNode {
  name: string;
  path: string;
  file: ProjectFile | null;
  children: TreeNode[];
}

/** Groups the flat path list into the folders it implies. */
function buildTree(files: readonly ProjectFile[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', file: null, children: [] };

  for (const file of files) {
    const segments = file.path.split('/');
    let node = root;
    segments.forEach((segment, index) => {
      const path = segments.slice(0, index + 1).join('/');
      const leaf = index === segments.length - 1;
      let child = node.children.find((candidate) => candidate.name === segment);
      if (child === undefined) {
        child = { name: segment, path, file: null, children: [] };
        node.children.push(child);
      }
      if (leaf) child.file = file;
      node = child;
    });
  }

  const sort = (nodes: TreeNode[]): void => {
    // Folders first, then files, each alphabetically: the order a person
    // scanning for a chapter expects, and stable between renders.
    nodes.sort((a, b) => {
      const aFolder = a.file === null;
      const bFolder = b.file === null;
      if (aFolder !== bFolder) return aFolder ? -1 : 1;
      return a.name.localeCompare(b.name, 'de');
    });
    for (const node of nodes) sort(node.children);
  };
  sort(root.children);
  return root.children;
}

function iconFor(file: ProjectFile | null): React.ReactNode {
  if (file === null) return <FolderIcon className="size-3.5 shrink-0 opacity-70" />;
  if (file.kind === 'ASSET') {
    const image = file.mimeType?.startsWith('image/') === true;
    return image ? (
      <ImageIcon className="size-3.5 shrink-0 opacity-70" />
    ) : (
      <FileIcon className="size-3.5 shrink-0 opacity-70" />
    );
  }
  return <FileTextIcon className="size-3.5 shrink-0 opacity-70" />;
}

interface ProjectFileTreeProps {
  files: readonly ProjectFile[];
  rootFile: string;
  selectedPath: string | null;
  readOnly: boolean;
  onSelect: (file: ProjectFile) => void;
  onDelete: (file: ProjectFile) => void;
  onCreate: () => void;
}

export function ProjectFileTree({
  files,
  rootFile,
  selectedPath,
  readOnly,
  onSelect,
  onDelete,
  onCreate,
}: ProjectFileTreeProps) {
  const tree = React.useMemo(() => buildTree(files), [files]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">Dateien</span>
        {readOnly ? null : (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onCreate}
            aria-label="Datei anlegen"
            data-testid="project-file-create"
          >
            <PlusIcon className="size-4" />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {tree.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">Noch keine Dateien.</p>
        ) : (
          <TreeLevel
            nodes={tree}
            depth={0}
            rootFile={rootFile}
            selectedPath={selectedPath}
            readOnly={readOnly}
            onSelect={onSelect}
            onDelete={onDelete}
          />
        )}
      </div>
    </div>
  );
}

function TreeLevel({
  nodes,
  depth,
  rootFile,
  selectedPath,
  readOnly,
  onSelect,
  onDelete,
}: {
  nodes: readonly TreeNode[];
  depth: number;
  rootFile: string;
  selectedPath: string | null;
  readOnly: boolean;
  onSelect: (file: ProjectFile) => void;
  onDelete: (file: ProjectFile) => void;
}) {
  return (
    <ul className="space-y-px">
      {nodes.map((node) => (
        <li key={node.path}>
          <div
            className={cn(
              'group flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs',
              node.file === null ? 'text-muted-foreground' : 'cursor-pointer hover:bg-accent',
              selectedPath === node.path && 'bg-accent font-medium',
            )}
            style={{ paddingInlineStart: `${String(0.5 + depth * 0.75)}rem` }}
            onClick={node.file === null ? undefined : () => onSelect(node.file as ProjectFile)}
            role={node.file === null ? undefined : 'button'}
            tabIndex={node.file === null ? undefined : 0}
            onKeyDown={
              node.file === null
                ? undefined
                : (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(node.file as ProjectFile);
                    }
                  }
            }
          >
            {iconFor(node.file)}
            <span className="truncate">{node.name}</span>
            {node.path === rootFile ? (
              <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] text-muted-foreground">
                Haupt
              </span>
            ) : null}
            {node.file !== null && !readOnly ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="ms-auto opacity-0 group-hover:opacity-100"
                aria-label={`${node.name} entfernen`}
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(node.file as ProjectFile);
                }}
              >
                <TrashIcon className="size-3.5" />
              </Button>
            ) : null}
          </div>
          {node.children.length > 0 ? (
            <TreeLevel
              nodes={node.children}
              depth={depth + 1}
              rootFile={rootFile}
              selectedPath={selectedPath}
              readOnly={readOnly}
              onSelect={onSelect}
              onDelete={onDelete}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
