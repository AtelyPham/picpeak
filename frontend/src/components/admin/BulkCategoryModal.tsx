import React, { useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Card } from '../common';

interface CategoryOption {
  id: number;
  name: string;
  // Folders (#1160) have their own slot since issue 1786 (photos.folder_id)
  // and their own "Move to folder" action; they are not offered here.
  is_folder?: boolean;
}

interface BulkCategoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (categoryId: number | null) => Promise<void>;
  photoCount: number;
  categories: CategoryOption[];
  isLoading: boolean;
}

export const BulkCategoryModal: React.FC<BulkCategoryModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  photoCount,
  categories,
  isLoading,
}) => {
  const { t } = useTranslation();
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const filterCategories = categories.filter((category) => !category.is_folder);

  if (!isOpen) return null;

  const handleConfirm = async () => {
    await onConfirm(selectedCategoryId);
  };

  const handleClose = () => {
    setSelectedCategoryId(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <Card className="w-full max-w-md">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-heading">
              {t('photos.moveToCategory', 'Move {{count}} photos to category', { count: photoCount })}
            </h2>
            <button
              onClick={handleClose}
              className="p-1 hover:bg-hover rounded-lg transition-colors"
              disabled={isLoading}
            >
              <X className="w-5 h-5 text-muted" />
            </button>
          </div>

          <div className="mb-6">
            <label htmlFor="category-select" className="block text-sm font-medium text-body mb-2">
              {t('photos.selectCategory', 'Select category')}
            </label>
            <select
              id="category-select"
              value={selectedCategoryId ?? ''}
              onChange={(e) => setSelectedCategoryId(e.target.value === '' ? null : Number(e.target.value))}
              className="w-full px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
              disabled={isLoading}
            >
              <option value="">{t('photos.uncategorized', 'Uncategorized')}</option>
              {filterCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end gap-3">
            <Button
              variant="outline"
              onClick={handleClose}
              disabled={isLoading}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleConfirm}
              isLoading={isLoading}
              leftIcon={<FolderOpen className="w-4 h-4" />}
            >
              {t('photos.movePhotos', 'Move Photos')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
};

BulkCategoryModal.displayName = 'BulkCategoryModal';
