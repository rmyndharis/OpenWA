import { recordHttpRequest, renderHttpRequestMetrics, resetHttpRequestMetrics } from './request-metrics';

describe('request-metrics (HTTP RED store)', () => {
  beforeEach(() => resetHttpRequestMetrics());

  const lines = () => renderHttpRequestMetrics().join('\n');

  it('records one request into http_requests_total{method,route,status}', () => {
    recordHttpRequest('GET', '/api/sessions', 200, 0.01);
    expect(lines()).toContain('http_requests_total{method="GET",route="/api/sessions",status="200"} 1');
  });

  it('aggregates the counter across repeated identical requests', () => {
    recordHttpRequest('GET', '/api/sessions', 200, 0.01);
    recordHttpRequest('GET', '/api/sessions', 200, 0.02);
    recordHttpRequest('GET', '/api/sessions', 500, 0.03);
    expect(lines()).toContain('http_requests_total{method="GET",route="/api/sessions",status="200"} 2');
    expect(lines()).toContain('http_requests_total{method="GET",route="/api/sessions",status="500"} 1');
  });

  it('records duration into the histogram with cumulative buckets', () => {
    recordHttpRequest('GET', '/api/sessions', 200, 0.05);
    const out = lines();
    // 0.05 falls into le="0.05" and every larger bucket, but NOT le="0.025" or below.
    expect(out).toContain('http_request_duration_seconds_bucket{method="GET",route="/api/sessions",le="0.05"} 1');
    expect(out).toContain('http_request_duration_seconds_bucket{method="GET",route="/api/sessions",le="0.025"} 0');
    expect(out).toContain('http_request_duration_seconds_bucket{method="GET",route="/api/sessions",le="+Inf"} 1');
    expect(out).toContain('http_request_duration_seconds_count{method="GET",route="/api/sessions"} 1');
    expect(out).toMatch(/http_request_duration_seconds_sum\{method="GET",route="\/api\/sessions"} 0\.05\d*/);
  });

  it('emits HELP/TYPE headers exactly once per metric, regardless of series count', () => {
    recordHttpRequest('GET', '/api/sessions', 200, 0.01);
    recordHttpRequest('POST', '/api/messages', 201, 0.01);
    const out = lines();
    expect(out.split('# HELP http_requests_total').length - 1).toBe(1);
    expect(out.split('# TYPE http_requests_total').length - 1).toBe(1);
    expect(out.split('# HELP http_request_duration_seconds').length - 1).toBe(1);
    expect(out.split('# TYPE http_request_duration_seconds').length - 1).toBe(1);
  });

  it('escapes special label characters (quote, backslash, newline) in the route label', () => {
    recordHttpRequest('GET', '/api/"weird"/path', 200, 0.01);
    expect(lines()).toContain('route="/api/\\"weird\\"/path"');
  });

  it('reset clears both the counter and the histogram', () => {
    recordHttpRequest('GET', '/api/sessions', 200, 0.01);
    resetHttpRequestMetrics();
    const out = lines();
    expect(out).not.toContain('http_requests_total{');
    expect(out).not.toContain('http_request_duration_seconds_count{');
  });
});
