/**
 * Test helpers — a mock fetch transport that records calls and returns
 * canned responses, so tests assert on exact method/url/body/headers without
 * any real network or global monkey-patching.
 */
import type { FetchLike } from '../src';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockResponseSpec {
  status?: number;
  body?: unknown;
  text?: string;
}

/** A scripted mock transport. Throws if a call doesn't match a route. */
export class MockTransport {
  readonly calls: RecordedCall[] = [];
  private readonly routes: { method: string; matcher: RegExp; respond: (call: RecordedCall) => MockResponseSpec }[] =
    [];
  private fallback: ((call: RecordedCall) => MockResponseSpec) | null = null;

  /** Register a response for the first call matching `method` + `matcher`. */
  on(
    method: string,
    matcher: string | RegExp,
    respond: MockResponseSpec | ((call: RecordedCall) => MockResponseSpec),
  ): this {
    const regex = typeof matcher === 'string' ? new RegExp(matcher) : matcher;
    this.routes.push({
      method,
      matcher: regex,
      respond: typeof respond === 'function' ? respond : () => respond,
    });
    return this;
  }

  /** Catch-all for any unmatched call. */
  passthrough(respond: MockResponseSpec | ((call: RecordedCall) => MockResponseSpec)): this {
    this.fallback = typeof respond === 'function' ? respond : () => respond;
    return this;
  }

  /** @internal build the FetchLike impl consumed by the client. */
  asFetch(): FetchLike {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const fullUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const rawHeaders = init?.headers;
      const headers: Record<string, string> = {};
      if (rawHeaders) {
        const collect = (k: string, v: string): void => {
          headers[String(k).toLowerCase()] = String(v);
        };
        if (rawHeaders instanceof Headers) {
          rawHeaders.forEach((v, k) => collect(k, v));
        } else if (Array.isArray(rawHeaders)) {
          for (const [k, v] of rawHeaders) collect(k, String(v));
        } else {
          for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) collect(k, v);
        }
      }
      let body: unknown = undefined;
      if (init?.body) {
        try {
          body = JSON.parse(String(init.body));
        } catch {
          body = String(init.body);
        }
      }
      const call: RecordedCall = { url: fullUrl, method, headers, body };
      this.calls.push(call);

      // Route matching uses the pathname only (query stripped) so regexes
      // like `/contacts$` still match `…/contacts?limit=10`.
      const matchUrl = fullUrl.split('?')[0];

      let spec: MockResponseSpec;
      const route = this.routes.find(r => r.method === method && r.matcher.test(matchUrl));
      if (route) {
        spec = route.respond(call);
      } else if (this.fallback) {
        spec = this.fallback(call);
      } else {
        throw new Error(`MockTransport: no route for ${method} ${fullUrl}`);
      }

      const status = spec.status ?? 200;
      // 204/100/304 may not carry a body. Node's undici Response rejects
      // an empty-string body with these statuses, so pass `null`.
      const noBody = status === 204 || status === 100 || status === 304;
      const responseBody: BodyInit | null = noBody
        ? null
        : (spec.text ?? (spec.body === undefined ? '' : JSON.stringify(spec.body)));
      const resHeaders: Record<string, string> = noBody ? {} : { 'content-type': 'application/json' };
      return new Response(responseBody, { status, headers: resHeaders });
    }) as FetchLike;
  }

  get lastCall(): RecordedCall | undefined {
    return this.calls[this.calls.length - 1];
  }
}
