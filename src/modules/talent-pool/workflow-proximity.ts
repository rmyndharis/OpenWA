export interface ProximityDestination {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}

export interface ProximityResult {
  posicao: number;
  locationId: string;
  nome: string;
  endereco: string;
  distanciaKm: number | null;
  tempoMinutos: number | null;
  routeAvailable: boolean;
}

export interface ProximityCalculation {
  origin: { address: string; latitude: number; longitude: number };
  results: ProximityResult[];
  normalizedAddress?: BrazilianPostalAddress;
}

export interface BrazilianPostalAddress {
  postalCode: string;
  street: string;
  number: string;
  neighborhood: string;
  city: string;
  state: string;
}

export type ProximityErrorCode = 'ADDRESS_NOT_FOUND' | 'GEOCODING_UNAVAILABLE' | 'ROUTING_UNAVAILABLE';

export class ProximityServiceError extends Error {
  constructor(
    public readonly code: ProximityErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProximityServiceError';
  }
}

interface NominatimResult {
  lat?: string;
  lon?: string;
}

interface ViaCepResult {
  cep?: string;
  logradouro?: string;
  bairro?: string;
  localidade?: string;
  uf?: string;
  erro?: boolean | string;
}

interface OsrmTableResponse {
  code?: string;
  durations?: Array<Array<number | null>>;
  distances?: Array<Array<number | null>>;
  message?: string;
}

export interface ProximityOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  nominatimBaseUrl?: string;
  osrmBaseUrl?: string;
  viacepBaseUrl?: string;
  userAgent?: string;
  referer?: string;
  originCoordinates?: { latitude: number; longitude: number };
  /** Keeps fallback Nominatim requests inside its public usage-rate guidance. */
  geocodeRetryDelayMs?: number;
}

const roadPrefix = /^(alameda|avenida|av\.?|beco|estrada|praça|praca|rodovia|rua|travessa|via)\b/i;

export function candidateGeocodingQueries(address: string): string[] {
  const parts = address
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  const variants = [address.trim()];
  const postalIndex = parts.findIndex(part => /^CEP\s+/i.test(part));
  if (postalIndex >= 5) {
    const street = parts[0];
    const number = parts[1];
    const neighborhood = parts[postalIndex - 3];
    const city = parts[postalIndex - 2];
    const state = parts[postalIndex - 1];
    const postalCode = parts[postalIndex];
    const country = parts[postalIndex + 1] || 'Brasil';
    // Apartment/block/complement values between the number and neighborhood often make an
    // otherwise valid Nominatim free-form query return no matches.
    variants.push([street, number, neighborhood, city, state, postalCode, country].join(', '));
    // Some addresses are valid but their building number is not indexed. A street-level
    // fallback is still useful for ranking interview locations and is clearly shown by
    // the diagnostic screen through the returned coordinates.
    variants.push([street, neighborhood, city, state, country].join(', '));
    if (!roadPrefix.test(street)) {
      variants.push([`Rua ${street}`, number, neighborhood, city, state, postalCode, country].join(', '));
      variants.push([`Rua ${street}`, neighborhood, city, state, country].join(', '));
    }
  }
  return [...new Set(variants.filter(Boolean))];
}

