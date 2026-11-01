import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sessionApi } from '../../services/api';
import { keepsSameKey } from '../../utils/authLifecycle';
import { loadArchivedMedia } from '../../utils/archivedMediaLoad';

// Status image item. <img src="/api/..."> can't carry the X-API-Key header, so the bytes are
// fetched via sessionApi (which does) and re-exposed as a local object URL. The URL is revoked on
// unmount/statusId change to avoid leaking blob memory as the viewer browses items. Every item of the
// open contact mounts at once, so the fetches take their turns a gap apart and a refusal for rate is
// retried, as the previews of archived chat media do.
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
    const sameKey = keepsSameKey();
    const controller = new AbortController();
    setSrc(null);
    setError(false);
    loadArchivedMedia(controller.signal, () => {
      if (!sameKey()) throw new DOMException('Aborted', 'AbortError');
      return sessionApi.getStatusMediaBlob(sessionId, statusId, controller.signal);
    })
      .then(blob => {
        if (cancelled || !sameKey()) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled && sameKey()) setError(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
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
