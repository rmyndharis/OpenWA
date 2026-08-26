import { useState } from 'react';
import { CreditCard } from 'lucide-react';
import { billingApi } from '../services/api';
import { PageHeader } from '../components/PageHeader';

export function Billing() {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const pay = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await billingApi.checkout();
      if (result.url) window.location.assign(result.url);
      else window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start checkout.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dashboard">
      <PageHeader title="Billing" subtitle="Aeon WhatsApp API is $25 per month." />
      <section className="sessions-section" style={{ maxWidth: 560, padding: '1.5rem' }}>
        <CreditCard size={32} aria-hidden="true" />
        <h2>Keep your API active</h2>
        <p>Pay securely through Stripe. Your subscription renews monthly and API access resumes after payment.</p>
        {error && <p style={{ color: 'var(--danger, #b42318)' }}>{error}</p>}
        <button className="btn-primary" onClick={pay} disabled={loading}>
          {loading ? 'Opening checkout…' : 'Pay $25/month'}
        </button>
      </section>
    </div>
  );
}
