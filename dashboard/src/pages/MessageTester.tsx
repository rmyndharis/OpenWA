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
import { parseBulkRecipients, BULK_MAX_RECIPIENTS, BULK_RECIPIENTS_FILE_MAX_BYTES } from '../utils/bulkRecipients';
import {
  BULK_CAPTION_MAX_LENGTH,
  BULK_INLINE_MEDIA_MAX_BYTES,
  BULK_MEDIA_KINDS,
  buildBulkMessages,
  captionLength,
  formatFileSize,
  inlineMediaBudgetBytes,
  isHttpMediaUrl,
  mediaKindFromMime,
  mediaKindFromUrl,
  toBulkAttachment,
  type BulkMediaKind,
} from '../utils/bulkMedia';
import { PageHeader } from '../components/PageHeader';
import { GroupPicker } from '../components/GroupPicker';
import { groupLabel, isGatewayRefusal, planGroupSend } from '../utils/groupSelection';
import { sendSequentially } from '../utils/sendSequentially';
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
  groups?: {
    sent: number;
    total: number;
    failures: { id: string; name: string; error: string }[];
    notSent: number;
    stoppedBy?: 'abort' | 'refusal';
    refusedWith?: number;
  };
}

const GROUP_SEND_DELAY_MS = 3000;

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
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [groupSendProgress, setGroupSendProgress] = useState<{ current: number; total: number } | null>(null);
  const [groupSendCancelling, setGroupSendCancelling] = useState(false);
  const groupSendAbort = useRef<AbortController | null>(null);
  const [messageType, setMessageType] = useState<(typeof messageTypes)[number]>('text');
  const [content, setContent] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  // A locally-picked media file, read as raw base64 (the engine contract — NOT a data: URI). Mutually
  // exclusive with mediaUrl: picking a file clears the URL field; typing a URL drops the file.
  const [mediaFile, setMediaFile] = useState<{ base64: string; mimetype: string; filename: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bulkFileInputRef = useRef<HTMLInputElement>(null);
  // Monotonic token invalidating an in-flight FileReader: a second pick, a URL edit, a removal,
  // or an unmount before `onload` fires must win over the late-arriving bytes — otherwise the
  // slower read overwrites the newer state (and re-clears a URL the user just typed).
  const mediaReadSeq = useRef(0);
  const clearMediaFile = () => {
    mediaReadSeq.current += 1;
    setMediaFile(null);
  };
  useEffect(() => {
    return () => {
      mediaReadSeq.current += 1;
    };
  }, []);
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
  const [bulkMediaKind, setBulkMediaKind] = useState<BulkMediaKind>('document');
  const [bulkMediaKindChosen, setBulkMediaKindChosen] = useState(false);
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

  useEffect(() => {
    setSelectedGroups([]);
  }, [session, recipientType]);

  useEffect(() => () => groupSendAbort.current?.abort(), []);

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

  const handleBulkFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    // Reject before reading, mirroring the media pick above: FileReader would materialize the whole
    // file as a string before any backend cap could weigh in.
    if (file.size > BULK_RECIPIENTS_FILE_MAX_BYTES) {
      setResponse({
        success: false,
        timestamp: new Date().toISOString(),
        error: t('messageTester.recipientsFileTooLarge'),
      });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result;
      if (typeof text !== 'string' || !text.trim()) return;
      setBulkRecipients(prev => (prev.trim() ? `${prev.trimEnd()}\n` : '') + text.trim());
    };
    reader.onerror = () => {
      setResponse({ success: false, timestamp: new Date().toISOString(), error: t('messageTester.fileReadError') });
    };
    reader.readAsText(file);
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
    const myRead = ++mediaReadSeq.current;
    const reader = new FileReader();
    reader.onload = () => {
      // A newer pick, a URL edit, a removal, or an unmount since the read started supersedes
      // these bytes — drop them.
      if (mediaReadSeq.current !== myRead) return;
      const dataUrl = reader.result;
      if (typeof dataUrl !== 'string') return;
      // readAsDataURL yields "data:<mime>;base64,<payload>"; the engine expects raw base64, so strip the prefix.
      const base64 = dataUrl.split(',')[1] ?? '';
      if (!base64) return;
      const mimetype = file.type || fallbackMime[messageType];
      setMediaFile({ base64, mimetype, filename: file.name });
      setMediaUrl('');
      if (messageType === 'document') setContent(file.name);
      if (messageType === 'bulk') {
        setBulkMediaKind(mediaKindFromMime(mimetype));
        setBulkMediaKindChosen(false);
      }
    };
    reader.onerror = () => {
      if (mediaReadSeq.current !== myRead) return;
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
  const bulkAttachment = messageType === 'bulk' ? toBulkAttachment(bulkMediaKind, mediaFile, mediaUrl) : null;
  const bulkMediaTooLarge =
    messageType === 'bulk' &&
    !!mediaFile &&
    mediaFile.base64.length * bulkRecipientList.length > BULK_INLINE_MEDIA_MAX_BYTES;
  const bulkMediaUrlInvalid =
    messageType === 'bulk' && !mediaFile && mediaUrl.trim() !== '' && !isHttpMediaUrl(mediaUrl);
  // Audio goes out without a caption (the bulk service does not forward one), so text next to an audio
  // attachment would be dropped while the batch reports success. Refuse it instead of sending half.
  const bulkAudioWithText = bulkAttachment?.kind === 'audio' && content.trim().length > 0;
  const bulkCaptionTooLong =
    bulkAttachment !== null && bulkAttachment.kind !== 'audio' && captionLength(content) > BULK_CAPTION_MAX_LENGTH;

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
      (content.trim().length > 0 || bulkAttachment !== null) &&
      !bulkMediaTooLarge &&
      !bulkMediaUrlInvalid &&
      !bulkAudioWithText &&
      !bulkCaptionTooLong &&
      bulkRecipientList.length > 0 &&
      bulkRecipientList.length <= BULK_MAX_RECIPIENTS &&
      (delayMs === undefined || (!Number.isNaN(delayMs) && delayMs >= 1000 && delayMs <= 60000));
  }

  const isSendDisabled =
    !canWrite ||
    isLoading ||
    !session ||
    !formValid ||
    (messageType !== 'bulk' && (recipientType === 'group' ? selectedGroups.length === 0 : !recipient));

  const isGroupSending = groupSendProgress !== null;

  const sendToGroups = async (chatIds: string[], sendTo: (chatId: string) => Promise<MessageResponse>) => {
    const controller = new AbortController();
    groupSendAbort.current = controller;
    const labels = new Map(groups.map(group => [group.id, groupLabel(group)]));
    try {
      const outcome = await sendSequentially(
        chatIds,
        async chatId => {
          const result = await sendTo(chatId);
          if (!result.messageId) throw new Error(t('messageTester.sendFailed'));
        },
        {
          delayMs: GROUP_SEND_DELAY_MS,
          signal: controller.signal,
          stopOn: isGatewayRefusal,
          onProgress: (current, total) => setGroupSendProgress({ current, total }),
        },
      );
      setResponse({
        success: outcome.sent === chatIds.length,
        timestamp: new Date().toISOString(),
        groups: {
          sent: outcome.sent,
          total: chatIds.length,
          failures: outcome.failures.map(({ target, error }) => ({
            id: target,
            name: labels.get(target) ?? target,
            error,
          })),
          notSent: outcome.notAttempted.length,
          stoppedBy: outcome.stoppedBy,
          refusedWith: outcome.stoppedBy === 'refusal' ? outcome.failures.at(-1)?.status : undefined,
        },
      });
    } finally {
      groupSendAbort.current = null;
      setGroupSendProgress(null);
      setGroupSendCancelling(false);
    }
  };

  const cancelGroupSend = () => {
    setGroupSendCancelling(true);
    groupSendAbort.current?.abort();
  };

  const handleSend = async () => {
    const targetId = recipientType === 'group' ? (selectedGroups[0] ?? '') : recipient;
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
          messages: buildBulkMessages(bulkRecipientList, content, bulkAttachment),
          ...(delayMs !== undefined ? { options: { delayBetweenMessages: delayMs } } : {}),
        });
        batchSessionRef.current = session;
        setResponse({ success: true, timestamp: new Date().toISOString(), batchId: batch.batchId });
        setBatchStatus({
          batchId: batch.batchId,
          status: 'pending',
          progress: { total: batch.totalMessages, sent: 0, failed: 0, pending: batch.totalMessages, cancelled: 0 },
          results: [],
        });
        startBatchPolling(session, batch.batchId);
        return;
      }

      const sendTo = async (target: string): Promise<MessageResponse> => {
        switch (messageType) {
          case 'text':
            return messageApi.sendText(session, target, content);
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
            return messageApi.sendMedia(session, target, messageType, payload);
          }
          case 'sticker': {
            const payload: SendMediaPayload = mediaFile
              ? { base64: mediaFile.base64, mimetype: mediaFile.mimetype }
              : { url: mediaUrl };
            return messageApi.sendSticker(session, target, payload);
          }
          case 'location':
            return messageApi.sendLocation(session, {
              chatId: target,
              latitude: lat,
              longitude: lng,
              ...(locationDescription.trim() ? { description: locationDescription.trim() } : {}),
              ...(locationAddress.trim() ? { address: locationAddress.trim() } : {}),
            });
          case 'contact':
            return messageApi.sendContact(session, {
              chatId: target,
              contactName: contactName.trim(),
              contactNumber: contactNumber.trim(),
            });
          case 'poll':
            return messageApi.sendPoll(session, {
              chatId: target,
              name: pollQuestion.trim(),
              options: pollOptionsFilled,
              ...(allowMultipleAnswers ? { allowMultipleAnswers: true } : {}),
            });
          case 'forward': {
            // toChatId passes through as-is when it is a full chat ID; a bare number is resolved
            // through the same check-number flow as the main recipient.
            let toChatId = forwardTo.trim();
            if (!toChatId.includes('@')) {
              const resolvedTo = await contactApi.checkNumber(session, toChatId.replace(/[^0-9]/g, ''));
              if (!resolvedTo.exists || !resolvedTo.whatsappId) throw new Error(t('messageTester.notOnWhatsApp'));
              toChatId = resolvedTo.whatsappId;
            }
            return messageApi.forward(session, {
              // An empty fromChatId defaults to the current (already resolved) recipient.
              fromChatId: forwardFrom.trim() || target,
              toChatId,
              messageId: forwardMessageId.trim(),
            });
          }
          default:
            throw new Error(`Unsupported message type: ${messageType}`);
        }
      };

      const plan = recipientType === 'group' ? planGroupSend(selectedGroups, messageType) : null;
      if (plan?.mode === 'sequential') {
        await sendToGroups(plan.chatIds, sendTo);
        return;
      }

      const result = await sendTo(chatId);

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

  const optionalInBulk = messageType === 'bulk' ? ` (${t('common.optional')})` : '';
  const mediaSourceFields = (
    <>
      <div className="form-group">
        <label htmlFor="mt-3">
          {t('messageTester.mediaUrl')}
          {optionalInBulk}
        </label>
        <input
          id="mt-3"
          type="text"
          value={mediaUrl}
          onChange={e => {
            setMediaUrl(e.target.value);
            // Typing a URL supersedes the file: drop the picked file AND any read still
            // in flight (its late onload would otherwise re-clear this URL).
            mediaReadSeq.current += 1;
            if (mediaFile) setMediaFile(null);
            if (messageType === 'bulk') {
              if (!e.target.value.trim()) setBulkMediaKindChosen(false);
              else if (!bulkMediaKindChosen) setBulkMediaKind(mediaKindFromUrl(e.target.value));
            }
          }}
          placeholder="https://example.com/file.jpg"
          disabled={!!mediaFile}
        />
        {messageType === 'bulk' && (
          <span className="hint error" role="status">
            {bulkMediaUrlInvalid ? t('messageTester.bulkMediaUrlInvalid') : ''}
          </span>
        )}
      </div>
      <div className="form-group">
        <label>
          {t('messageTester.uploadFile')}
          {optionalInBulk}
        </label>
        {mediaFile ? (
          <div className="file-selected">
            <span className="file-name" title={mediaFile.filename}>
              {mediaFile.filename}
            </span>
            <button type="button" className="remove-file-btn" onClick={clearMediaFile}>
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
        {messageType === 'bulk' && (
          <span className={bulkMediaTooLarge ? 'hint error' : 'hint'} role="status">
            {bulkMediaTooLarge
              ? t('messageTester.bulkMediaTooLarge', {
                  count: bulkRecipientList.length,
                  size: formatFileSize(inlineMediaBudgetBytes(bulkRecipientList.length)),
                })
              : t('messageTester.bulkMediaHint')}
          </span>
        )}
      </div>
    </>
  );

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
            <label htmlFor="mt-1">{t('messageTester.session')}</label>
            <select id="mt-1" value={session} onChange={e => setSession(e.target.value)} disabled={isGroupSending}>
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
                {/* A caption, not a label: it names the group, and there is no single control to bind
                    it to. The buttons are exclusive choices, so each reports its own pressed state. */}
                <span className="group-label" id="recipient-type-label">
                  {t('messageTester.recipientType')}
                </span>
                <div className="toggle-group" role="group" aria-labelledby="recipient-type-label">
                  <button
                    type="button"
                    aria-pressed={recipientType === 'personal'}
                    className={recipientType === 'personal' ? 'active' : ''}
                    onClick={() => setRecipientType('personal')}
                    disabled={isGroupSending}
                  >
                    {t('messageTester.personal')}
                  </button>
                  <button
                    type="button"
                    aria-pressed={recipientType === 'group'}
                    className={recipientType === 'group' ? 'active' : ''}
                    onClick={() => setRecipientType('group')}
                    disabled={isGroupSending}
                  >
                    {t('messageTester.group')}
                  </button>
                </div>
              </div>

              <div className="form-group">
                {recipientType === 'group' ? (
                  <>
                    <span className="group-label" id="group-picker-label">
                      {t('messageTester.selectGroup')}
                    </span>
                    <GroupPicker
                      groups={groups}
                      selectedIds={selectedGroups}
                      onChange={setSelectedGroups}
                      loading={loadingGroups}
                      limit={BULK_MAX_RECIPIENTS}
                      labelledBy="group-picker-label"
                      disabled={isGroupSending}
                    />
                    <span className="hint">
                      {messageType === 'forward'
                        ? t('messageTester.forwardUsesFirstGroup')
                        : t('messageTester.selectGroupHint')}
                    </span>
                  </>
                ) : (
                  <>
                    <label htmlFor="mt-13">{t('messageTester.recipientPhone')}</label>
                    <input
                      id="mt-13"
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

          {/* A multi-group run sends what was on screen when it started, so the fields are locked until it
              ends or is cancelled; Cancel sits outside, so it stays usable. */}
          <fieldset className="composer-fields" disabled={isGroupSending}>
            <div className="form-group">
              <span className="group-label" id="message-type-label">
                {t('messageTester.messageType')}
              </span>
              <div className="toggle-group toggle-group-wrap" role="group" aria-labelledby="message-type-label">
                {messageTypes.map(type => (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={messageType === type}
                    className={messageType === type ? 'active' : ''}
                    onClick={() => {
                      // A picked file's mimetype is bound to the category active at pick time, so dropping the
                      // category would route stale bytes to the wrong send-${type} endpoint — clear it.
                      if (type !== messageType) {
                        clearMediaFile();
                        if (type === 'bulk' || messageType === 'bulk') {
                          setMediaUrl('');
                          setBulkMediaKindChosen(false);
                        }
                      }
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
                <label htmlFor="mt-2">{t('messageTester.messageContent')}</label>
                <textarea
                  id="mt-2"
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  placeholder={t('messageTester.messagePlaceholder')}
                  rows={5}
                />
              </div>
            )}

            {isMediaMessageType && (
              <>
                {mediaSourceFields}
                {messageType !== 'audio' && messageType !== 'sticker' && (
                  <div className="form-group">
                    <label htmlFor="mt-14">
                      {messageType === 'document' ? t('messageTester.filename') : t('messageTester.caption')} (
                      {t('common.optional')})
                    </label>
                    <input
                      id="mt-14"
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
                    <label htmlFor="mt-4">{t('messageTester.locationLatitude')}</label>
                    <input
                      id="mt-4"
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
                    <label htmlFor="mt-5">{t('messageTester.locationLongitude')}</label>
                    <input
                      id="mt-5"
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
                  <label htmlFor="mt-15">
                    {t('messageTester.locationDescription')} ({t('common.optional')})
                  </label>
                  <input
                    id="mt-15"
                    type="text"
                    value={locationDescription}
                    onChange={e => setLocationDescription(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="mt-16">
                    {t('messageTester.locationAddress')} ({t('common.optional')})
                  </label>
                  <input
                    id="mt-16"
                    type="text"
                    value={locationAddress}
                    onChange={e => setLocationAddress(e.target.value)}
                  />
                </div>
              </>
            )}

            {messageType === 'contact' && (
              <>
                <div className="form-group">
                  <label htmlFor="mt-6">{t('messageTester.contactName')}</label>
                  <input
                    id="mt-6"
                    type="text"
                    value={contactName}
                    onChange={e => setContactName(e.target.value)}
                    placeholder={t('messageTester.contactNamePlaceholder')}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="mt-7">{t('messageTester.contactNumber')}</label>
                  <input
                    id="mt-7"
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
                  <label htmlFor="mt-8">{t('messageTester.pollQuestion')}</label>
                  <input
                    id="mt-8"
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
                  <label htmlFor="mt-17">
                    {t('messageTester.forwardFromChatId')} ({t('common.optional')})
                  </label>
                  <input
                    id="mt-17"
                    type="text"
                    value={forwardFrom}
                    onChange={e => setForwardFrom(e.target.value)}
                    placeholder={
                      (recipientType === 'group' ? selectedGroups[0] : recipient) ||
                      t('messageTester.forwardFromPlaceholder')
                    }
                  />
                  <span className="hint">{t('messageTester.forwardFromHint')}</span>
                </div>
                <div className="form-group">
                  <label htmlFor="mt-9">{t('messageTester.forwardToChatId')}</label>
                  <input
                    id="mt-9"
                    type="text"
                    value={forwardTo}
                    onChange={e => setForwardTo(e.target.value)}
                    placeholder={t('messageTester.forwardToPlaceholder')}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="mt-10">{t('messageTester.forwardMessageId')}</label>
                  <input
                    id="mt-10"
                    type="text"
                    value={forwardMessageId}
                    onChange={e => setForwardMessageId(e.target.value)}
                  />
                  <span className="hint">{t('messageTester.forwardMessageIdHint')}</span>
                </div>
              </>
            )}

            {messageType === 'bulk' && (
              <>
                <div className="form-group">
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '0.5rem',
                    }}
                  >
                    <label htmlFor="mt-11" style={{ marginBottom: 0 }}>
                      {t('messageTester.bulkRecipients')}
                    </label>
                    <button type="button" className="browse-btn" onClick={() => bulkFileInputRef.current?.click()}>
                      <Upload size={14} /> {t('messageTester.bulkRecipientsUpload')}
                    </button>
                    <input
                      ref={bulkFileInputRef}
                      type="file"
                      accept=".txt,.csv"
                      style={{ display: 'none' }}
                      onChange={handleBulkFileChange}
                    />
                  </div>
                  <textarea
                    id="mt-11"
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
                  <label htmlFor="mt-12">{t('messageTester.messageContent')}</label>
                  <textarea
                    id="mt-12"
                    value={content}
                    onChange={e => setContent(e.target.value)}
                    placeholder={t('messageTester.messagePlaceholder')}
                    rows={4}
                  />
                  <span className="hint error" role="status">
                    {bulkAudioWithText
                      ? t('messageTester.bulkAudioNoCaption')
                      : bulkCaptionTooLong
                        ? t('messageTester.bulkCaptionTooLong', {
                            max: BULK_CAPTION_MAX_LENGTH,
                            count: captionLength(content),
                          })
                        : ''}
                  </span>
                </div>
                {mediaSourceFields}
                {bulkAttachment && (
                  <div className="form-group">
                    <span className="group-label" id="bulk-media-kind-label">
                      {t('messageTester.bulkMediaKind')}
                    </span>
                    <div
                      className="toggle-group toggle-group-wrap bulk-media-kind"
                      role="group"
                      aria-labelledby="bulk-media-kind-label"
                    >
                      {BULK_MEDIA_KINDS.map(kind => (
                        <button
                          key={kind}
                          type="button"
                          aria-pressed={bulkMediaKind === kind}
                          className={bulkMediaKind === kind ? 'active' : ''}
                          onClick={() => {
                            setBulkMediaKind(kind);
                            setBulkMediaKindChosen(true);
                          }}
                        >
                          {t(`messageTester.types.${kind}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="form-group">
                  <label htmlFor="mt-18">
                    {t('messageTester.bulkDelay')} ({t('common.optional')})
                  </label>
                  <input
                    id="mt-18"
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
          </fieldset>

          <button className="send-btn" onClick={handleSend} disabled={isSendDisabled}>
            {isLoading ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
            {isLoading ? t('messageTester.sending') : canWrite ? t('messageTester.send') : t('messageTester.viewOnly')}
          </button>
          <div className="group-send-status">
            <span role="status">{groupSendProgress ? t('messageTester.sendingProgress', groupSendProgress) : ''}</span>
            {isGroupSending && (
              <button
                type="button"
                className="batch-cancel-btn"
                onClick={cancelGroupSend}
                disabled={groupSendCancelling}
              >
                {groupSendCancelling ? t('messageTester.batch.cancelling') : t('common.cancel')}
              </button>
            )}
          </div>
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
                {response.groups && (
                  <div className="detail-row">
                    <span className="detail-label">{t('messageTester.response.groups')}</span>
                    <span className="detail-value">
                      {t('messageTester.groupsSentSummary', {
                        sent: response.groups.sent,
                        total: response.groups.total,
                      })}
                    </span>
                  </div>
                )}
                {response.groups && response.groups.failures.length > 0 && (
                  <div className="detail-row group-failures">
                    <span className="detail-label">{t('messageTester.response.error')}</span>
                    <ul className="detail-value">
                      {response.groups.failures.map(failure => (
                        <li key={failure.id}>
                          <strong>{failure.name}</strong>: {failure.error}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {response.groups && response.groups.notSent > 0 && (
                  <div className="detail-row">
                    <span className="detail-label">{t('messageTester.response.notSent')}</span>
                    <span className="detail-value">
                      {response.groups.stoppedBy === 'refusal'
                        ? t('messageTester.groupSendStopped', {
                            count: response.groups.notSent,
                            status: response.groups.refusedWith,
                          })
                        : t('messageTester.groupSendCancelled', { count: response.groups.notSent })}
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
