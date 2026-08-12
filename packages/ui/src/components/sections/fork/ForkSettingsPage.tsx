import React from 'react';

import { useI18n } from '@/lib/i18n';
import { useForkSettingsStore } from '@/stores/useForkSettingsStore';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_OPTION_STACK_CLASS,
  SettingsCheckboxRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';

export const ForkSettingsPage: React.FC = () => {
  const { t } = useI18n();
  const startNewChatInCurrentWorktree = useForkSettingsStore((state) => state.startNewChatInCurrentWorktree);
  const setStartNewChatInCurrentWorktree = useForkSettingsStore((state) => state.setStartNewChatInCurrentWorktree);

  return (
    <SettingsPageLayout
      title={t('settings.page.fork.title')}
      description={t('settings.page.fork.description')}
    >
      <SettingsSection
        title={t('settings.fork.section.worktrees')}
        divider={false}
      >
        <div className={SETTINGS_OPTION_STACK_CLASS}>
          <SettingsCheckboxRow
            settingsItem="fork.start-new-chat-in-worktree"
            checked={startNewChatInCurrentWorktree}
            onChange={setStartNewChatInCurrentWorktree}
            label={t('settings.fork.startNewChatInWorktree.label')}
            ariaLabel={t('settings.fork.startNewChatInWorktree.label')}
            info={t('settings.fork.startNewChatInWorktree.info')}
          />
        </div>
      </SettingsSection>
    </SettingsPageLayout>
  );
};
