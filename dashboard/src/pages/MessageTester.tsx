import { useState, useEffect, useRef, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, CheckCircle, XCircle, Loader2, Upload, X, Plus } from 'lucide-react';
import {
  messageApi,
  contactApi,
  type SendMediaPayload,
  type MessageResponse,
  type BatchStatus,
  type BatchStatusResponse,
} from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useSessionsQuery, useSessionGroupsQuery } from '../hooks/queries';
import { parseBulkRecipients, BULK_MAX_RECIPIENTS } from '../utils/bulkRecipients';
import { PageHeader } from '../components/PageHeader';
import './MessageTester.css';

interface ApiResponse {
  success: boolean;
  messageId?: string;
  /** Bulk sends return 202 + a batch instead of a messageId; the panel polls its progress. */
  batchId?: string;
  timestamp: string;
  error?: string;
  // The real HTTP status, carried on the Error by `request()` in services/api.ts. Absent when no
  // request was made (the recipient pre-check below short-circuits) — the panel then shows the
  // outcome without a code rather than inventing one.
  status?: number;
}

const messageTypes = [
  'text',
  'image',
  'video',
  'audio',
  'document',
  'location',
  'contact',
  'sticker',
  'poll',
  'forward',
  'bulk',
] as const;

// The types that share the media upload/URL block (base64 XOR url + mimetype).
const mediaMessageTypes: readonly string[] = ['image', 'video', 'audio', 'document', 'sticker'];

// Hint the native file picker at the right category (documents accept anything).
const mediaAccept: Record<(typeof messageTypes)[number], string> = {
  text: '*/*',
  image: 'image/*',
  video: 'video/*',
  audio: 'audio/*',
  document: '*/*',
  location: '*/*',
  contact: '*/*',
  sticker: 'image/*',
  poll: '*/*',
  forward: '*/*',
  bulk: '*/*',
};

// Fallback MIME for when the browser leaves File.type empty (some extensions). The backend requires a
// mimetype on every base64 send, so default by the selected message category.
const fallbackMime: Record<(typeof messageTypes)[number], string> = {
  text: 'text/plain',
  image: 'image/jpeg',
  video: 'video/mp4',
  audio: 'audio/mpeg',
  document: 'application/octet-stream',
  location: 'application/octet-stream',
  contact: 'application/octet-stream',
  sticker: 'image/webp',
  poll: 'application/octet-stream',
  forward: 'application/octet-stream',
  bulk: 'application/octet-stream',
};

// Client pre-check before base64-encoding an upload. Aligned with the default request-body limit: base64
// inflates ~1.33x, so ~18 MiB raw stays under the 25 MiB BODY_SIZE_LIMIT and lets the backend reject with a
// clear 413 instead of the tab OOMing on a multi-hundred-MB pick before the request is even sent. The
// backend's MEDIA_DOWNLOAD_MAX_BYTES (default 50 MiB) stays authoritative for URL sends (fetched server-side).
const MEDIA_UPLOAD_MAX_BYTES = 18 * 1024 * 1024;

// Batch statuses that stop the progress polling (mirrors the backend BatchStatus enum).
const TERMINAL_BATCH_STATUSES: readonly BatchStatus[] = ['completed', 'cancelled', 'failed'];

