import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Smartphone,
  Users,
  Plus,
  Coins,
  CalendarClock,
  ShieldCheck,
  Crown,
  UserPlus,
  Trash2,
  Loader2,
  AlertTriangle,
  MessageSquare,
  ExternalLink,
  RefreshCw,
  Mail,
} from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { useToast } from '../hooks/useToast';
import { useXenwa } from '../components/XenwaProvider';
import {
  xenwaApi,
  PERMISSION_LABELS,
  accountLabel,
  type XenwaAccount,
  type XenwaPermission,
  type XenwaTeamMember,
} from '../services/xenwa';
import './XenwaNumbers.css';

const ALL_PERMISSIONS = Object.keys(PERMISSION_LABELS) as XenwaPermission[];

function fmtDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function statusTone(status: string | null): 'ok' | 'warn' | 'off' {
  if (status === 'ready') return 'ok';
  if (status === 'qr_ready' || status === 'initializing' || status === 'authenticating' || status === 'created')
    return 'warn';
  return 'off';
}

export function XenwaNumbers() {
  const toast = useToast();
  const { me, loading, refresh } = useXenwa();
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [teamFor, setTeamFor] = useState<XenwaAccount | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);

  const createNumber = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newName.trim().length < 3) return;
    setCreating(true);
    try {
      const created = await xenwaApi.createAccount(newName.trim());
      toast.success(`Number "${created.name}" added. Open Sessions to scan the QR code.`);
      setNewName('');
      await refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const payNow = async (a: XenwaAccount) => {
    setPayingId(a.sessionId);
    try {
      await xenwaApi.payNow(a.sessionId);
      toast.success('Paid — the number is active again.');
      await refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPayingId(null);
    }
  };

  if (loading && !me) {
    return (
      <div className="xenwa-page xenwa-center">
        <Loader2 className="animate-spin" size={28} />
      </div>
    );
  }

  const accounts = me?.accounts ?? [];
  const owned = accounts.filter(a => a.role === 'owner');
  const shared = accounts.filter(a => a.role === 'member');
  const all = accounts.filter(a => a.role === 'admin');
  const billing = me?.billing;
  const canCreate = !!me?.managed && (me.isAdmin || owned.length < (me?.limits.maxOwnedAccounts ?? 0));

  return (
    <div className="xenwa-page">
      <PageHeader
        title="Numbers & Team"
        subtitle="Your WhatsApp numbers, who can use them, and what each one costs."
        actions={
          <button className="btn-secondary" onClick={() => void refresh()}>
            <RefreshCw size={16} /> Refresh
          </button>
        }
      />

      {me?.user && (
        <section className="xenwa-hero glass-card">
          {me.user.image ? (
            <img className="xenwa-avatar" src={me.user.image} alt="" referrerPolicy="no-referrer" />
          ) : (
            <div className="xenwa-avatar xenwa-avatar--initial">
              {(me.user.name || me.user.email).charAt(0).toUpperCase()}
            </div>
          )}
          <div className="xenwa-hero__who">
            <strong>{me.user.name || me.user.email}</strong>
            <span>{me.user.email}</span>
          </div>
          {billing?.enabled && (
            <div className="xenwa-stats">
              <div className="xenwa-stat">
                <Coins size={16} />
                <div>
                  <span className="xenwa-stat__value">{billing.balance ?? '—'}</span>
                  <span className="xenwa-stat__label">credits left</span>
                </div>
              </div>
              <div className="xenwa-stat">
                <CalendarClock size={16} />
                <div>
                  <span className="xenwa-stat__value">{billing.monthlyTotal}</span>
                  <span className="xenwa-stat__label">credits / month</span>
                </div>
              </div>
              <div className="xenwa-stat">
                <Smartphone size={16} />
                <div>
                  <span className="xenwa-stat__value">
                    {owned.length}/{me.limits.maxOwnedAccounts}
                  </span>
                  <span className="xenwa-stat__label">numbers owned</span>
                </div>
              </div>
              <a
                className="btn-primary xenwa-buy"
                href={billing.buyCreditsUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Buy credits <ExternalLink size={14} />
              </a>
            </div>
          )}
        </section>
      )}

      {me?.managed && (
        <form className="xenwa-add glass-card" onSubmit={createNumber}>
          <div className="xenwa-add__text">
            <h3>Add a WhatsApp number</h3>
            <p>
              {billing?.enabled
                ? `${billing.creditsPerNumber} credits per number per month, charged from your XenAI Tech balance now and every month.`
                : 'Give it a short name, then scan the QR code on the Sessions page.'}
            </p>
          </div>
          <div className="xenwa-add__row">
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="e.g. sales-team"
              maxLength={40}
              aria-label="Number name"
              disabled={!canCreate || creating}
            />
            <button
              className="btn-primary"
              type="submit"
              disabled={!canCreate || creating || newName.trim().length < 3}
            >
              {creating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Add number
            </button>
          </div>
          {!canCreate && <p className="xenwa-muted">You have reached the limit of numbers you can own.</p>}
        </form>
      )}

      {!me?.managed && !me?.isAdmin && (
        <div className="glass-card xenwa-note">
          <ShieldCheck size={18} /> Sign in through XenAI Tech to manage numbers and team access.
        </div>
      )}

      <NumberGroup
        title="My numbers"
        icon={<Crown size={16} />}
        items={owned}
        onTeam={setTeamFor}
        onPay={payNow}
        payingId={payingId}
      />
      <NumberGroup
        title="Shared with me"
        icon={<Users size={16} />}
        items={shared}
        onTeam={setTeamFor}
        onPay={payNow}
        payingId={payingId}
      />
      <NumberGroup
        title="All numbers (admin)"
        icon={<ShieldCheck size={16} />}
        items={all}
        onTeam={setTeamFor}
        onPay={payNow}
        payingId={payingId}
      />

      {me?.managed && accounts.length === 0 && (
        <div className="glass-card xenwa-empty">
          <Smartphone size={32} />
          <p>No numbers yet. Add one above, or ask a teammate to share theirs with {me.user?.email}.</p>
        </div>
      )}

      {teamFor && (
        <TeamModal account={teamFor} isAdmin={!!me?.isAdmin} onClose={() => setTeamFor(null)} onChanged={refresh} />
      )}
    </div>
  );
}

function NumberGroup({
  title,
  icon,
  items,
  onTeam,
  onPay,
  payingId,
}: {
  title: string;
  icon: React.ReactNode;
  items: XenwaAccount[];
  onTeam: (a: XenwaAccount) => void;
  onPay: (a: XenwaAccount) => void;
  payingId: string | null;
}) {
  if (items.length === 0) return null;
  return (
    <section className="xenwa-group">
      <h2 className="xenwa-group__title">
        {icon} {title} <span className="xenwa-count">{items.length}</span>
      </h2>
      <div className="xenwa-grid">
        {items.map(a => {
          const manage = a.role === 'owner' || a.role === 'admin';
          const paused = a.billing?.status === 'paused';
          const overdue = !!a.billing?.paidUntil && new Date(a.billing.paidUntil) < new Date() && !paused;
          return (
            <article key={a.sessionId} className={`xenwa-card glass-card ${paused ? 'is-paused' : ''}`}>
              <header className="xenwa-card__head">
                <div className="xenwa-card__icon">
                  <Smartphone size={20} />
                </div>
                <div className="xenwa-card__title">
                  <strong>{accountLabel(a)}</strong>
                  <span>{a.phone ? `+${a.phone}` : a.name}</span>
                </div>
                <span className={`xenwa-dot xenwa-dot--${statusTone(a.status)}`} title={a.status ?? ''} />
              </header>

              <div className="xenwa-chips">
                <span className={`xenwa-chip xenwa-chip--${a.role}`}>
                  {a.role === 'owner' ? 'Owner' : a.role === 'admin' ? 'Admin' : 'Team member'}
                </span>
                {a.role === 'member' &&
                  a.permissions.map(p => (
                    <span key={p} className="xenwa-chip">
                      {PERMISSION_LABELS[p].label}
                    </span>
                  ))}
                {a.role !== 'owner' && a.ownerEmail && (
                  <span className="xenwa-chip xenwa-chip--muted">by {a.ownerEmail}</span>
                )}
              </div>

              {a.billing && a.billing.status !== 'unbilled' && (
                <div className={`xenwa-billing ${paused ? 'is-paused' : overdue ? 'is-overdue' : ''}`}>
                  <CalendarClock size={14} />
                  <span>
                    {paused ? 'Paused — unpaid since ' : 'Paid until '}
                    <strong>{fmtDate(a.billing.paidUntil)}</strong>
                  </span>
                  <span className="xenwa-billing__cost">
                    {a.billing.creditsPerMonth > 0
                      ? `${a.billing.creditsPerMonth} cr/mo`
                      : a.billing.freeReason === 'rollout'
                        ? 'Free month'
                        : 'Free'}
                  </span>
                </div>
              )}
              {paused && (
                <p className="xenwa-warn">
                  <AlertTriangle size={14} /> Read-only until paid.
                  {a.billing?.lastError ? ` ${a.billing.lastError}` : ''}
                </p>
              )}

              <footer className="xenwa-card__actions">
                <Link className="btn-secondary" to="/chats">
                  <MessageSquare size={15} /> Chats
                </Link>
                {manage && (
                  <button className="btn-secondary" onClick={() => onTeam(a)}>
                    <Users size={15} /> Team
                  </button>
                )}
                {manage && (paused || overdue) && (
                  <button className="btn-primary" onClick={() => onPay(a)} disabled={payingId === a.sessionId}>
                    {payingId === a.sessionId ? <Loader2 size={15} className="animate-spin" /> : <Coins size={15} />}{' '}
                    Pay now
                  </button>
                )}
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function PermissionPicker({
  value,
  onChange,
  disabled,
}: {
  value: XenwaPermission[];
  onChange: (next: XenwaPermission[]) => void;
  disabled?: boolean;
}) {
  const toggle = (p: XenwaPermission) => {
    if (p === 'read') return;
    onChange(value.includes(p) ? value.filter(x => x !== p) : [...value, p]);
  };
  return (
    <div className="xenwa-perms">
      {ALL_PERMISSIONS.map(p => (
        <label
          key={p}
          className={`xenwa-perm ${value.includes(p) || p === 'read' ? 'is-on' : ''}`}
          title={PERMISSION_LABELS[p].hint}
        >
          <input
            type="checkbox"
            checked={p === 'read' || value.includes(p)}
            onChange={() => toggle(p)}
            disabled={disabled || p === 'read'}
          />
          {PERMISSION_LABELS[p].label}
        </label>
      ))}
    </div>
  );
}

function TeamModal({
  account,
  isAdmin,
  onClose,
  onChanged,
}: {
  account: XenwaAccount;
  isAdmin: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [members, setMembers] = useState<XenwaTeamMember[] | null>(null);
  const [email, setEmail] = useState('');
  const [perms, setPerms] = useState<XenwaPermission[]>(['read', 'send']);
  const [busy, setBusy] = useState(false);
  const [ownerEmail, setOwnerEmail] = useState('');

  const load = useCallback(async () => {
    try {
      setMembers(await xenwaApi.team(account.sessionId));
    } catch (err) {
      toast.error((err as Error).message);
      setMembers([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toast identity is not stable
  }, [account.sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      await load();
      await onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const invite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    void run(async () => {
      await xenwaApi.grant(account.sessionId, email.trim(), perms);
      setEmail('');
    }, 'Access granted. If they have no XenAI Tech account yet, it applies on their first sign-in.');
  };

  return (
    <Modal open onClose={onClose} title={`Team access · ${accountLabel(account)}`} className="xenwa-team-modal">
      <div className="xenwa-team">
        <p className="xenwa-muted">
          Share only this number. People sign in with their XenAI Tech account; changes and removals apply immediately.
        </p>

        <form className="xenwa-invite" onSubmit={invite}>
          <div className="xenwa-invite__row">
            <Mail size={16} />
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="employee@company.com"
              aria-label="Email to invite"
              required
            />
            <button className="btn-primary" type="submit" disabled={busy}>
              <UserPlus size={15} /> Invite
            </button>
          </div>
          <PermissionPicker value={perms} onChange={setPerms} disabled={busy} />
        </form>

        {members === null ? (
          <div className="xenwa-center">
            <Loader2 className="animate-spin" />
          </div>
        ) : (
          <ul className="xenwa-members">
            {members.map(m => (
              <li key={m.id} className="xenwa-member">
                <div className="xenwa-member__who">
                  {m.image ? (
                    <img className="xenwa-avatar xenwa-avatar--sm" src={m.image} alt="" referrerPolicy="no-referrer" />
                  ) : (
                    <div className="xenwa-avatar xenwa-avatar--sm xenwa-avatar--initial">
                      {(m.name || m.email).charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div>
                    <strong>{m.name || m.email}</strong>
                    <span>
                      {m.email}
                      {m.status === 'pending' && <em className="xenwa-pending"> · pending sign-up</em>}
                    </span>
                  </div>
                  {m.role === 'owner' ? (
                    <span className="xenwa-chip xenwa-chip--owner">Owner</span>
                  ) : (
                    <button
                      className="btn-icon-danger"
                      onClick={() => void run(() => xenwaApi.revoke(account.sessionId, m.id), `${m.email} removed`)}
                      disabled={busy}
                      aria-label={`Remove ${m.email}`}
                      title="Remove access"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
                {m.role === 'member' && (
                  <PermissionPicker
                    value={m.permissions}
                    disabled={busy}
                    onChange={next =>
                      void run(() => xenwaApi.updateGrant(account.sessionId, m.id, next), 'Permissions updated')
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        )}

        {(isAdmin || account.role === 'owner') && (
          <form
            className="xenwa-owner"
            onSubmit={e => {
              e.preventDefault();
              if (!ownerEmail.trim()) return;
              if (
                !window.confirm(`Make ${ownerEmail.trim()} the owner of this number? They will pay for it from now on.`)
              )
                return;
              void run(async () => {
                await xenwaApi.setOwner(account.sessionId, ownerEmail.trim());
                setOwnerEmail('');
              }, 'Owner changed');
            }}
          >
            <h4>
              <Crown size={14} /> {isAdmin ? 'Assign owner' : 'Transfer ownership'}
            </h4>
            <div className="xenwa-invite__row">
              <input
                type="email"
                value={ownerEmail}
                onChange={e => setOwnerEmail(e.target.value)}
                placeholder="new-owner@company.com"
                aria-label="New owner email"
              />
              <button className="btn-secondary" type="submit" disabled={busy}>
                Set owner
              </button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
