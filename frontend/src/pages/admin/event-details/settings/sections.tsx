/**
 * Settings tab sections that edit the events row only. Each renders inside a
 * <fieldset> the tab disables when the admin may not change that section, so
 * the controls here never check permissions themselves.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Lock } from 'lucide-react';
import type { Event } from '../../../../types';
import { Input, LocalizedDateInput } from '../../../../components/common';
import { FeedbackSettings } from '../../../../components/admin';
import { CustomerAccountPicker } from '../../../../components/admin/CustomerAccountPicker';
import { UploaderNameSettings } from '../../../../components/admin/UploaderNameSettings';
import { useLocalizedDate } from '../../../../hooks/useLocalizedDate';
import { usePermission } from '../../../../hooks/usePermission';
import type { FeedbackSettings as FeedbackSettingsType } from '../../../../services/feedback.service';
import { ExternalFolderPicker } from '../ExternalFolderPicker';
import type { EventFields } from './draft';

export interface FieldsProps {
  f: EventFields;
  set: (patch: Partial<EventFields>) => void;
}

export const inputClass = 'w-full px-3 py-2 border border-line-strong bg-panel text-heading rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark disabled:bg-inset disabled:text-soft';
export const labelClass = 'block text-sm font-medium text-body mb-1';
export const checkboxClass = 'w-4 h-4 text-accent border-line-strong rounded focus:ring-primary-500';

/**
 * One block of a section, flat inside the section panel (the panel is the
 * card and carries the section's title). A section made of several blocks
 * titles the blocks after the first, and a rule separates them.
 */
export const SectionCard: React.FC<{ title?: string; description?: string; children: React.ReactNode }> = ({ title, description, children }) => (
  <section className="space-y-4 [&:not(:first-child)]:mt-6 [&:not(:first-child)]:pt-6 [&:not(:first-child)]:border-t border-line">
    {(title || description) && (
      <div>
        {title && <h3 className="text-base font-semibold text-heading">{title}</h3>}
        {description && <p className={`text-sm text-soft ${title ? 'mt-1' : ''}`}>{description}</p>}
      </div>
    )}
    {children}
  </section>
);

export const GeneralSection: React.FC<FieldsProps & { phoneFieldEnabled: boolean }> = ({ f, set, phoneFieldEnabled }) => {
  const { t } = useTranslation();
  return (
    <SectionCard>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className={labelClass} htmlFor="settings-host-name">{t('events.hostName')}</label>
          <Input
            id="settings-host-name"
            type="text"
            value={f.customer_name}
            onChange={(e) => set({ customer_name: e.target.value })}
            placeholder={t('events.hostNamePlaceholder')}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="settings-host-email">{t('events.hostEmail')}</label>
          <Input
            id="settings-host-email"
            type="email"
            value={f.customer_email}
            onChange={(e) => set({ customer_email: e.target.value })}
            placeholder={t('events.hostEmailPlaceholder')}
          />
        </div>
        {phoneFieldEnabled && (
          <div>
            <label className={labelClass} htmlFor="settings-host-phone">
              {t('events.customerPhone', 'Customer Phone')} ({t('common.optional')})
            </label>
            <Input
              id="settings-host-phone"
              type="tel"
              value={f.customer_phone}
              onChange={(e) => set({ customer_phone: e.target.value })}
              placeholder={t('events.customerPhonePlaceholder', '+1 555 555 1234')}
            />
          </div>
        )}
      </div>
      {/* Customer accounts (#354). Self-hides without the customerPortal flag. */}
      <CustomerAccountPicker
        value={f.customer_accounts}
        onChange={(next) => set({ customer_accounts: next })}
      />
      <div>
        <label className={labelClass} htmlFor="settings-welcome">{t('events.welcomeMessageLabel')}</label>
        <textarea
          id="settings-welcome"
          value={f.welcome_message}
          onChange={(e) => set({ welcome_message: e.target.value })}
          className={inputClass}
          rows={3}
          placeholder={t('events.welcomeMessage')}
        />
      </div>
    </SectionCard>
  );
};

