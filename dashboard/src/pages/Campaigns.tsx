import { useEffect, useMemo, useRef, useState } from 'react';
import { Megaphone, Send, Loader2, XCircle, CheckCircle2, AlertTriangle, Users, Clock } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../hooks/useToast';
import { useXenwa } from '../components/XenwaProvider';
import { sessionApi, type BatchStatusResponse } from '../services/api';
import { xenwaApi, accountLabel, can, type XenwaAccount } from '../services/xenwa';
import './Campaigns.css';

interface Recipient {
  chatId: string;
  name: string;
}

const MAX_RECIPIENTS = 100;

/** Parse "phone[, name]" lines. Digits only for the number; a group id (…@g.us) passes through. */
function parseRecipients(text: string): { valid: Recipient[]; invalid: string[] } {
  const valid: Recipient[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [first, ...rest] = line.split(/[,;\t]/);
    const name = rest.join(' ').trim();
    let chatId: string;
    if (/@(c\.us|g\.us|lid)$/.test(first.trim())) chatId = first.trim();
    else {
      const digits = first.replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15) {
        invalid.push(line);
        continue;
      }
      chatId = `${digits}@c.us`;
    }
    if (seen.has(chatId)) continue;
    seen.add(chatId);
    valid.push({ chatId, name });
  }
  return { valid, invalid };
}

