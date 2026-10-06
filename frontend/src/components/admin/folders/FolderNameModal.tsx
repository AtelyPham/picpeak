import React, { useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useModalFocus } from '../../../hooks/useModalFocus';
import { Button, Card } from '../../common';

interface FolderNameModalProps {
  isOpen: boolean;
  title: string;
  confirmLabel: string;
  initialName?: string;
  isLoading?: boolean;
  onClose: () => void;
  onConfirm: (name: string) => void;
}

// photo_categories.name is varchar(100); the folder routes validate the same.
const MAX_NAME_LENGTH = 100;

/** Name a new folder or rename one (issue 1786). */
export const FolderNameModal: React.FC<FolderNameModalProps> = (props) => {
  if (!props.isOpen) return null;
  return <FolderNameDialog {...props} />;
};

const FolderNameDialog: React.FC<FolderNameModalProps> = ({
  title,
  confirmLabel,
  initialName = '',
  isLoading = false,
  onClose,
  onConfirm,
}) => {
  const { t } = useTranslation();
  const panelRef = useModalFocus<HTMLDivElement>(true, onClose, isLoading);
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();
  const submit = () => {
    if (trimmed && !isLoading) onConfirm(trimmed);
  };

  return (
    <div
      ref={panelRef}
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <Card className="w-full max-w-md">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-heading">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              className="p-1 hover:bg-hover rounded-lg transition-colors"
              disabled={isLoading}
              aria-label={t('common.close', 'Close')}
            >
              <X className="w-5 h-5 text-muted" />
            </button>
          </div>
          <label htmlFor="folder-name" className="block text-sm font-medium text-body mb-2">
            {t('photos.folders.name', 'Folder name')}
          </label>
          <input
            id="folder-name"
            type="text"
            value={name}
            maxLength={MAX_NAME_LENGTH}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') onClose();
            }}
            className="w-full px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading focus:ring-2 focus:ring-primary-500"
          />
          <div className="flex justify-end gap-3 mt-6">
            <Button variant="outline" onClick={onClose} disabled={isLoading}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button variant="primary" onClick={submit} disabled={!trimmed} isLoading={isLoading}>
              {confirmLabel}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
};
