import type { GitWorktreeComparison } from '@/lib/api/types';

type WorktreeComparisonEntry = {
  path: string;
  index: string;
  working_dir: string;
  insertions: number;
  deletions: number;
  isNew: boolean;
  patch: string | null;
  readOnly: true;
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

export const mapWorktreeComparisonEntries = (
  comparison: GitWorktreeComparison | null,
): WorktreeComparisonEntry[] => {
  if (!comparison?.available || !comparison.files) return [];
  return comparison.files
    .filter((file) => Boolean(file.path.trim()))
    .map((file) => ({
      path: file.path,
      index: '',
      working_dir: statusToGitCode(file.status),
      insertions: file.additions,
      deletions: file.deletions,
      isNew: file.status === 'added',
      patch: hasRenderablePatch(file.patch) ? file.patch : null,
      readOnly: true as const,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
};

export const getWorktreeComparisonDiffStats = (
  entries: readonly WorktreeComparisonEntry[],
): Record<string, { insertions: number; deletions: number }> => Object.fromEntries(
  entries.map((entry) => [entry.path, { insertions: entry.insertions, deletions: entry.deletions }]),
);
