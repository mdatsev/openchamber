import type {
  GitWorktreeComparison,
  GitWorktreeComparisonLayerKind,
} from '@/lib/api/types';

type WorktreeComparisonEntry = {
  comparisonKey: string;
  layer: GitWorktreeComparisonLayerKind;
  path: string;
  index: string;
  working_dir: string;
  insertions: number;
  deletions: number;
  isNew: boolean;
  patch: string | null;
  readOnly: true;
};

type WorktreeComparisonGroup = {
  kind: GitWorktreeComparisonLayerKind;
  entries: WorktreeComparisonEntry[];
};

const statusToGitCode = (status: 'added' | 'deleted' | 'modified'): string => {
  if (status === 'added') return 'A';
  if (status === 'deleted') return 'D';
  return 'M';
};

const hasRenderablePatch = (patch: string): boolean => {
  if (!patch.trim()) return false;
  return /^diff --git /m.test(patch)
    || /^@@ /m.test(patch)
    || /^Binary files .+ differ$/m.test(patch)
    || /^GIT binary patch$/m.test(patch);
};

export const mapWorktreeComparisonGroups = (
  comparison: GitWorktreeComparison | null,
): WorktreeComparisonGroup[] => {
  if (!comparison?.available) return [];
  return comparison.layers
    .map((layer) => ({
      kind: layer.kind,
      entries: (layer.files ?? [])
        .filter((file) => Boolean(file.path.trim()))
        .map((file) => ({
          comparisonKey: `${layer.kind}:${file.path}`,
          layer: layer.kind,
          path: file.path,
          index: layer.kind === 'staged' ? statusToGitCode(file.status) : '',
          working_dir: layer.kind === 'staged' ? '' : statusToGitCode(file.status),
          insertions: file.additions,
          deletions: file.deletions,
          isNew: file.status === 'added',
          patch: hasRenderablePatch(file.patch) ? file.patch : null,
          readOnly: true as const,
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    }))
    .filter((group) => group.entries.length > 0);
};
