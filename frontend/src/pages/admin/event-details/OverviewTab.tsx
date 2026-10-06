/**
 * Overview: what the gallery is and how to reach it, plus the one-click
 * actions for helping a client. Nothing here is a setting — those live in the
 * Settings tab — so the tab needs no edit mode.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock, Eye, Mail } from 'lucide-react';
import type { Event } from '../../../types';
import { Button, Card } from '../../../components/common';
import { FeedbackModerationPanel } from '../../../components/admin';
import { ShortUrlsCard } from '../../../components/admin/ShortUrlsCard';
import { useAnyPermission, usePermission } from '../../../hooks/usePermission';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { useFeatureFlags } from '../../../contexts/FeatureFlagsContext';
import { toBoolean } from '../../../utils/parsers';
import type { FeedbackSettings as FeedbackSettingsType } from '../../../services/feedback.service';
import type { EventDetailsTab } from './types';
import type { SettingsSectionKey } from './settings/draft';
import { usesCustomTheme } from './settings/draft';
import { ShareLinkCard } from './ShareLinkCard';
import { ClientAccessCard } from './ClientAccessCard';
import { PhotoStatisticsCard } from './PhotoStatisticsCard';
import { ArchiveStatusCard } from './ArchiveStatusCard';
import { DownloadLimitUsage } from './DownloadLimitUsage';
import { safeParseDate } from './utils';

interface OverviewTabProps {
  event: Event;
  id: string | undefined;
  passwordVersion?: number;
  feedbackSettings: FeedbackSettingsType | undefined;
  categories: Array<{ id: number; name: string; slug: string; is_folder?: boolean }>;
  daysUntilExpiration: number | null;
  refetchEvent: () => void;
  setActiveTab: (tab: EventDetailsTab) => void;
  openSettings: (section: SettingsSectionKey) => void;
  setShowPasswordReset: (show: boolean) => void;
  onSendGalleryEmail: () => void;
  isSendingGalleryEmail: boolean;
  onExtendExpiration: (days: number) => void;
  isExtending: boolean;
  onRevealNow: () => void;
}

/** Accounts the gallery email can actually reach (mirrors crud.js canReceiveGalleryNotice). */
export function reachableCustomerCount(event: Event): number {
  const accounts = (event as { customer_accounts?: Array<{ email?: string; is_active?: unknown; can_sign_in?: unknown }> }).customer_accounts || [];
  return accounts.filter((c) => toBoolean(c.is_active, true) && toBoolean(c.can_sign_in, true) && !!c.email).length;
}

export function canSendGalleryEmail(event: Event): boolean {
  const hasRecipient = !!event.customer_email || reachableCustomerCount(event) > 0;
  const isExpired = !!event.expires_at && new Date(event.expires_at) <= new Date();
  return hasRecipient && !isExpired && toBoolean(event.is_active, true) && !event.is_draft && !event.is_archived;
}

const SummaryRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center justify-between gap-4 py-2.5 border-t border-line first:border-t-0">
    <span className="text-sm text-soft">{label}</span>
    <span className="text-sm text-heading text-right">{children}</span>
  </div>
);

