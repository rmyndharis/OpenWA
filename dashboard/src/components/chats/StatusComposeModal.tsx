import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { contactApi, sessionApi } from '../../services/api';
import { useCurrentEngineQuery } from '../../hooks/queries';
import { useToast } from '../../hooks/useToast';
import { Modal } from '../Modal';

// Mirrors @ArrayMaxSize(256) on the send-status DTOs — the picker caps selection client-side so the
// user can't build a list the backend is guaranteed to reject.
const STATUS_RECIPIENTS_MAX = 256;

interface Props {
  sessionId: string;
  onClose: () => void;
  onPosted: () => void;
}

function StatusComposeModal({ sessionId, onClose, onPosted }: Props) {
  const { t } = useTranslation();
  const { success: showSuccessToast, error: showErrorToast } = useToast();
  const currentEngine = useCurrentEngineQuery();

  // Baileys targets a status post to an explicit allow-list (statusJidList); whatsapp-web.js has no
  // per-recipient concept and broadcasts to the account's status-privacy audience instead, so the
  // recipient picker is Baileys-only.
  const isBaileysEngine = currentEngine.data?.engineType === 'baileys';

  const [composeType, setComposeType] = useState<'text' | 'image'>('text');
  const [composeText, setComposeText] = useState<string>('');
  const [composeBgColor, setComposeBgColor] = useState<string>('');
  const [composeFont, setComposeFont] = useState<string>('');
  const [composeImageUrl, setComposeImageUrl] = useState<string>('');
  const [composeImageBase64, setComposeImageBase64] = useState<string | null>(null);
  const [composeCaption, setComposeCaption] = useState<string>('');
  const [composeRecipients, setComposeRecipients] = useState<string[]>([]);
  const [composeRecipientSearch, setComposeRecipientSearch] = useState<string>('');
  const [composePosting, setComposePosting] = useState<boolean>(false);
  const composeFileInputRef = useRef<HTMLInputElement | null>(null);
  // Monotonic token invalidating an in-flight FileReader: picking a file reads asynchronously, and
  // a URL edit (or form reset) before `onload` fires must win over the late-arriving file bytes.
  const composeImageReadSeq = useRef(0);

  // Unmounting the modal with a read still in flight: invalidate the reader so its late
  // onload handler drops the bytes instead of setting state on a dead component.
  useEffect(() => {
    return () => {
      composeImageReadSeq.current += 1;
    };
  }, []);

  // Sourced only while the modal is actually open on Baileys — no reason to fetch the full contact
  // list on wwjs (no picker) or before the user has opened compose. The page only mounts this
  // component while the modal is open, so being mounted implies "open".
  const composeContactsQuery = useQuery({
    queryKey: ['status-compose-contacts', sessionId],
    queryFn: () => contactApi.list(sessionId!),
    enabled: isBaileysEngine && Boolean(sessionId),
  });
  const composeContacts = composeContactsQuery.data ?? [];
  const composeRecipientSearchLower = composeRecipientSearch.toLowerCase();
  const filteredComposeContacts = composeContacts.filter(c =>
    // Match against every identity field — a named contact must still be findable by number/JID.
    [c.name, c.pushName, c.number, c.id].some(v => v?.toLowerCase().includes(composeRecipientSearchLower)),
  );

  const resetComposeForm = useCallback(() => {
    composeImageReadSeq.current += 1;
    setComposeType('text');
    setComposeText('');
    setComposeBgColor('');
    setComposeFont('');
    setComposeImageUrl('');
    setComposeImageBase64(null);
    setComposeCaption('');
    setComposeRecipients([]);
    setComposeRecipientSearch('');
    if (composeFileInputRef.current) composeFileInputRef.current.value = '';
  }, []);

  const closeComposeModal = useCallback(() => {
    onClose();
    resetComposeForm();
  }, [onClose, resetComposeForm]);

  const toggleComposeRecipient = (id: string) => {
    setComposeRecipients(prev =>
      prev.includes(id) ? prev.filter(r => r !== id) : prev.length >= STATUS_RECIPIENTS_MAX ? prev : [...prev, id],
    );
  };

  const handleComposeImageUrlChange = (value: string) => {
    composeImageReadSeq.current += 1;
    setComposeImageUrl(value);
    if (value) {
      setComposeImageBase64(null);
      if (composeFileInputRef.current) composeFileInputRef.current.value = '';
    }
  };

  const handleComposeImageFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setComposeImageUrl('');
    const myRead = ++composeImageReadSeq.current;
    const reader = new FileReader();
    reader.onload = event => {
      // A URL edit or form reset since the read started supersedes these bytes — drop them.
      if (composeImageReadSeq.current !== myRead) return;
      // The backend's stripBase64DataUri unwraps a `data:...;base64,` prefix, so passing the raw
      // data URL through as `base64` is safe — no need to slice it ourselves.
      setComposeImageBase64(event.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  const composeCanSubmit =
    Boolean(sessionId) &&
    !composePosting &&
    // The engine type decides whether recipients are required (Baileys) or omitted (wwjs) — while
    // it's still unknown, a Baileys submit would go out with no recipients and 400.
    Boolean(currentEngine.data) &&
    (composeType === 'text' ? composeText.trim().length > 0 : Boolean(composeImageBase64 || composeImageUrl.trim())) &&
    (!isBaileysEngine || composeRecipients.length > 0);

  const handleComposeSubmit = async () => {
    if (!sessionId || !composeCanSubmit) return;
    setComposePosting(true);
    try {
      // whatsapp-web.js ignores `recipients` entirely (it broadcasts to status@broadcast), so none
      // are sent — the backend DTO treats the list as optional and only the Baileys engine requires
      // (and honors) it. The picker is hidden on wwjs since it has no effect there.
      const recipients = isBaileysEngine ? composeRecipients : undefined;
      if (composeType === 'text') {
        await sessionApi.postTextStatus(sessionId, composeText.trim(), recipients, {
          backgroundColor: composeBgColor || undefined,
          font: composeFont === '' ? undefined : Number(composeFont),
        });
      } else {
        const image = composeImageBase64 ? { base64: composeImageBase64 } : { url: composeImageUrl.trim() };
        await sessionApi.postImageStatus(sessionId, image, recipients, composeCaption.trim() || undefined);
      }
      showSuccessToast(t('chats.status.posted'));
      closeComposeModal();
      onPosted();
    } catch (err) {
      showErrorToast(t('chats.status.postFailed'), err instanceof Error ? err.message : undefined);
    } finally {
      setComposePosting(false);
    }
  };

  return (
    <Modal
      open
      onClose={closeComposeModal}
      title={t('chats.status.compose')}
      closeLabel={t('common.close')}
      className="status-compose-modal"
      footer={
        <>
          <button className="btn-secondary" onClick={closeComposeModal} disabled={composePosting}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" onClick={handleComposeSubmit} disabled={!composeCanSubmit}>
            {composePosting ? <Loader2 className="animate-spin" size={16} /> : t('chats.status.post')}
          </button>
        </>
      }
    >
      <div className="compose-type-toggle">
        <button type="button" className={composeType === 'text' ? 'active' : ''} onClick={() => setComposeType('text')}>
          {t('chats.status.composeText')}
        </button>
        <button
          type="button"
          className={composeType === 'image' ? 'active' : ''}
          onClick={() => setComposeType('image')}
        >
          {t('chats.status.composeImage')}
        </button>
      </div>

      {composeType === 'text' ? (
        <>
          <div className="compose-field">
            <label>{t('chats.status.composeText')}</label>
            <textarea
              value={composeText}
              onChange={e => setComposeText(e.target.value)}
              maxLength={4096}
              placeholder={t('chats.status.composeText')}
            />
          </div>
          <div className="compose-row">
            <div className="compose-field">
              <label>{t('chats.status.backgroundColor')}</label>
              <input
                type="color"
                value={composeBgColor || '#000000'}
                onChange={e => setComposeBgColor(e.target.value)}
              />
            </div>
            <div className="compose-field">
              <label>{t('chats.status.font')}</label>
              <select value={composeFont} onChange={e => setComposeFont(e.target.value)}>
                <option value="">{t('chats.status.fontDefault')}</option>
                {/* The WhatsApp status font enum: 6 is the bold system face; 3–5 don't exist on
                    the wire and the backend rejects them. */}
                {[0, 1, 2, 6, 7, 8, 9, 10].map(f => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="compose-field">
            <label>{t('chats.status.composeImage')}</label>
            <input
              type="url"
              placeholder="https://example.com/image.jpg"
              value={composeImageUrl}
              onChange={e => handleComposeImageUrlChange(e.target.value)}
            />
          </div>
          <p className="compose-image-or">{t('chats.status.orLabel')}</p>
          <div className="compose-field">
            <input type="file" accept="image/*" ref={composeFileInputRef} onChange={handleComposeImageFile} />
          </div>
          <div className="compose-field">
            <label>{t('chats.status.caption')}</label>
            <input
              type="text"
              placeholder={t('chats.captionPlaceholder')}
              value={composeCaption}
              onChange={e => setComposeCaption(e.target.value)}
              maxLength={1024}
            />
          </div>
        </>
      )}

      {isBaileysEngine && (
        <div className="compose-field">
          <label>{t('chats.status.recipients')}</label>
          <input
            type="text"
            placeholder={t('common.search')}
            value={composeRecipientSearch}
            onChange={e => setComposeRecipientSearch(e.target.value)}
          />
          <div className="compose-recipients">
            {composeContactsQuery.isLoading ? (
              <div className="compose-recipients-empty">
                <Loader2 className="animate-spin" size={16} />
              </div>
            ) : filteredComposeContacts.length === 0 ? (
              <div className="compose-recipients-empty">{t('chats.status.noContacts')}</div>
            ) : (
              filteredComposeContacts.map(c => (
                <label key={c.id} className="compose-recipient-row">
                  <input
                    type="checkbox"
                    checked={composeRecipients.includes(c.id)}
                    disabled={!composeRecipients.includes(c.id) && composeRecipients.length >= STATUS_RECIPIENTS_MAX}
                    onChange={() => toggleComposeRecipient(c.id)}
                  />
                  <span>{c.name || c.pushName || c.number || c.id}</span>
                </label>
              ))
            )}
          </div>
          <p className="input-hint">{t('chats.status.recipientsHint')}</p>
        </div>
      )}
    </Modal>
  );
}

export default StatusComposeModal;
