import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sessionApi } from '../../services/api';

// Status image item. <img src="/api/..."> can't carry the X-API-Key header, so the bytes are
// fetched via sessionApi (which does) and re-exposed as a local object URL. The URL is revoked on
// unmount/statusId change to avoid leaking blob memory as the viewer browses items.
function StatusMedia({
  sessionId,
  statusId,
  type,
}: {
  sessionId: string | null;
  statusId: string;
  type: 'image' | 'video' | 'audio';
}) {
  const { t } = useTranslation();
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<boolean>(false);

  useEffect(() => {
    if (!sessionId) return undefined;
    let objectUrl: string | null = null;
    let cancelled = false;
    setSrc(null);
    setError(false);
    sessionApi
      .getStatusMediaBlob(sessionId, statusId)
      .then(blob => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId, statusId]);

  if (error) return <span className="status-media-placeholder">{t('chats.status.mediaUnavailable')}</span>;
  if (!src) return null;
  if (type === 'video') return <video className="channel-media" src={src} controls />;
  // Voice statuses: the blob is an Ogg/Opus voice note — an <img> would render as a broken image.
  if (type === 'audio') return <audio className="channel-media" src={src} controls />;
  return <img className="channel-media" src={src} alt="" />;
}

export default StatusMedia;
