import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, ExternalLink, Maximize2, Minimize2, X } from 'lucide-react';

export interface PdfPreviewData {
  url: string;
  filename: string;
  sizeBytes?: number;
}

interface Props {
  preview: PdfPreviewData;
  onClose: () => void;
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function PdfPreviewPane({ preview, onClose }: Props) {
  const { t } = useTranslation();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <>
      {isMaximized && (
        <div
          className="pdf-modal-backdrop"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={`pdf-preview-panel ${isMaximized ? 'maximized' : ''}`}
        aria-label={preview.filename || 'PDF Preview'}
      >
        <header className="pdf-preview-header">
          <div className="pdf-preview-title-box">
            <span className="pdf-preview-badge">PDF</span>
            <span className="pdf-preview-filename" title={preview.filename}>
              {preview.filename}
            </span>
            {preview.sizeBytes && (
              <span className="pdf-preview-size">{formatBytes(preview.sizeBytes)}</span>
            )}
          </div>
          <div className="pdf-preview-actions">
            <button
              type="button"
              className="icon-btn"
              onClick={() => setIsMaximized(m => !m)}
              title={isMaximized ? t('common.restore') : t('common.maximize')}
              aria-label={isMaximized ? t('common.restore') : t('common.maximize')}
            >
              {isMaximized ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>
            <a
              href={preview.url}
              target="_blank"
              rel="noopener noreferrer"
              className="icon-btn"
              title={t('chats.media.openInNewTab')}
              aria-label={t('chats.media.openInNewTab')}
            >
              <ExternalLink size={18} />
            </a>
            <a
              href={preview.url}
              download={preview.filename || 'document.pdf'}
              className="icon-btn"
              title={t('chats.downloadDocument')}
              aria-label={t('chats.downloadDocument')}
            >
              <Download size={18} />
            </a>
            <button
              type="button"
              className="icon-btn close-btn"
              onClick={onClose}
              title={t('common.close')}
              aria-label={t('common.close')}
            >
              <X size={20} />
            </button>
          </div>
        </header>
        <div className="pdf-preview-body">
          <iframe
            src={`${preview.url}#toolbar=1&navpanes=0`}
            className="pdf-preview-frame"
            title={preview.filename}
          />
        </div>
      </aside>
    </>
  );
}
