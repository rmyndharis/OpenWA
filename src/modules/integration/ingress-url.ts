import { ApiProperty } from '@nestjs/swagger';

export class IngressUrl {
  @ApiProperty({ description: 'Plugin-declared route segment the provider posts to.' })
  route: string;

  @ApiProperty({
    description: 'Full ingress URL (BASE_URL + plugin/instance/route), or a relative path when BASE_URL is unset.',
  })
  url: string;
}

// Absolute URL from BASE_URL when set (trailing slash trimmed), else a relative path the operator
// prepends with their own host. Never throws.
export function buildIngressUrls(
  baseUrl: string | undefined,
  pluginId: string,
  instanceId: string,
  routes: string[],
): IngressUrl[] {
  const base = (baseUrl ?? '').replace(/\/+$/, '');
  return routes.map(route => ({
    route,
    url: `${base}/api/ingress/${pluginId}/${instanceId}/${route}`,
  }));
}
