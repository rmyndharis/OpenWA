import { MapPin, RefreshCw, Search } from 'lucide-react';
import { useState } from 'react';
import { workflowHubApi, type WorkflowProximityTestResult } from '../services/api';
import { formatDurationMinutes } from '../utils/formatDuration';

type ProximityTestAddress = {
  postalCode: string;
  street: string;
  number: string;
  complement: string;
  neighborhood: string;
  city: string;
  state: string;
};

const emptyAddress = (): ProximityTestAddress => ({
  postalCode: '',
  street: '',
  number: '',
  complement: '',
  neighborhood: '',
  city: '',
  state: '',
});

export function ProximityTestPanel({ sessionId }: { sessionId: string }) {
  const [addressFields, setAddressFields] = useState<ProximityTestAddress>(emptyAddress);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<WorkflowProximityTestResult | null>(null);
  const [submittedAddress, setSubmittedAddress] = useState('');

  const runTest = async () => {
    if (loading) return;
    const address = [
      `${addressFields.street.trim()}, ${addressFields.number.trim()}`,
      addressFields.complement.trim(),
      addressFields.neighborhood.trim(),
      `${addressFields.city.trim()}, ${addressFields.state.trim().toUpperCase()}`,
      `CEP ${addressFields.postalCode.replace(/\D/g, '')}`,
      'Brasil',
    ]
      .filter(part => part && !part.startsWith(',') && part !== 'CEP ')
      .join(', ');
    setLoading(true);
    setResult(null);
    setSubmittedAddress(address);
    try {
      const response = await workflowHubApi.testProximity(sessionId, address);
      setResult(response);
      if (response.normalizedAddress) {
        setAddressFields(current => ({
          ...current,
          postalCode: response.normalizedAddress!.postalCode,
          street: response.normalizedAddress!.street,
          number: response.normalizedAddress!.number,
          neighborhood: response.normalizedAddress!.neighborhood,
          city: response.normalizedAddress!.city,
          state: response.normalizedAddress!.state,
        }));
        setSubmittedAddress(response.origin?.address ?? address);
      }
    } catch (error) {
      const status = (error as (Error & { status?: number }) | null)?.status;
      setResult({
        success: false,
        errorCode: status === 403 ? 'FORBIDDEN' : 'GEOCODING_UNAVAILABLE',
        message:
          status === 403
            ? 'Você não tem autorização para executar o teste de localização.'
            : error instanceof Error
              ? error.message
              : 'Não foi possível executar o teste.',
        destinationCount: 0,
        elapsedMs: 0,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="proximity-test-workspace">
      <p className="proximity-test-description">
        Informe um endereço sem alterar nenhum candidato. O teste consulta o OpenStreetMap e compara com os locais de
        entrevista desta sessão que possuem coordenadas.
      </p>
      <form
        className="proximity-test-form"
        onSubmit={event => {
          event.preventDefault();
          void runTest();
        }}
      >
        <label>
          CEP
          <input
            required
            inputMode="numeric"
            maxLength={9}
            value={addressFields.postalCode}
            onChange={event => setAddressFields(current => ({ ...current, postalCode: event.target.value }))}
            placeholder="35700-083"
          />
        </label>
        <label className="proximity-test-street">
          Logradouro
          <input
            required
            value={addressFields.street}
            onChange={event => setAddressFields(current => ({ ...current, street: event.target.value }))}
            placeholder="Rua Amazonas"
          />
        </label>
        <label>
          Número
          <input
            required
            inputMode="numeric"
            value={addressFields.number}
            onChange={event =>
              setAddressFields(current => ({ ...current, number: event.target.value.replace(/\D/g, '') }))
            }
            placeholder="450"
          />
        </label>
        <label>
          Complemento
          <input
            value={addressFields.complement}
            onChange={event => setAddressFields(current => ({ ...current, complement: event.target.value }))}
            placeholder="Opcional"
          />
        </label>
        <label>
          Bairro
          <input
            required
            value={addressFields.neighborhood}
            onChange={event => setAddressFields(current => ({ ...current, neighborhood: event.target.value }))}
            placeholder="Boa Vista"
          />
        </label>
        <label className="proximity-test-city">
          Cidade
          <input
            required
            value={addressFields.city}
            onChange={event => setAddressFields(current => ({ ...current, city: event.target.value }))}
            placeholder="Sete Lagoas"
          />
        </label>
        <label>
          UF
          <input
            required
            maxLength={2}
            value={addressFields.state}
            onChange={event => setAddressFields(current => ({ ...current, state: event.target.value.toUpperCase() }))}
            placeholder="MG"
          />
        </label>
        <div className="proximity-test-actions">
          <button
            type="button"
            className="btn-secondary"
            disabled={loading}
            onClick={() => {
              setAddressFields(emptyAddress());
              setResult(null);
              setSubmittedAddress('');
            }}
          >
            Limpar
          </button>
          <button type="submit" className="btn-primary" disabled={loading || !sessionId}>
            {loading ? <RefreshCw className="spin" size={16} /> : <Search size={16} />}
            {loading ? 'Consultando…' : 'Testar endereço'}
          </button>
        </div>
      </form>

      {submittedAddress && (
        <div className="proximity-test-address">
          <MapPin size={18} />
          <div>
            <small>Endereço enviado para o diagnóstico</small>
            <strong>{submittedAddress}</strong>
          </div>
        </div>
      )}

      {result && (
        <div className={`proximity-test-report ${result.success ? 'is-success' : 'is-error'}`}>
          <header>
            <div>
              <span className="section-eyebrow">Resultado do teste</span>
              <h3>{result.success ? 'Localização e rotas encontradas' : 'A consulta falhou'}</h3>
            </div>
            <span className="proximity-test-duration">{result.elapsedMs} ms</span>
          </header>
          {result.success && result.origin ? (
            <>
              <div className="proximity-test-diagnostics">
                <div>
                  <span>Latitude</span>
                  <strong>{result.origin.latitude}</strong>
                </div>
                <div>
                  <span>Longitude</span>
                  <strong>{result.origin.longitude}</strong>
                </div>
                <div>
                  <span>Locais comparados</span>
                  <strong>{result.destinationCount}</strong>
                </div>
              </div>
              <div className="candidate-proximity-results">
                {(result.results ?? []).map(location => (
                  <article key={location.locationId} className={location.posicao === 1 ? 'is-recommended' : ''}>
                    <span className="candidate-proximity-position">{location.posicao}º</span>
                    <div>
                      <strong>{location.nome}</strong>
                      <span>{location.endereco}</span>
                    </div>
                    <div className="candidate-proximity-metrics">
                      <strong>{location.distanciaKm === null ? 'Sem rota' : `${location.distanciaKm} km`}</strong>
                      <span>{formatDurationMinutes(location.tempoMinutos)}</span>
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <div className="proximity-test-error-detail">
              <strong>{result.errorCode ?? 'ERRO_DESCONHECIDO'}</strong>
              <p>{result.message}</p>
              <small>
                {result.errorCode === 'FORBIDDEN'
                  ? 'Este diagnóstico é restrito a administradores.'
                  : result.errorCode === 'ADDRESS_NOT_FOUND'
                    ? 'O Nominatim respondeu, mas não encontrou o endereço nem as variações sem complemento e número.'
                    : result.errorCode === 'GEOCODING_UNAVAILABLE'
                      ? 'A falha ocorreu na comunicação com o Nominatim. Verifique internet, DNS, proxy e as variáveis NOMINATIM_BASE_URL e NOMINATIM_USER_AGENT.'
                      : result.errorCode === 'ROUTING_UNAVAILABLE'
                        ? 'O endereço foi localizado, mas a OSRM Table API não respondeu corretamente. Verifique internet, DNS, proxy e OSRM_BASE_URL.'
                        : 'Nenhum local cadastrado nesta sessão possui coordenadas válidas para a comparação.'}
              </small>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