export function MessageTester() {
  const { t } = useTranslation();
  useDocumentTitle(t('messageTester.title'));
  const { canWrite } = useRole();
  const { data: allSessions = [], isLoading: loadingSessions } = useSessionsQuery();
  const sessions = allSessions.filter(s => s.status === 'ready');
  const [session, setSession] = useState('');
  const [recipient, setRecipient] = useState('');
  const [recipientType, setRecipientType] = useState<'personal' | 'group'>('personal');
  const [selectedGroup, setSelectedGroup] = useState('');
  const [messageType, setMessageType] = useState<(typeof messageTypes)[number]>('text');
  const [content, setContent] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  // A locally-picked media file, read as raw base64 (the engine contract — NOT a data: URI). Mutually
  // exclusive with mediaUrl: picking a file clears the URL field; typing a URL drops the file.
  const [mediaFile, setMediaFile] = useState<{ base64: string; mimetype: string; filename: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Per-type fields for the non-media types; text/media keep using `content`/`mediaUrl` above.
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [locationDescription, setLocationDescription] = useState('');
  const [locationAddress, setLocationAddress] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactNumber, setContactNumber] = useState('');
  const [pollQuestion, setPollQuestion] = useState('');
  // WhatsApp caps polls at 2..12 options; rows are trimmed and empty ones dropped at send time.
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);
  const [allowMultipleAnswers, setAllowMultipleAnswers] = useState(false);
  const [forwardFrom, setForwardFrom] = useState('');
  const [forwardTo, setForwardTo] = useState('');
  const [forwardMessageId, setForwardMessageId] = useState('');
  const [bulkRecipients, setBulkRecipients] = useState('');
  const [bulkDelay, setBulkDelay] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  // Live bulk-batch progress, polled every ~2s while the batch runs (see startBatchPolling).
  const [batchStatus, setBatchStatus] = useState<BatchStatusResponse | null>(null);
  const [batchCancelling, setBatchCancelling] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const batchPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The session a running batch belongs to: the user may switch the selector mid-batch, and
  // poll/cancel must keep addressing the session the batch was created on.
  const batchSessionRef = useRef('');

  const { data: groups = [], isLoading: loadingGroups } = useSessionGroupsQuery(session, recipientType === 'group');

  useEffect(() => {
    if (sessions.length > 0 && !session) {
      setSession(sessions[0].id);
    }
  }, [sessions, session]);

  // Clear the group selection when the session changes so a stale group id from the previous session
  // can't be sent to; the effect below then re-seeds groups[0].id once the new session's groups load.
  useEffect(() => {
    setSelectedGroup('');
  }, [session]);

  useEffect(() => {
    if (groups.length > 0 && !selectedGroup) {
      setSelectedGroup(groups[0].id);
    }
    if (recipientType !== 'group') {
      setSelectedGroup('');
    }
  }, [groups, selectedGroup, recipientType]);

  const stopBatchPolling = () => {
    if (batchPollRef.current) {
      clearInterval(batchPollRef.current);
      batchPollRef.current = null;
    }
  };

  // Stop polling on unmount; the batch itself keeps running server-side regardless.
  useEffect(() => stopBatchPolling, []);

  const startBatchPolling = (batchSessionId: string, batchId: string) => {
    stopBatchPolling();
    batchPollRef.current = setInterval(async () => {
      try {
        const status = await messageApi.getBatchStatus(batchSessionId, batchId);
        setBatchStatus(status);
        if (TERMINAL_BATCH_STATUSES.includes(status.status)) stopBatchPolling();
      } catch {
        // A transient poll failure (network blip, backend restart) must not kill progress tracking.
      }
    }, 2000);
  };

  const handleCancelBatch = async () => {
    if (!batchStatus || !batchSessionRef.current) return;
    setBatchCancelling(true);
    setBatchError(null);
    try {
      const status = await messageApi.cancelBatch(batchSessionRef.current, batchStatus.batchId);
      setBatchStatus(prev => (prev ? { ...prev, ...status } : prev));
      stopBatchPolling();
    } catch (err) {
      setBatchError(err instanceof Error ? err.message : t('messageTester.sendFailed'));
    } finally {
      setBatchCancelling(false);
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file after it's removed
    if (!file) return;
    // Reject before base64-encoding so an oversized pick surfaces a clear error instead of OOMing the tab
    // (the backend 413 cap only applies after the whole body is uploaded).
    if (file.size > MEDIA_UPLOAD_MAX_BYTES) {
      setResponse({ success: false, timestamp: new Date().toISOString(), error: t('messageTester.fileTooLarge') });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== 'string') return;
      // readAsDataURL yields "data:<mime>;base64,<payload>"; the engine expects raw base64, so strip the prefix.
      const base64 = dataUrl.split(',')[1] ?? '';
      if (!base64) return;
      setMediaFile({ base64, mimetype: file.type || fallbackMime[messageType], filename: file.name });
      setMediaUrl('');
      if (messageType === 'document') setContent(file.name);
    };
    reader.onerror = () => {
      setResponse({ success: false, timestamp: new Date().toISOString(), error: t('messageTester.fileReadError') });
    };
    reader.readAsDataURL(file);
  };

  const isMediaMessageType = mediaMessageTypes.includes(messageType);
  const bulkRecipientList = parseBulkRecipients(bulkRecipients);
  const pollOptionsFilled = pollOptions.map(o => o.trim()).filter(o => o.length > 0);
  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  const delayMs = bulkDelay.trim() === '' ? undefined : parseInt(bulkDelay, 10);

  // Per-type required-field validation for the newer types; text/media keep their original behavior
  // (the backend stays the authoritative validator either way).
  let formValid = true;
  if (messageType === 'location') {
    formValid = !Number.isNaN(lat) && !Number.isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  } else if (messageType === 'contact') {
    formValid = contactName.trim().length > 0 && contactNumber.trim().length > 0;
  } else if (messageType === 'sticker') {
    formValid = !!mediaFile || mediaUrl.trim().length > 0;
  } else if (messageType === 'poll') {
    formValid = pollQuestion.trim().length > 0 && pollOptionsFilled.length >= 2;
  } else if (messageType === 'forward') {
    formValid = forwardTo.trim().length > 0 && forwardMessageId.trim().length > 0;
  } else if (messageType === 'bulk') {
    formValid =
      content.trim().length > 0 &&
      bulkRecipientList.length > 0 &&
      bulkRecipientList.length <= BULK_MAX_RECIPIENTS &&
      (delayMs === undefined || (!Number.isNaN(delayMs) && delayMs >= 1000 && delayMs <= 60000));
  }

  const isSendDisabled =
    !canWrite ||
    isLoading ||
    !session ||
    !formValid ||
    (messageType !== 'bulk' && (recipientType === 'group' ? !selectedGroup : !recipient));

  const handleSend = async () => {
    const targetId = recipientType === 'group' ? selectedGroup : recipient;
    if (!session || (messageType !== 'bulk' && !targetId)) return;
    setIsLoading(true);
    setResponse(null);
    // An earlier batch keeps running server-side, but its polling must not overwrite this response.
    stopBatchPolling();
    setBatchStatus(null);
    setBatchError(null);

    try {
      // For a personal recipient, let the engine resolve the number to its canonical chat id rather
      // than hand-building an engine-specific JID here (#265) — also surfaces unregistered numbers.
      // Bulk carries its own recipient list, so the shared selector's target is not resolved there.
      let chatId = targetId;
      if (messageType !== 'bulk' && recipientType !== 'group') {
        const resolved = await contactApi.checkNumber(session, targetId.replace(/[^0-9]/g, ''));
        if (!resolved.exists || !resolved.whatsappId) {
          setResponse({
            success: false,
            timestamp: new Date().toISOString(),
            error: t('messageTester.notOnWhatsApp'),
          });
          return;
        }
        chatId = resolved.whatsappId;
      }

      // Bulk is a batch, not a single send: 202 + batchId, then poll progress until terminal.
      if (messageType === 'bulk') {
        const batch = await messageApi.sendBulk(session, {
          messages: bulkRecipientList.map(recipientChatId => ({
            chatId: recipientChatId,
            type: 'text' as const,
            content: { text: content },
          })),
          ...(delayMs !== undefined ? { options: { delayBetweenMessages: delayMs } } : {}),
        });
        batchSessionRef.current = session;
        setResponse({ success: true, timestamp: new Date().toISOString(), batchId: batch.batchId });
        setBatchStatus({
          batchId: batch.batchId,
          status: 'pending',
          progress: { total: batch.totalMessages, sent: 0, failed: 0, pending: batch.totalMessages, cancelled: 0 },
        });
        startBatchPolling(session, batch.batchId);
        return;
      }

      let result: MessageResponse;
      switch (messageType) {
        case 'text':
          result = await messageApi.sendText(session, chatId, content);
          break;
        case 'image':
        case 'video':
        case 'audio':
        case 'document': {
          // sendMedia unifies URL and base64 (local file) sends; base64 wins when a file is picked. The
          // backend accepts url XOR base64 and requires a mimetype for base64 (always provided here).
          const payload: SendMediaPayload = mediaFile
            ? { base64: mediaFile.base64, mimetype: mediaFile.mimetype }
            : { url: mediaUrl };
          if ((messageType === 'image' || messageType === 'video') && content) payload.caption = content;
          if (messageType === 'document' && content) payload.filename = content;
          result = await messageApi.sendMedia(session, chatId, messageType, payload);
          break;
        }
        case 'sticker': {
          const payload: SendMediaPayload = mediaFile
            ? { base64: mediaFile.base64, mimetype: mediaFile.mimetype }
            : { url: mediaUrl };
          result = await messageApi.sendSticker(session, chatId, payload);
          break;
        }
        case 'location':
          result = await messageApi.sendLocation(session, {
            chatId,
            latitude: lat,
            longitude: lng,
            ...(locationDescription.trim() ? { description: locationDescription.trim() } : {}),
            ...(locationAddress.trim() ? { address: locationAddress.trim() } : {}),
          });
          break;
        case 'contact':
          result = await messageApi.sendContact(session, {
            chatId,
            contactName: contactName.trim(),
            contactNumber: contactNumber.trim(),
          });
          break;
        case 'poll':
          result = await messageApi.sendPoll(session, {
            chatId,
            name: pollQuestion.trim(),
            options: pollOptionsFilled,
            ...(allowMultipleAnswers ? { allowMultipleAnswers: true } : {}),
          });
          break;
        case 'forward': {
          // toChatId passes through as-is when it is a full chat ID; a bare number is resolved
          // through the same check-number flow as the main recipient.
          let toChatId = forwardTo.trim();
          if (!toChatId.includes('@')) {
            const resolvedTo = await contactApi.checkNumber(session, toChatId.replace(/[^0-9]/g, ''));
            if (!resolvedTo.exists || !resolvedTo.whatsappId) {
              setResponse({
                success: false,
                timestamp: new Date().toISOString(),
                error: t('messageTester.notOnWhatsApp'),
              });
              return;
            }
            toChatId = resolvedTo.whatsappId;
          }
          result = await messageApi.forward(session, {
            // An empty fromChatId defaults to the current (already resolved) recipient.
            fromChatId: forwardFrom.trim() || chatId,
            toChatId,
            messageId: forwardMessageId.trim(),
          });
          break;
        }
        default:
          throw new Error(`Unsupported message type: ${messageType}`);
      }

      setResponse({
        success: !!result.messageId,
        messageId: result.messageId,
        timestamp: result.timestamp ? new Date(result.timestamp * 1000).toISOString() : new Date().toISOString(),
      });
    } catch (err) {
      setResponse({
        success: false,
        timestamp: new Date().toISOString(),
        error: err instanceof Error ? err.message : t('messageTester.sendFailed'),
        status: err instanceof Error ? (err as Error & { status?: number }).status : undefined,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const batchPercent =
    batchStatus && batchStatus.progress.total > 0
      ? Math.round(
          ((batchStatus.progress.sent + batchStatus.progress.failed + batchStatus.progress.cancelled) /
            batchStatus.progress.total) *
            100,
        )
      : 0;

  if (loadingSessions) {
    return (
      <div
        className="message-tester"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="message-tester">
      <PageHeader title={t('messageTester.title')} subtitle={t('messageTester.subtitle')} />

      <div className="tester-panels">
        <div className="compose-panel">
          <h2 className="eyebrow">{t('messageTester.compose')}</h2>

          <div className="form-group">
            <label>{t('messageTester.session')}</label>
            <select value={session} onChange={e => setSession(e.target.value)}>
              {sessions.length === 0 && <option value="">{t('messageTester.noReadySessions')}</option>}
              {sessions.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.phone || t('messageTester.sessionOptionPhoneNone')})
                </option>
              ))}
            </select>
          </div>

          {/* Bulk carries its own recipient list, so the single-recipient selector is hidden there. */}
          {messageType !== 'bulk' && (
            <>
              <div className="form-group">
                <label>{t('messageTester.recipientType')}</label>
                <div className="toggle-group">
                  <button
                    className={recipientType === 'personal' ? 'active' : ''}
                    onClick={() => setRecipientType('personal')}
                  >
                    {t('messageTester.personal')}
                  </button>
                  <button
                    className={recipientType === 'group' ? 'active' : ''}
                    onClick={() => setRecipientType('group')}
                  >
                    {t('messageTester.group')}
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label>
                  {recipientType === 'group' ? t('messageTester.selectGroup') : t('messageTester.recipientPhone')}
                </label>
                {recipientType === 'group' ? (
                  <>
                    <select
                      value={selectedGroup}
                      onChange={e => setSelectedGroup(e.target.value)}
                      disabled={loadingGroups || groups.length === 0}
                    >
                      {loadingGroups && <option value="">{t('messageTester.loadingGroups')}</option>}
                      {!loadingGroups && groups.length === 0 && (
                        <option value="">{t('messageTester.noGroupsFound')}</option>
                      )}
                      {groups.map(g => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                    <span className="hint">{t('messageTester.selectGroupHint')}</span>
                  </>
                ) : (
                  <>
                    <input
                      type="text"
                      value={recipient}
                      onChange={e => setRecipient(e.target.value)}
                      placeholder="+62812345678"
                    />
                    <span className="hint">{t('messageTester.phoneHint')}</span>
                  </>
                )}
              </div>
            </>
          )}

          <div className="form-group">
            <label>{t('messageTester.messageType')}</label>
            <div className="toggle-group toggle-group-wrap">
              {messageTypes.map(type => (
                <button
                  key={type}
                  className={messageType === type ? 'active' : ''}
                  onClick={() => {
                    // A picked file's mimetype is bound to the category active at pick time, so dropping the
                    // category would route stale bytes to the wrong send-${type} endpoint — clear it.
                    if (type !== messageType) setMediaFile(null);
                    setMessageType(type);
                  }}
                >
                  {t(`messageTester.types.${type}`)}
                </button>
              ))}
            </div>
          </div>

          {messageType === 'text' && (
            <div className="form-group">
              <label>{t('messageTester.messageContent')}</label>
              <textarea
                value={content}
                onChange={e => setContent(e.target.value)}
                placeholder={t('messageTester.messagePlaceholder')}
                rows={5}
              />
            </div>
          )}

          {isMediaMessageType && (
            <>
              <div className="form-group">
                <label>{t('messageTester.mediaUrl')}</label>
                <input
                  type="text"
                  value={mediaUrl}
                  onChange={e => {
                    setMediaUrl(e.target.value);
                    if (mediaFile) setMediaFile(null);
                  }}
                  placeholder="https://example.com/file.jpg"
                  disabled={!!mediaFile}
                />
              </div>
              <div className="form-group">
                <label>{t('messageTester.uploadFile')}</label>
                {mediaFile ? (
                  <div className="file-selected">
                    <span className="file-name" title={mediaFile.filename}>
                      {mediaFile.filename}
                    </span>
                    <button type="button" className="remove-file-btn" onClick={() => setMediaFile(null)}>
                      <X size={14} /> {t('messageTester.removeFile')}
                    </button>
                  </div>
                ) : (
                  <button type="button" className="browse-btn" onClick={() => fileInputRef.current?.click()}>
                    <Upload size={14} /> {t('messageTester.browse')}
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  style={{ display: 'none' }}
                  accept={mediaAccept[messageType]}
                  onChange={handleFileChange}
                />
              </div>
              {messageType !== 'audio' && messageType !== 'sticker' && (
                <div className="form-group">
                  <label>
                    {messageType === 'document' ? t('messageTester.filename') : t('messageTester.caption')} (
                    {t('common.optional')})
                  </label>
                  <input
                    type="text"
                    value={content}
                    onChange={e => setContent(e.target.value)}
                    placeholder={
                      messageType === 'document'
                        ? t('messageTester.filenamePlaceholder')
                        : t('messageTester.captionPlaceholder')
                    }
                  />
                </div>
              )}
            </>
          )}

          {messageType === 'location' && (
            <>
              <div className="form-row">
                <div className="form-group">
                  <label>{t('messageTester.locationLatitude')}</label>
                  <input
                    type="number"
                    step="any"
                    min={-90}
                    max={90}
                    value={latitude}
                    onChange={e => setLatitude(e.target.value)}
                    placeholder="-6.2088"
                  />
                </div>
                <div className="form-group">
                  <label>{t('messageTester.locationLongitude')}</label>
                  <input
                    type="number"
                    step="any"
                    min={-180}
                    max={180}
                    value={longitude}
                    onChange={e => setLongitude(e.target.value)}
                    placeholder="106.8456"
                  />
                </div>
              </div>
              <div className="form-group">
                <label>
                  {t('messageTester.locationDescription')} ({t('common.optional')})
                </label>
                <input type="text" value={locationDescription} onChange={e => setLocationDescription(e.target.value)} />
              </div>
              <div className="form-group">
                <label>
                  {t('messageTester.locationAddress')} ({t('common.optional')})
                </label>
                <input type="text" value={locationAddress} onChange={e => setLocationAddress(e.target.value)} />
              </div>
            </>
          )}

          {messageType === 'contact' && (
            <>
              <div className="form-group">
                <label>{t('messageTester.contactName')}</label>
                <input
                  type="text"
                  value={contactName}
                  onChange={e => setContactName(e.target.value)}
                  placeholder={t('messageTester.contactNamePlaceholder')}
                />
              </div>
              <div className="form-group">
                <label>{t('messageTester.contactNumber')}</label>
                <input
                  type="text"
                  value={contactNumber}
                  onChange={e => setContactNumber(e.target.value)}
                  placeholder="+62812345678"
                />
              </div>
            </>
          )}

          {messageType === 'poll' && (
            <>
              <div className="form-group">
                <label>{t('messageTester.pollQuestion')}</label>
                <input
                  type="text"
                  value={pollQuestion}
                  onChange={e => setPollQuestion(e.target.value)}
                  placeholder={t('messageTester.pollQuestionPlaceholder')}
                />
              </div>
              <div className="form-group">
                <label>{t('messageTester.pollOptions')}</label>
                {pollOptions.map((option, index) => (
                  <div className="poll-option-row" key={index}>
                    <input
                      type="text"
                      value={option}
                      onChange={e => setPollOptions(prev => prev.map((o, i) => (i === index ? e.target.value : o)))}
                      placeholder={t('messageTester.pollOptionPlaceholder', { index: index + 1 })}
                    />
                    <button
                      type="button"
                      className="remove-option-btn"
                      onClick={() => setPollOptions(prev => prev.filter((_, i) => i !== index))}
                      disabled={pollOptions.length <= 2}
                      aria-label={t('messageTester.removeOption')}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="add-option-btn"
                  onClick={() => setPollOptions(prev => [...prev, ''])}
                  disabled={pollOptions.length >= 12}
                >
                  <Plus size={14} /> {t('messageTester.addOption')}
                </button>
                <span className="hint">{t('messageTester.pollOptionsHint')}</span>
              </div>
              <div className="form-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={allowMultipleAnswers}
                    onChange={e => setAllowMultipleAnswers(e.target.checked)}
                  />
                  {t('messageTester.allowMultipleAnswers')}
                </label>
              </div>
            </>
          )}

          {messageType === 'forward' && (
            <>
              <div className="form-group">
                <label>
                  {t('messageTester.forwardFromChatId')} ({t('common.optional')})
                </label>
                <input
                  type="text"
                  value={forwardFrom}
                  onChange={e => setForwardFrom(e.target.value)}
                  placeholder={
                    (recipientType === 'group' ? selectedGroup : recipient) || t('messageTester.forwardFromPlaceholder')
                  }
                />
                <span className="hint">{t('messageTester.forwardFromHint')}</span>
              </div>
              <div className="form-group">
                <label>{t('messageTester.forwardToChatId')}</label>
                <input
                  type="text"
                  value={forwardTo}
                  onChange={e => setForwardTo(e.target.value)}
                  placeholder={t('messageTester.forwardToPlaceholder')}
                />
              </div>
              <div className="form-group">
                <label>{t('messageTester.forwardMessageId')}</label>
                <input type="text" value={forwardMessageId} onChange={e => setForwardMessageId(e.target.value)} />
                <span className="hint">{t('messageTester.forwardMessageIdHint')}</span>
              </div>
            </>
          )}

          {messageType === 'bulk' && (
            <>
              <div className="form-group">
                <label>{t('messageTester.bulkRecipients')}</label>
                <textarea
                  value={bulkRecipients}
                  onChange={e => setBulkRecipients(e.target.value)}
                  placeholder={t('messageTester.bulkRecipientsPlaceholder')}
                  rows={4}
                />
                <span className="hint">
                  {t('messageTester.bulkRecipientsHint')} ·{' '}
                  {t('messageTester.bulkRecipientsCount', { count: bulkRecipientList.length })}
                </span>
              </div>
              <div className="form-group">
                <label>{t('messageTester.messageContent')}</label>
                <textarea
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  placeholder={t('messageTester.messagePlaceholder')}
                  rows={4}
                />
              </div>
              <div className="form-group">
                <label>
                  {t('messageTester.bulkDelay')} ({t('common.optional')})
                </label>
                <input
                  type="number"
                  min={1000}
                  max={60000}
                  step={500}
                  value={bulkDelay}
                  onChange={e => setBulkDelay(e.target.value)}
                  placeholder="3000"
                />
                <span className="hint">{t('messageTester.bulkDelayHint')}</span>
              </div>
            </>
          )}

          <button className="send-btn" onClick={handleSend} disabled={isSendDisabled}>
            {isLoading ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
            {isLoading ? t('messageTester.sending') : canWrite ? t('messageTester.send') : t('messageTester.viewOnly')}
          </button>
        </div>

        <div className="response-panel">
          <h2 className="eyebrow">{t('messageTester.responseTitle')}</h2>

          {response ? (
            <>
              <div className={`response-status ${response.success ? 'success' : 'error'}`}>
                {response.success ? (
                  <>
                    <CheckCircle size={20} />
                    <span>{t('messageTester.successLabel')}</span>
                  </>
                ) : (
                  <>
                    <XCircle size={20} />
                    <span>{t('messageTester.failedLabel')}</span>
                  </>
                )}
                {/* `<code>` earns both halves from index.css with no new rule: a monospace face, and the
                    LTR isolation that stops the bidi algorithm reordering the number against an RTL label
                    (ar/he). The `.mono` class only carries the second — its monospacing lives on compound
                    selectors like `.detail-value.mono`, which a bare span never matches. */}
                {response.status !== undefined && <code>HTTP {response.status}</code>}
              </div>

              <div className="response-details">
                <div className="detail-row">
                  <span className="detail-label">{t('messageTester.response.timestamp')}</span>
                  <span className="detail-value">{response.timestamp}</span>
                </div>
                {response.messageId && (
                  <div className="detail-row">
                    <span className="detail-label">{t('messageTester.response.messageId')}</span>
                    <span className="detail-value mono">{response.messageId}</span>
                  </div>
                )}
                {response.batchId && (
                  <div className="detail-row">
                    <span className="detail-label">{t('messageTester.response.batchId')}</span>
                    <span className="detail-value mono">{response.batchId}</span>
                  </div>
                )}
                {response.error && (
                  <div className="detail-row">
                    <span className="detail-label">{t('messageTester.response.error')}</span>
                    <span className="detail-value" style={{ color: 'var(--error)' }}>
                      {response.error}
                    </span>
                  </div>
                )}
              </div>

              {response.batchId && batchStatus && response.batchId === batchStatus.batchId && (
                <div className="batch-status">
                  <div className="batch-status-row">
                    <span className={`batch-badge ${batchStatus.status}`}>
                      {t(`messageTester.batch.status.${batchStatus.status}`)}
                    </span>
                    {(batchStatus.status === 'pending' || batchStatus.status === 'processing') && (
                      <button
                        type="button"
                        className="batch-cancel-btn"
                        onClick={handleCancelBatch}
                        disabled={batchCancelling}
                      >
                        {batchCancelling ? t('messageTester.batch.cancelling') : t('messageTester.batch.cancel')}
                      </button>
                    )}
                  </div>
                  <div className="batch-progress-bar">
                    <div className="batch-progress-fill" style={{ width: `${batchPercent}%` }} />
                  </div>
                  <div className="batch-progress-line">
                    {t('messageTester.batch.progress', {
                      sent: batchStatus.progress.sent,
                      failed: batchStatus.progress.failed,
                      pending: batchStatus.progress.pending,
                      total: batchStatus.progress.total,
                    })}
                  </div>
                  {batchError && <div className="batch-error">{batchError}</div>}
                </div>
              )}

              <div className="response-json">
                <pre>{JSON.stringify(response, null, 2)}</pre>
              </div>
            </>
          ) : (
            <div className="response-empty">
              <p>{t('messageTester.responseEmpty')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
