/**
 * Health resource — connectivity and readiness probes.
 *
 * Backed by `src/modules/health/health.controller.ts`.
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type { HealthReadyResponse, HealthResponse } from '../types.js';

export class HealthResource {
  constructor(private readonly client: OpenWAClient) {}

  /** General health (also returns the running version). */
  check(): Promise<HealthResponse> {
    return this.client.request<HealthResponse>({ method: 'GET', path: '/api/health' });
  }

  /** Kubernetes liveness probe. */
  live(): Promise<{ status: string }> {
    return this.client.request<{ status: string }>({ method: 'GET', path: '/api/health/live' });
  }

  /** Kubernetes readiness probe — checks both DB connections. */
  ready(): Promise<HealthReadyResponse> {
    return this.client.request<HealthReadyResponse>({ method: 'GET', path: '/api/health/ready' });
  }
}
