import React from 'react';

import { Button } from '@/components/ui/button';
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
  useHasSessionWorktreeMoveConfirmation,
} from '@/lib/worktrees/sessionWorktreeMove';

export function SessionWorktreeMoveDialog(): React.ReactNode {
  const { t } = useI18n();
  const open = useHasSessionWorktreeMoveConfirmation();

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) resolveSessionWorktreeMoveConfirmation(null);
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-md gap-5">
        <DialogHeader>
          <DialogTitle>{t('sessions.sidebar.session.moveToWorktree.confirm.title')}</DialogTitle>
          <DialogDescription>
            {t('sessions.sidebar.session.moveToWorktree.confirm.description')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => resolveSessionWorktreeMoveConfirmation(null)}>
            {t('sessions.sidebar.dialogs.cancel')}
          </Button>
          <Button variant="outline" onClick={() => resolveSessionWorktreeMoveConfirmation(false)}>
            {t('sessions.sidebar.session.moveToWorktree.confirm.leaveChanges')}
          </Button>
          <Button onClick={() => resolveSessionWorktreeMoveConfirmation(true)}>
            {t('sessions.sidebar.session.moveToWorktree.confirm.moveChanges')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
