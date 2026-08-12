import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import {
  resolveSessionWorktreeMoveConfirmation,
  normalizeSessionWorktreeBranchName,
  normalizeSessionWorktreeName,
  useSessionWorktreeMoveConfirmation,
  validateSessionWorktreeMoveTarget,
} from '@/lib/worktrees/sessionWorktreeMove';

export function SessionWorktreeMoveDialog(): React.ReactNode {
  const { t } = useI18n();
  const confirmation = useSessionWorktreeMoveConfirmation();
  const [branchName, setBranchName] = React.useState('');
  const [worktreeName, setWorktreeName] = React.useState('');
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const [isValidating, setIsValidating] = React.useState(false);
  const isSyncingWorktreeName = React.useRef(true);
  const branchNameId = React.useId();
  const worktreeNameId = React.useId();

  React.useLayoutEffect(() => {
    if (!confirmation) return;
    setBranchName(confirmation.branchName);
    setWorktreeName(confirmation.worktreeName);
    isSyncingWorktreeName.current = true;
    setValidationError(null);
    setIsValidating(false);
  }, [confirmation]);

  const confirmMove = async (moveChanges: boolean) => {
    const target = {
      branchName: normalizeSessionWorktreeBranchName(branchName),
      worktreeName: normalizeSessionWorktreeName(worktreeName),
    };
    if (!target.branchName) {
      setValidationError(t('session.newWorktree.error.branchNameRequired'));
      return;
    }
    if (!target.worktreeName) {
      setValidationError(t('session.newWorktree.error.worktreeDirectoryRequired'));
      return;
    }

    setIsValidating(true);
    setValidationError(null);
    try {
      const validation = await validateSessionWorktreeMoveTarget(target);
      if (!validation.ok) {
        setValidationError(validation.errors[0]?.message ?? t('session.newWorktree.error.createWorktreeFailed'));
        return;
      }
      resolveSessionWorktreeMoveConfirmation({ moveChanges, target });
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsValidating(false);
    }
  };

  return (
    <Dialog
      open={Boolean(confirmation)}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isValidating) resolveSessionWorktreeMoveConfirmation(null);
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-md gap-5">
        <DialogHeader>
          <DialogTitle>{t('sessions.sidebar.session.moveToWorktree.confirm.title')}</DialogTitle>
          <DialogDescription>
            {t('sessions.sidebar.session.moveToWorktree.confirm.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor={branchNameId} className="typography-ui-label font-semibold text-foreground">
              {t('session.newWorktree.branchName')}
            </label>
            <Input
              id={branchNameId}
              value={branchName}
              onChange={(event) => {
                const nextBranchName = event.target.value;
                setBranchName(nextBranchName);
                if (isSyncingWorktreeName.current) {
                  const normalizedBranchName = normalizeSessionWorktreeBranchName(nextBranchName);
                  setWorktreeName(normalizeSessionWorktreeName(normalizedBranchName));
                }
                setValidationError(null);
              }}
              placeholder={t('session.newWorktree.branchNamePlaceholder')}
              aria-invalid={Boolean(validationError)}
              disabled={isValidating}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={worktreeNameId} className="typography-ui-label font-semibold text-foreground">
              {t('session.newWorktree.worktreeDirectory')}
            </label>
            <Input
              id={worktreeNameId}
              value={worktreeName}
              onChange={(event) => {
                setWorktreeName(event.target.value);
                isSyncingWorktreeName.current = false;
                setValidationError(null);
              }}
              placeholder={t('session.newWorktree.worktreeDirectoryPlaceholder')}
              aria-invalid={Boolean(validationError)}
              disabled={isValidating}
            />
          </div>
          {validationError && (
            <p className="typography-micro text-destructive" role="alert">
              {validationError}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={isValidating} onClick={() => resolveSessionWorktreeMoveConfirmation(null)}>
            {t('sessions.sidebar.dialogs.cancel')}
          </Button>
          <Button variant="outline" disabled={isValidating} onClick={() => void confirmMove(false)}>
            {t('sessions.sidebar.session.moveToWorktree.confirm.leaveChanges')}
          </Button>
          <Button disabled={isValidating} onClick={() => void confirmMove(true)}>
            {t('sessions.sidebar.session.moveToWorktree.confirm.moveChanges')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