const fetchWithTimeout = async (
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const addressPostalCodeAndNumber = (address: string) => {
  const parts = address.split(',').map(part => part.trim());
  const postalCode = parts.find(part => /^CEP\s+/i.test(part))?.replace(/\D/g, '') ?? '';
  const number = parts[1]?.replace(/\D/g, '') ?? '';
  return { postalCode, number };
};

const lookupPostalAddress = async (
  address: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  baseUrl: string,
): Promise<BrazilianPostalAddress | null> => {
  const { postalCode, number } = addressPostalCodeAndNumber(address);
  if (!/^\d{8}$/.test(postalCode) || !number) return null;
  const url = new URL(`/ws/${postalCode}/json/`, baseUrl);
  try {
    const response = await fetchWithTimeout(fetchImpl, url, { headers: { Accept: 'application/json' } }, timeoutMs);
    if (!response.ok) return null;
    const found = (await response.json()) as ViaCepResult;
    if (found.erro || !found.logradouro?.trim() || !found.localidade?.trim() || !found.uf?.trim()) return null;
    return {
      postalCode,
      street: found.logradouro.trim(),
      number,
      neighborhood: found.bairro?.trim() ?? '',
      city: found.localidade.trim(),
      state: found.uf.trim().toUpperCase(),
    };
  } catch {
    return null;
  }
};

const postalAddressText = (address: BrazilianPostalAddress) =>
  [
    `${address.street}, ${address.number}`,
    address.neighborhood,
    `${address.city}, ${address.state}`,
    `CEP ${address.postalCode}`,
    'Brasil',
  ]
    .filter(Boolean)
    .join(', ');

/** Geocodes one candidate address and ranks all persisted interview locations by driving time. */
export async function encontrarLocaisPorProximidade(
  enderecoOrigem: string,
  destinations: ProximityDestination[],
  options: ProximityOptions = {},
): Promise<ProximityCalculation> {
  const address = enderecoOrigem.trim();
  if (!address) throw new ProximityServiceError('ADDRESS_NOT_FOUND', 'Informe um endereço de origem.');
  if (!destinations.length) return { origin: { address, latitude: 0, longitude: 0 }, results: [] };

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  let latitude = options.originCoordinates?.latitude ?? Number.NaN;
  let longitude = options.originCoordinates?.longitude ?? Number.NaN;
  let resolvedAddress = address;
  let normalizedAddress: BrazilianPostalAddress | undefined;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    const tryGeocoding = async (queries: string[]) => {
      let foundLatitude = Number.NaN;
      let foundLongitude = Number.NaN;
      for (let index = 0; index < queries.length; index += 1) {
        if (index > 0) {
          const delay = options.geocodeRetryDelayMs ?? 1_000;
          if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        }
        const nominatimUrl = new URL('/search', options.nominatimBaseUrl ?? 'https://nominatim.openstreetmap.org');
        nominatimUrl.searchParams.set('q', queries[index]);
        nominatimUrl.searchParams.set('format', 'jsonv2');
        nominatimUrl.searchParams.set('limit', '1');
        nominatimUrl.searchParams.set('countrycodes', 'br');

        let geocodingResponse: Response;
        try {
          geocodingResponse = await fetchWithTimeout(
            fetchImpl,
            nominatimUrl,
            {
              headers: {
                Accept: 'application/json',
                'User-Agent': options.userAgent ?? 'OpenWA/0.23 (self-hosted interview proximity)',
                ...(options.referer ? { Referer: options.referer } : {}),
              },
            },
            timeoutMs,
          );
        } catch (error) {
          throw new ProximityServiceError('GEOCODING_UNAVAILABLE', 'O serviço de localização está indisponível.', {
            cause: error,
          });
        }
        if (!geocodingResponse.ok)
          throw new ProximityServiceError(
            'GEOCODING_UNAVAILABLE',
            `O serviço de localização respondeu com HTTP ${geocodingResponse.status}.`,
          );

        let geocoding: NominatimResult[];
        try {
          geocoding = (await geocodingResponse.json()) as NominatimResult[];
        } catch (error) {
          throw new ProximityServiceError('GEOCODING_UNAVAILABLE', 'A resposta do serviço de localização é inválida.', {
            cause: error,
          });
        }
        foundLatitude = Number(geocoding[0]?.lat);
        foundLongitude = Number(geocoding[0]?.lon);
        if (Number.isFinite(foundLatitude) && Number.isFinite(foundLongitude)) break;
      }
      return { latitude: foundLatitude, longitude: foundLongitude };
    };
    ({ latitude, longitude } = await tryGeocoding(candidateGeocodingQueries(address)));
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      normalizedAddress =
        (await lookupPostalAddress(address, fetchImpl, timeoutMs, options.viacepBaseUrl ?? 'https://viacep.com.br')) ??
        undefined;
      if (normalizedAddress) {
        resolvedAddress = postalAddressText(normalizedAddress);
        const delay = options.geocodeRetryDelayMs ?? 1_000;
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        ({ latitude, longitude } = await tryGeocoding(candidateGeocodingQueries(resolvedAddress)));
      }
    }
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
    throw new ProximityServiceError('ADDRESS_NOT_FOUND', 'O endereço informado não foi encontrado.');

  const coordinates = [
    `${longitude},${latitude}`,
    ...destinations.map(destination => `${destination.longitude},${destination.latitude}`),
  ].join(';');
  const osrmBase = (options.osrmBaseUrl ?? 'https://router.project-osrm.org').replace(/\/$/, '');
  const routingUrl = new URL(`${osrmBase}/table/v1/driving/${coordinates}`);
  routingUrl.searchParams.set('sources', '0');
  routingUrl.searchParams.set('destinations', destinations.map((_, index) => String(index + 1)).join(';'));
  routingUrl.searchParams.set('annotations', 'duration,distance');

  let routingResponse: Response;
  try {
    routingResponse = await fetchWithTimeout(
      fetchImpl,
      routingUrl,
      { headers: { Accept: 'application/json' } },
      timeoutMs,
    );
  } catch (error) {
    throw new ProximityServiceError('ROUTING_UNAVAILABLE', 'O serviço de rotas está indisponível.', { cause: error });
  }
  if (!routingResponse.ok)
    throw new ProximityServiceError(
      'ROUTING_UNAVAILABLE',
      `O serviço de rotas respondeu com HTTP ${routingResponse.status}.`,
    );

  let table: OsrmTableResponse;
  try {
    table = (await routingResponse.json()) as OsrmTableResponse;
  } catch (error) {
    throw new ProximityServiceError('ROUTING_UNAVAILABLE', 'A resposta do serviço de rotas é inválida.', {
      cause: error,
    });
  }
  if (table.code !== 'Ok' || !table.durations?.[0] || !table.distances?.[0])
    throw new ProximityServiceError(
      'ROUTING_UNAVAILABLE',
      table.message || 'O serviço de rotas não retornou uma tabela válida.',
    );

  const ranked = destinations
    .map((destination, index) => ({
      destination,
      durationSeconds: table.durations![0][index] ?? null,
      distanceMeters: table.distances![0][index] ?? null,
    }))
    .sort((left, right) => {
      if (left.distanceMeters === null) return right.distanceMeters === null ? 0 : 1;
      if (right.distanceMeters === null) return -1;
      const distanceDifference = left.distanceMeters - right.distanceMeters;
      if (distanceDifference !== 0) return distanceDifference;
      if (left.durationSeconds === null) return right.durationSeconds === null ? 0 : 1;
      if (right.durationSeconds === null) return -1;
      return left.durationSeconds - right.durationSeconds;
    });

  return {
    origin: { address: resolvedAddress, latitude, longitude },
    ...(normalizedAddress ? { normalizedAddress } : {}),
    results: ranked.map((row, index) => ({
      posicao: index + 1,
      locationId: row.destination.id,
      nome: row.destination.name,
      endereco: row.destination.address,
      distanciaKm: row.distanceMeters === null ? null : Math.round((row.distanceMeters / 1_000) * 10) / 10,
      tempoMinutos: row.durationSeconds === null ? null : Math.round(row.durationSeconds / 60),
      routeAvailable: row.durationSeconds !== null && row.distanceMeters !== null,
    })),
  };
}
