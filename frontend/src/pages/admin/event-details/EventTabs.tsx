import React from 'react';
import { useTranslation } from 'react-i18next';
import { Image, Settings } from 'lucide-react';
import type { Event } from '../../../types';
import type { EventDetailsTab } from './types';

interface EventTabsProps {
  event: Event;
  activeTab: EventDetailsTab;
  setActiveTab: (tab: EventDetailsTab) => void;
  showGuestsTab: boolean;
  /** The Settings draft has unsaved edits. */
  settingsDirty: boolean;
}

export const EventTabs: React.FC<EventTabsProps> = ({
  event,
  activeTab,
  setActiveTab,
  showGuestsTab,
  settingsDirty,
}) => {
  const { t } = useTranslation();

  const tabClass = (tab: EventDetailsTab) => `py-2 px-1 border-b-2 font-medium text-sm flex items-center gap-2 whitespace-nowrap ${
    activeTab === tab
      ? 'border-accent text-accent'
      : 'border-transparent text-muted hover:text-body hover:border-line-strong'
  }`;

  return (
    <div className="mb-6 border-b border-line overflow-x-auto">
      <nav className="-mb-px flex gap-8" role="tablist">
        <button type="button" role="tab" aria-selected={activeTab === 'overview'} onClick={() => setActiveTab('overview')} className={tabClass('overview')}>
          {t('events.overview')}
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'photos'} onClick={() => setActiveTab('photos')} className={tabClass('photos')}>
          <Image className="w-4 h-4" />
          <span>{(event.video_count ?? 0) > 0 ? t('events.media', 'Media') : t('events.photos')}</span>
          {event.photo_count !== undefined && event.photo_count > 0 && (
            <span className="ml-1 px-2 py-0.5 text-xs font-medium bg-inset text-body rounded-full">{event.photo_count}</span>
          )}
        </button>
        {showGuestsTab && (
          <button type="button" role="tab" aria-selected={activeTab === 'guests'} onClick={() => setActiveTab('guests')} className={tabClass('guests')}>
            {t('admin.events.tabs.guestsFeedback', 'Guests & Feedback')}
          </button>
        )}
        <button type="button" role="tab" aria-selected={activeTab === 'settings'} onClick={() => setActiveTab('settings')} className={tabClass('settings')}>
          <Settings className="w-4 h-4" />
          <span>{t('admin.events.tabs.settings', 'Settings')}</span>
          {settingsDirty && (
            <span className="w-2 h-2 rounded-full bg-amber-500" aria-label={t('settings.saveBar.unsaved', 'You have unsaved changes')} />
          )}
        </button>
      </nav>
    </div>
  );
};