export const AccessSection: React.FC<FieldsProps> = ({ f, set }) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const [showPassword, setShowPassword] = useState(false);
  return (
    <SectionCard>
      <div className="md:w-64">
        <label className={labelClass}>{t('events.expirationDate')}</label>
        <LocalizedDateInput
          value={f.expires_at}
          onChange={(iso) => set({ expires_at: iso })}
          min={format(new Date(), 'yyyy-MM-dd')}
        />
      </div>
      <div>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className={`mt-1 ${checkboxClass}`}
            checked={f.require_password}
            onChange={(e) => {
              const checked = e.target.checked;
              set({
                require_password: checked,
                new_password: checked ? f.new_password : '',
                confirm_new_password: checked ? f.confirm_new_password : '',
              });
              if (!checked) setShowPassword(false);
            }}
          />
          <div>
            <span className="text-sm font-medium text-body">{t('events.requirePasswordToggle')}</span>
            <p className="text-xs text-muted mt-1">
              {t('events.requirePasswordToggleHelp', 'Disable this if you want to share the gallery without a password. Anyone with the link will be able to view the photos.')}
            </p>
          </div>
        </label>
        {!f.require_password && (
          <div className="mt-2 rounded-md border border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-900/30 p-3 text-xs text-orange-800 dark:text-orange-300">
            {t('events.publicGalleryWarning', 'Public galleries are accessible to anyone with the link. Consider enabling download watermarks and monitoring activity.')}
          </div>
        )}
      </div>
      {f.require_password && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>{t('events.newPasswordLabel', 'New Gallery Password')}</label>
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                value={f.new_password}
                onChange={(e) => set({ new_password: e.target.value })}
                placeholder={t('events.settingsTab.passwordKeep', 'Leave empty to keep the current password')}
                leftIcon={<Lock className="w-5 h-5 text-faint" />}
                className="pr-10"
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center"
                aria-label={showPassword ? t('common.hidePassword', 'Hide password') : t('common.showPassword', 'Show password')}
              >
                {showPassword
                  ? <EyeOff className="w-5 h-5 text-faint hover:text-body" />
                  : <Eye className="w-5 h-5 text-faint hover:text-body" />}
              </button>
            </div>
          </div>
          <div>
            <label className={labelClass}>{t('events.confirmPassword')}</label>
            <Input
              type={showPassword ? 'text' : 'password'}
              value={f.confirm_new_password}
              onChange={(e) => set({ confirm_new_password: e.target.value })}
              placeholder={t('events.confirmPasswordPlaceholder')}
              leftIcon={<Lock className="w-5 h-5 text-faint" />}
              autoComplete="new-password"
            />
          </div>
        </div>
      )}
    </SectionCard>
  );
};

