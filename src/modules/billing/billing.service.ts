import { HttpException, HttpStatus, Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';
import { ApiKey } from '../auth/entities/api-key.entity';
import { User } from '../auth/entities/user.entity';
import { BillingAccount } from './entities/billing-account.entity';

const PLAN_NAME = 'Aeon WhatsApp API';
const PLAN_AMOUNT = 2500;
const CHECK_INTERVAL_MS = 60_000;

type StripeList<T> = { data: T[] };
type StripeInvoice = {
  status: string;
  amount_paid: number;
  currency: string;
  status_transitions?: { paid_at?: number };
  lines?: { data?: Array<{ description?: string }> };
};
type StripeSubscription = { status: string; latest_invoice?: { hosted_invoice_url?: string } | string };

@Injectable()
export class BillingService {
  constructor(@InjectRepository(BillingAccount, 'main') private readonly accounts: Repository<BillingAccount>) {}

  isEnabled(): boolean {
    return process.env.BILLING_ENABLED === 'true';
  }

  async assertAccess(principal: ApiKey | User): Promise<void> {
    if (!this.isEnabled() || !this.tenantId(principal)) return;
    const account = await this.accounts.findOneBy({ tenantId: this.tenantId(principal) as string });
    if (!account || !(await this.hasRecentPayment(account))) {
      throw new HttpException('An active Aeon WhatsApp API subscription is required.', HttpStatus.PAYMENT_REQUIRED);
    }
  }

  async status(principal: ApiKey | User): Promise<{ active: boolean; paidUntil?: Date; checkoutUrl?: string }> {
    if (!this.isEnabled()) return { active: true };
    const tenantId = this.tenantId(principal);
    if (!tenantId) return { active: true };
    const account = await this.accounts.findOneBy({ tenantId });
    return { active: !!account && (await this.hasRecentPayment(account)), paidUntil: account?.paidUntil || undefined };
  }

  async checkout(principal: ApiKey | User): Promise<{ url?: string; active: boolean }> {
    if (!this.isEnabled()) return { active: true };
    const tenantId = this.tenantId(principal);
    if (!tenantId) return { active: true };
    const account = await this.getOrCreateAccount(tenantId);
    if (await this.hasRecentPayment(account)) return { active: true };

    const subscriptions = await this.stripe<StripeList<StripeSubscription>>(
      `/v1/subscriptions?customer=${encodeURIComponent(account.stripeCustomerId)}&status=all&limit=10&expand[]=data.latest_invoice`,
    );
    const current = subscriptions.data.find(subscription => ['active', 'trialing', 'past_due', 'unpaid'].includes(subscription.status));
    if (current) {
      const invoice = typeof current.latest_invoice === 'string' ? undefined : current.latest_invoice;
      if (invoice?.hosted_invoice_url) return { active: false, url: invoice.hosted_invoice_url };
      throw new HttpException('Your subscription is processing. Please try again shortly.', HttpStatus.CONFLICT);
    }

    const baseUrl = this.dashboardUrl();
    const form = new URLSearchParams({
      mode: 'subscription',
      customer: account.stripeCustomerId,
      success_url: `${baseUrl}/billing?success=1`,
      cancel_url: `${baseUrl}/billing?cancelled=1`,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(PLAN_AMOUNT),
      'line_items[0][price_data][recurring][interval]': 'month',
      'line_items[0][price_data][product_data][name]': PLAN_NAME,
      'subscription_data[metadata][aeon_plan]': 'whatsapp-api',
      'subscription_data[metadata][tenant_id]': tenantId,
      client_reference_id: tenantId,
    });
    const session = await this.stripe<{ url?: string }>('/v1/checkout/sessions', { method: 'POST', body: form });
    if (!session.url) throw new InternalServerErrorException('Stripe did not return a checkout URL');
    return { active: false, url: session.url };
  }

  async handleWebhook(rawBody: Buffer, signature?: string): Promise<void> {
    if (!this.isEnabled() || !this.validSignature(rawBody, signature)) {
      throw new HttpException('Invalid webhook signature', HttpStatus.BAD_REQUEST);
    }
    const event = JSON.parse(rawBody.toString('utf8')) as { type?: string; data?: { object?: { customer?: string } } };
    if (event.type !== 'invoice.paid') return;
    const customerId = event.data?.object?.customer;
    if (!customerId) return;
    const account = await this.accounts.findOneBy({ stripeCustomerId: customerId });
    if (!account) return;
    await this.hasRecentPayment(account, true);
  }

  private async hasRecentPayment(account: BillingAccount, force = false): Promise<boolean> {
    if (!force && account.lastCheckedAt && Date.now() - account.lastCheckedAt.getTime() < CHECK_INTERVAL_MS) {
      return !!account.paidUntil && account.paidUntil > new Date();
    }
    const invoices = await this.stripe<StripeList<StripeInvoice>>(
      `/v1/invoices?customer=${encodeURIComponent(account.stripeCustomerId)}&status=paid&limit=25`,
    );
    const cutoff = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    const paidAt = invoices.data
      .filter(
        invoice =>
          invoice.amount_paid === PLAN_AMOUNT &&
          invoice.currency.toLowerCase() === 'usd' &&
          invoice.lines?.data?.some(line => line.description?.includes(PLAN_NAME)),
      )
      .map(invoice => invoice.status_transitions?.paid_at || 0)
      .filter(timestamp => timestamp >= cutoff)
      .sort((a, b) => b - a)[0];
    account.paidUntil = paidAt ? new Date((paidAt + 30 * 24 * 60 * 60) * 1000) : null;
    account.lastCheckedAt = new Date();
    await this.accounts.save(account);
    return !!paidAt;
  }

  private async getOrCreateAccount(tenantId: string): Promise<BillingAccount> {
    const existing = await this.accounts.findOneBy({ tenantId });
    if (existing) return existing;
    const form = new URLSearchParams({ name: `Aeon tenant ${tenantId}`, 'metadata[aeon_tenant_id]': tenantId });
    const customer = await this.stripe<{ id: string }>('/v1/customers', { method: 'POST', body: form });
    return this.accounts.save(this.accounts.create({ tenantId, stripeCustomerId: customer.id, paidUntil: null, lastCheckedAt: null }));
  }

  private async stripe<T>(path: string, init: RequestInit = {}): Promise<T> {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new InternalServerErrorException('Stripe billing is enabled but not configured');
    const response = await fetch(`https://api.stripe.com${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, ...(init.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    });
    if (!response.ok) throw new InternalServerErrorException('Stripe billing request failed');
    return response.json() as Promise<T>;
  }

  private validSignature(rawBody: Buffer, header?: string): boolean {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    const timestamp = header?.match(/(?:^|,)t=(\d+)/)?.[1];
    const signature = header?.match(/(?:^|,)v1=([a-f0-9]+)/)?.[1];
    if (!secret || !timestamp || !signature || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
    const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody.toString('utf8')}`).digest('hex');
    const actualBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  }

  private tenantId(principal: ApiKey | User): string | undefined {
    return principal.tenantId || (principal instanceof User ? principal.id : principal.ownerUserId || undefined);
  }

  private dashboardUrl(): string {
    const url = process.env.DASHBOARD_URL || process.env.BASE_URL;
    if (!url || !/^https?:\/\/[^\s]+$/i.test(url)) throw new InternalServerErrorException('DASHBOARD_URL must be configured for billing');
    return url.replace(/\/$/, '');
  }
}
