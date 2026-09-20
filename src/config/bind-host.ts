export function resolveBindHost(nodeEnv?: string, configuredHost?: string): string {
  const explicitHost = configuredHost?.trim();
  if (explicitHost) return explicitHost;
  return nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1';
}

export function resolvePublicUrl(
  nodeEnv: string | undefined,
  baseUrl: string | undefined,
  port: string | number,
): string {
  if (nodeEnv === 'production' && baseUrl?.trim()) return baseUrl.trim().replace(/\/$/, '');
  return `http://localhost:${port}`;
}