export const GuestsSection: React.FC<FieldsProps & {
  categories: Array<{ id: number; name: string }>;
  feedback: FeedbackSettingsType | null;
  setFeedback: (next: FeedbackSettingsType) => void;
}> = ({ f, set, categories, feedback, setFeedback }) => {
  const { t } = useTranslation();
  return (
    <SectionCard>
      <div>
        <label className="flex items-center">
          <input
            type="checkbox"
            checked={f.allow_user_uploads}
            onChange={(e) => set({ allow_user_uploads: e.target.checked })}
            className={checkboxClass}
          />
          <span className="ml-2 text-sm text-body">{t('events.allowUserUploads')}</span>
        </label>
        <p className="text-xs text-muted mt-1 ml-6">{t('events.allowUserUploadsHelp')}</p>
      </div>
      {f.allow_user_uploads && (
        <div className="ml-6">
          <label className={labelClass}>{t('events.uploadCategory')}</label>
          <select
            value={f.upload_category_id || ''}
            onChange={(e) => set({ upload_category_id: e.target.value ? parseInt(e.target.value) : null })}
            className={inputClass}
          >
            <option value="">{t('events.selectCategory')}</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
          <p className="text-xs text-muted mt-1">{t('events.uploadCategoryHelp')}</p>
        </div>
      )}
      {/* Reveal mode (#838) — only meaningful with guest uploads */}
      {f.allow_user_uploads && (
        <div className="ml-6">
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={f.reveal_mode}
              onChange={(e) => set({ reveal_mode: e.target.checked })}
              className={checkboxClass}
            />
            <span className="ml-2 text-sm text-body">{t('events.revealMode', 'Reveal mode (hide gallery until reveal)')}</span>
          </label>
          <p className="text-xs text-muted mt-1 ml-6">
            {t('events.revealModeHelp', 'Guests can upload but see no photos until you reveal the gallery — manually or at the scheduled time. Slideshow and client access keep working.')}
          </p>
          {f.reveal_mode && (
            <div className="mt-2 ml-6">
              <label className={labelClass}>{t('events.revealAt', 'Scheduled reveal (optional)')}</label>
              <input
                type="datetime-local"
                value={f.reveal_at}
                onChange={(e) => set({ reveal_at: e.target.value })}
                className="px-3 py-2 border border-line-strong bg-panel text-heading rounded-lg focus:ring-2 focus:ring-primary-500"
              />
              <p className="text-xs text-muted mt-1">
                {t('events.revealAtHelp', 'Leave empty to reveal manually with the "Reveal now" button.')}
              </p>
            </div>
          )}
        </div>
      )}
      {/* Uploader names (#1561). Not gated on uploads: the visibility switch
          also covers credits read from EXIF. */}
      <UploaderNameSettings
        idPrefix="event-uploader-names"
        mode={f.guest_name_mode}
        onModeChange={(guest_name_mode) => set({ guest_name_mode })}
        showToGuests={f.show_credits_to_guests}
        onShowToGuestsChange={(show_credits_to_guests) => set({ show_credits_to_guests })}
      />
      {feedback && (
        <div className="pt-4 border-t border-line">
          <h4 className="text-sm font-semibold text-heading mb-3">{t('feedback.settings.title', 'Guest Feedback Settings')}</h4>
          <FeedbackSettings settings={feedback} onChange={setFeedback} />
        </div>
      )}
    </SectionCard>
  );
};

export const SourceSection: React.FC<FieldsProps & { event: Event }> = ({ f, set, event }) => {
  const { t } = useTranslation();
  // Watching makes the server import on the admin's behalf, which the backend
  // gates on photos.upload like the Rescan button.
  const canEnableWatch = usePermission('photos.upload');
  // Same tile look as the create form's source choice.
  const option = (selected: boolean) => `flex flex-col items-start gap-1 text-left p-4 rounded-lg border-2 transition-all ${
    selected ? 'tile-selected' : 'border-line hover:border-line-strong'
  }`;
  return (
    <SectionCard
      description={t('events.sourceModeHelp', 'Use managed mode for direct uploads or point to a mounted /external-media folder when using local storage.')}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3" role="radiogroup" aria-label={t('events.sourceMode', 'Source Mode')}>
        <button
          type="button"
          role="radio"
          aria-checked={f.source_mode === 'managed'}
          className={option(f.source_mode === 'managed')}
          onClick={() => set({ source_mode: 'managed', external_path: '' })}
        >
          <span className="text-sm font-semibold text-heading">{t('events.sourceModeManaged', 'Managed (upload to PicPeak)')}</span>
          <span className="text-xs text-soft">{t('events.settingsTab.sourceManagedHelp', 'Photos are uploaded on the Photos tab and stored by PicPeak.')}</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={f.source_mode === 'reference'}
          className={option(f.source_mode === 'reference')}
          onClick={() => set({ source_mode: 'reference', external_path: f.external_path || event.external_path || '' })}
        >
          <span className="text-sm font-semibold text-heading">{t('events.sourceModeReference', 'Reference external folder')}</span>
          <span className="text-xs text-soft">{t('events.settingsTab.sourceReferenceHelp', 'Photos stay in your folder; PicPeak links to them.')}</span>
        </button>
      </div>
      {f.source_mode === 'reference' && (
        <>
          <div>
            <label className="block text-sm font-medium text-body mb-2">{t('events.externalFolder', 'External Folder')}</label>
            <ExternalFolderPicker value={f.external_path || ''} onChange={(folder) => set({ external_path: folder })} />
            <p className="text-xs text-muted mt-1">
              {t('events.externalFolderHint', 'These folders are read from the /external-media mount inside your container or host.')}
            </p>
          </div>
          <label className={`flex items-start gap-2 ${canEnableWatch || f.external_watch ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'}`}>
            <input
              type="checkbox"
              className="mt-0.5 rounded border-line-strong text-accent focus:ring-primary-500"
              checked={f.external_watch === true}
              disabled={!canEnableWatch && !f.external_watch}
              onChange={(e) => set({ external_watch: e.target.checked })}
            />
            <span className="text-sm">
              <span className="font-medium text-heading">{t('events.externalWatch', 'Watch folder for new files')}</span>
              <span className="block text-xs text-muted mt-0.5">
                {t('events.externalWatchHint', 'New images copied into this folder are imported automatically, the same way the Import button does it. Files removed from the folder are never deleted from the gallery.')}
              </span>
              {!canEnableWatch && !f.external_watch && (
                <span className="block text-xs text-muted mt-0.5">
                  {t('events.externalWatchNoPermission', 'Requires the permission to upload photos.')}
                </span>
              )}
            </span>
          </label>
          <p className="text-xs rounded-lg bg-accent-dark/10 text-body px-3 py-2">
            {t('events.settingsTab.sourceImportHint', 'Saving a new folder imports nothing by itself. After saving, use Import now on the Photos tab.')}
          </p>
        </>
      )}
    </SectionCard>
  );
};

