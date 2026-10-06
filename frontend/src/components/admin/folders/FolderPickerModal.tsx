import React, { useState } from 'react';
import { FolderInput, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useModalFocus } from '../../../hooks/useModalFocus';
import { Button, Card } from '../../common';
import type { FolderNode } from '../../../utils/folderTree';
import { FolderTreePicker } from './FolderTreePicker';

interface FolderPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (folderId: number | null) => void | Promise<void>;
  title: string;
  description?: string;
  confirmLabel: string;
  folders: FolderNode[];
  allowRoot?: boolean;
  isDisabled?: (id: number) => boolean;
  isLoading?: boolean;
  /** Preselected target; undefined = nothing picked yet. */
  initialValue?: number | null;
}

/** A folder tree picker in a dialog: move photos, move a folder, approve a request as… (issue 1786). */
export const FolderPickerModal: React.FC<FolderPickerModalProps> = (props) => {
  if (!props.isOpen) return null;
  // Mounted per opening, so the selection starts from initialValue each time.
  return <FolderPickerDialog {...props} />;
};

const FolderPickerDialog: React.FC<FolderPickerModalProps> = ({
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  folders,
  allowRoot = false,
  isDisabled,
  isLoading = false,
  initialValue,
}) => {
  const { t } = useTranslation();
  const panelRef = useModalFocus<HTMLDivElement>(true, onClose, isLoading);
  const [selected, setSelected] = useState<number | null | undefined>(initialValue);
  const picked = selected !== undefined && !(selected !== null && isDisabled?.(selected));

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
          <div className="flex items-center justify-between mb-2">
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
          {description && <p className="text-sm text-soft mb-4">{description}</p>}

          <FolderTreePicker
            folders={folders}
            value={selected}
            onChange={setSelected}
            allowRoot={allowRoot}
            isDisabled={isDisabled}
          />

          <div className="flex justify-end gap-3 mt-6">
            <Button variant="outline" onClick={onClose} disabled={isLoading}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => picked && onConfirm(selected ?? null)}
              disabled={!picked}
              isLoading={isLoading}
              leftIcon={<FolderInput className="w-4 h-4" />}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
};