export const OverviewTab: React.FC<OverviewTabProps> = ({
  event,
  id,
  passwordVersion,
  feedbackSettings,
  categories,
  daysUntilExpiration,
  refetchEvent,
  setActiveTab,
  openSettings,
  setShowPasswordReset,
  onSendGalleryEmail,
  isSendingGalleryEmail,
  onExtendExpiration,
  isExtending,
  onRevealNow,
}) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const { flags } = useFeatureFlags();
  const canHelpClient = useAnyPermission(['events.edit', 'events.support']) && !event.share_secrets_hidden;
  // Revealing changes what guests see; the route needs events.edit.
  const canReveal = usePermission('events.edit') && !event.share_secrets_hidden;
  const archived = Boolean(event.is_archived);
  const expiresAt = safeParseDate(event.expires_at);
  const hiddenUntilReveal = toBoolean(event.reveal_mode, false) && !event.revealed_at;

  const link = (section: SettingsSectionKey, text: string) => (
    <button type="button" className="text-accent hover:underline" onClick={() => openSettings(section)}>{text}</button>
  );

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-6">
      <div className="space-y-6 min-w-0">
        <ShareLinkCard event={event} setShowPasswordReset={setShowPasswordReset} passwordVersion={passwordVersion} />
        <ShortUrlsCard eventId={event.id} />

        {!archived && canHelpClient && (
          <Card padding="md">
            <h2 className="text-lg font-semibold text-heading">{t('events.overviewTab.helpClient', 'Help the client')}</h2>
            <p className="text-sm text-soft mt-1 mb-4">
              {t('events.overviewTab.helpClientHint', 'Actions that take effect at once. Password and resend-email are on the share card above.')}
            </p>
            <div className="flex flex-wrap gap-2">
              {canSendGalleryEmail(event) && (
                <Button variant="outline" size="sm" leftIcon={<Mail className="w-4 h-4" />} onClick={onSendGalleryEmail} isLoading={isSendingGalleryEmail}>
                  {t('events.sendGalleryEmail.button', 'Send gallery email')}
                </Button>
              )}
              {expiresAt && (
                <>
                  <Button variant="outline" size="sm" leftIcon={<CalendarClock className="w-4 h-4" />} onClick={() => onExtendExpiration(30)} isLoading={isExtending}>
                    {t('events.overviewTab.extendDays', '+{{days}} days', { days: 30 })}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => onExtendExpiration(90)} disabled={isExtending}>
                    {t('events.overviewTab.extendDays', '+{{days}} days', { days: 90 })}
                  </Button>
                </>
              )}
              {hiddenUntilReveal && canReveal && (
                <Button variant="outline" size="sm" leftIcon={<Eye className="w-4 h-4" />} onClick={onRevealNow}>
                  {t('events.revealNow', 'Reveal now')}
                </Button>
              )}
            </div>
          </Card>
        )}

        <ClientAccessCard event={event} refetchEvent={refetchEvent} />

        {!archived && feedbackSettings?.feedback_enabled && (
          <div className="space-y-2">
            <FeedbackModerationPanel eventId={parseInt(id!)} compact={true} maxItems={3} />
            <button type="button" className="text-sm font-medium text-accent hover:underline" onClick={() => setActiveTab('guests')}>
              {t('events.overviewTab.openFeedback', 'Open Guests & Feedback')}
            </button>
          </div>
        )}
      </div>

      <div className="space-y-6">
        <PhotoStatisticsCard event={event} categories={categories} setActiveTab={setActiveTab} />

        <Card padding="md">
          <h2 className="text-lg font-semibold text-heading mb-2">{t('events.overviewTab.details', 'Details')}</h2>
          <SummaryRow label={t('events.hostName')}>{event.customer_name || <span className="text-muted">{t('common.notSet')}</span>}</SummaryRow>
          <SummaryRow label={t('events.hostEmail')}>{event.customer_email || <span className="text-muted">{t('common.notSet')}</span>}</SummaryRow>
          {event.admin_email && <SummaryRow label={t('events.adminEmail')}>{event.admin_email}</SummaryRow>}
          {event.created_at && <SummaryRow label={t('events.created')}>{format(safeParseDate(event.created_at)!, 'PP')}</SummaryRow>}
          <SummaryRow label={t('events.expires')}>
            {expiresAt ? (
              <>
                {format(expiresAt, 'PP')}
                {!archived && daysUntilExpiration !== null && daysUntilExpiration > 0 && (
                  <span className="text-muted ml-1">{t('events.daysLeft', { count: daysUntilExpiration })}</span>
                )}
              </>
            ) : t('events.neverExpires', 'Never')}
          </SummaryRow>
          {!!event.allow_downloads && !!event.download_limit && (
            <div className="py-2.5 border-t border-line">
              {/* Usage for everyone; its Reset is gated inside. */}
              <DownloadLimitUsage eventId={event.id} downloadLimit={event.download_limit} ownedByOther={!!event.share_secrets_hidden} />
            </div>
          )}
          {hiddenUntilReveal && (
            <SummaryRow label={t('events.revealModeStatus', 'Reveal mode')}>
              {event.reveal_at
                ? t('events.revealScheduled', 'Scheduled: {{date}}', { date: format(new Date(event.reveal_at), 'PPp') })
                : t('events.hiddenUntilReveal', 'Hidden from guests')}
            </SummaryRow>
          )}
        </Card>

        <Card padding="md">
          <h2 className="text-lg font-semibold text-heading mb-2">{t('events.overviewTab.setup', 'Setup')}</h2>
          <SummaryRow label={t('events.settingsTab.source', 'Photo source')}>
            {link('source', event.source_mode === 'reference'
              ? (toBoolean(event.external_watch, false)
                ? t('events.overviewTab.sourceWatched', 'External folder · watched')
                : t('events.overviewTab.sourceExternal', 'External folder'))
              : t('events.overviewTab.sourceUploads', 'Uploads'))}
          </SummaryRow>
          <SummaryRow label={t('events.settingsTab.appearance', 'Appearance')}>
            {link('appearance', usesCustomTheme(event)
              ? t('events.overviewTab.themeCustom', 'Custom styling')
              : t('events.settingsTab.globalTheme', 'Global theme (Branding)'))}
          </SummaryRow>
          <SummaryRow label={t('events.settingsTab.downloads', 'Downloads')}>
            {link('downloads', event.allow_downloads === false || (event.allow_downloads as unknown) === 0
              ? t('events.downloadsDisabled', 'Downloads Disabled')
              : t('events.overviewTab.downloadsOn', 'Allowed'))}
          </SummaryRow>
          {flags.reminderEmails && (
            <SummaryRow label={t('eventReminderOverride.title', 'Pre-event reminder')}>
              {link('reminder', toBoolean(event.event_reminder_disabled, false)
                ? t('events.overviewTab.reminderOff', 'Off for this gallery')
                : event.event_reminder_sent_at
                  ? t('events.overviewTab.reminderSent', 'Sent {{date}}', { date: format(new Date(event.event_reminder_sent_at), 'PP') })
                  : t('events.overviewTab.reminderOn', 'On'))}
            </SummaryRow>
          )}
        </Card>

        {archived ? <ArchiveStatusCard event={event} id={id} /> : null}
      </div>
    </div>
  );
};