export function Campaigns() {
  const toast = useToast();
  const { me } = useXenwa();
  const [legacySessions, setLegacySessions] = useState<XenwaAccount[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [recipientsText, setRecipientsText] = useState('');
  const [message, setMessage] = useState('Hi {name}, ');
  const [delay, setDelay] = useState(4);
  const [sending, setSending] = useState(false);
  const [batch, setBatch] = useState<BatchStatusResponse | null>(null);
  const pollRef = useRef<number | null>(null);

  // Plain API-key logins (no XenWA user) still get a picker from the classic session list.
  useEffect(() => {
    if (me?.managed || me?.isAdmin) return;
    sessionApi
      .list()
      .then(list =>
        setLegacySessions(
          list.map(s => ({
            sessionId: s.id,
            name: s.name,
            phone: s.phone ?? null,
            pushName: s.pushName ?? null,
            status: s.status,
            role: 'admin' as const,
            permissions: ['read', 'send', 'campaigns', 'contacts', 'settings'],
            ownerEmail: null,
            billing: null,
          })),
        ),
      )
      .catch(() => setLegacySessions([]));
  }, [me]);

  const accounts = useMemo(
    () => (me?.accounts?.length ? me.accounts : legacySessions).filter(a => can(a, 'campaigns')),
    [me, legacySessions],
  );

  useEffect(() => {
    if (!sessionId && accounts.length) setSessionId(accounts[0].sessionId);
  }, [accounts, sessionId]);

  useEffect(
    () => () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    },
    [],
  );

  const parsed = useMemo(() => parseRecipients(recipientsText), [recipientsText]);

  const poll = (sid: string, batchId: string) => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      try {
        const status = await xenwaApi.batchStatus(sid, batchId);
        setBatch(status);
        if (['completed', 'cancelled', 'failed'].includes(status.status) && pollRef.current) {
          window.clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch {
        /* keep polling */
      }
    }, 2500);
  };

  const send = async () => {
    if (!sessionId || !parsed.valid.length || !message.trim()) return;
    if (parsed.valid.length > MAX_RECIPIENTS) {
      toast.error(`Up to ${MAX_RECIPIENTS} recipients per campaign.`);
      return;
    }
    if (!window.confirm(`Send this message to ${parsed.valid.length} recipient(s)?`)) return;
    setSending(true);
    try {
      const res = await xenwaApi.sendBulk(sessionId, {
        messages: parsed.valid.map(r => ({
          chatId: r.chatId,
          type: 'text',
          content: { text: message.replace(/\{name\}/g, r.name || 'there') },
        })),
        options: { delayBetweenMessages: Math.max(1, delay) * 1000, randomizeDelay: true, stopOnError: false },
      });
      toast.success(`Campaign started: ${res.totalMessages} messages queued.`);
      setBatch({
        batchId: res.batchId,
        status: 'pending',
        progress: { total: res.totalMessages, sent: 0, failed: 0, pending: res.totalMessages, cancelled: 0 },
        results: [],
      });
      poll(sessionId, res.batchId);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const cancel = async () => {
    if (!batch) return;
    try {
      setBatch(await xenwaApi.cancelBatch(sessionId, batch.batchId));
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const pct = batch
    ? Math.round(((batch.progress.sent + batch.progress.failed) / Math.max(1, batch.progress.total)) * 100)
    : 0;
  const running = batch && !['completed', 'cancelled', 'failed'].includes(batch.status);

  return (
    <div className="campaigns-page">
      <PageHeader title="Campaigns" subtitle="Send a personalised broadcast from one of your WhatsApp numbers." />

      {accounts.length === 0 ? (
        <div className="glass-card campaigns-empty">
          <Megaphone size={32} />
          <p>You have no number with the Campaigns permission. Ask the number owner to grant it.</p>
        </div>
      ) : (
        <div className="campaigns-layout">
          <section className="glass-card campaigns-form">
            <label className="campaigns-field">
              <span>From number</span>
              <select value={sessionId} onChange={e => setSessionId(e.target.value)}>
                {accounts.map(a => (
                  <option key={a.sessionId} value={a.sessionId}>
                    {accountLabel(a)} {a.status !== 'ready' ? `(${a.status})` : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="campaigns-field">
              <span>
                Recipients <small>one per line: phone, name (max {MAX_RECIPIENTS})</small>
              </span>
              <textarea
                rows={7}
                value={recipientsText}
                onChange={e => setRecipientsText(e.target.value)}
                placeholder={'919876543210, Priya\n14155550100, Alex'}
              />
              <span className="campaigns-meta">
                <Users size={13} /> {parsed.valid.length} valid
                {parsed.invalid.length > 0 && (
                  <em>
                    {' '}
                    · <AlertTriangle size={13} /> {parsed.invalid.length} skipped
                  </em>
                )}
              </span>
            </label>

            <label className="campaigns-field">
              <span>
                Message <small>use {'{name}'} to personalise</small>
              </span>
              <textarea rows={5} value={message} onChange={e => setMessage(e.target.value)} maxLength={4000} />
            </label>

            <label className="campaigns-field campaigns-field--inline">
              <span>
                <Clock size={14} /> Seconds between messages
              </span>
              <input
                type="number"
                min={1}
                max={60}
                value={delay}
                onChange={e => setDelay(Number(e.target.value) || 1)}
              />
            </label>

            <button
              className="btn-primary campaigns-send"
              onClick={() => void send()}
              disabled={sending || !!running || !parsed.valid.length || !message.trim()}
            >
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />} Send campaign
            </button>
            <p className="campaigns-hint">
              Only message people who expect to hear from you. Pacing keeps your number healthy.
            </p>
          </section>

          <section className="glass-card campaigns-status">
            <h3>
              <Megaphone size={16} /> Progress
            </h3>
            {!batch ? (
              <p className="campaigns-hint">Start a campaign to see live delivery progress here.</p>
            ) : (
              <>
                <div
                  className="campaigns-bar"
                  role="progressbar"
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div style={{ width: `${pct}%` }} />
                </div>
                <div className="campaigns-counts">
                  <span>
                    <CheckCircle2 size={14} /> {batch.progress.sent} sent
                  </span>
                  <span>
                    <XCircle size={14} /> {batch.progress.failed} failed
                  </span>
                  <span>{batch.progress.pending} pending</span>
                  <strong>{batch.status}</strong>
                </div>
                {running && (
                  <button className="btn-secondary" onClick={() => void cancel()}>
                    <XCircle size={15} /> Cancel remaining
                  </button>
                )}
                <ul className="campaigns-results">
                  {batch.results.slice(-50).map(r => (
                    <li key={r.chatId} className={`is-${r.status}`}>
                      <span>{r.chatId.replace(/@.*/, '')}</span>
                      <span>{r.error?.message ?? r.status}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