export const ReminderSection: React.FC<FieldsProps & { reminderDate: string | null; recipient: string | null }> = ({ f, set, reminderDate, recipient }) => {
  const { t } = useTranslation();
  const sendOn = !f.event_reminder_disabled;
  return (
    <SectionCard
      description={t('eventReminderOverride.help', 'Per-event override for the customer reminder. Global on-off + default offset live under Settings → Reminder emails. Anything left blank here inherits the global setting / resolved template.')}
    >
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          className={checkboxClass}
          checked={sendOn}
          onChange={(e) => set({ event_reminder_disabled: !e.target.checked })}
        />
        <span className="text-body">{t('events.settingsTab.reminderSend', 'Send the pre-event reminder for this gallery')}</span>
      </label>
      {sendOn ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
            <div>
              <label className={labelClass} htmlFor="settings-reminder-offset">
                {t('events.settingsTab.reminderOffset', 'Days before the event')}
              </label>
              <Input
                id="settings-reminder-offset"
                type="number"
                min={0}
                max={365}
                value={f.event_reminder_offset_days}
                onChange={(e) => set({ event_reminder_offset_days: e.target.value })}
                placeholder={t('eventReminderOverride.offsetPlaceholder', 'Leave blank to use the global default') as string}
              />
            </div>
            {reminderDate && (
              <p className="text-sm rounded-lg bg-accent-dark/10 text-body px-3 py-2">
                {recipient
                  ? t('events.settingsTab.reminderWhenTo', 'Goes out on {{date}} to {{recipient}}', { date: reminderDate, recipient })
                  : t('events.settingsTab.reminderWhen', 'Goes out on {{date}}', { date: reminderDate })}
              </p>
            )}
          </div>
          <div>
            <label className={labelClass} htmlFor="settings-reminder-body">
              {t('eventReminderOverride.bodyOverrideLabel', 'Custom body for this event (overrides the resolved template body)')}
            </label>
            <textarea
              id="settings-reminder-body"
              rows={5}
              className={`${inputClass} text-sm`}
              placeholder={t('eventReminderOverride.bodyOverridePlaceholder', 'Leave blank to use the template body. Variables like {{customer_name}}, {{event_name}}, {{event_date}} still work here.') as string}
              value={f.event_reminder_body_override}
              onChange={(e) => set({ event_reminder_body_override: e.target.value })}
            />
          </div>
        </>
      ) : (
        <p className="text-sm rounded-lg bg-inset text-body px-3 py-2">
          {t('events.settingsTab.reminderOff', 'No reminder is sent for this gallery.')}
        </p>
      )}
    </SectionCard>
  );
};
