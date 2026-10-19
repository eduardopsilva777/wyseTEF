import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { redactSensitiveText } from '@tef/audit';

/**
 * Logs estruturados com CAMPOS PERMITIDOS: os serializadores de requisição e
 * resposta montam objetos novos só com campos seguros (nunca cabeçalhos ou
 * corpo). A redação abaixo é uma segunda barreira para chamadas descuidadas.
 * Nunca registrar: Authorization, chaves de API, PAN, CVV, trilha, PIN, senhas.
 */
export const REDACTED_PATHS = [
  'authorization',
  'headers.authorization',
  'req.headers',
  'body',
  'req.body',
  '*.authorization',
  '*.apiKey',
  '*.password',
  '*.secret',
  '*.token',
  '*.pan',
  '*.cardNumber',
  '*.cvv',
  '*.track',
  '*.pin',
  '*.connectionString',
  'databaseUrl',
];

interface RequestLike {
  id?: unknown;
  method?: unknown;
  routeOptions?: { url?: unknown };
  url?: unknown;
}

function safeRoute(req: RequestLike): string | undefined {
  const route = req.routeOptions?.url;
  if (typeof route === 'string') return route; // padrão da rota (ex.: /v1/payments/:paymentId)
  if (typeof req.url === 'string') return req.url.split('?')[0];
  return undefined;
}

const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Erros: apenas tipo, código (ex.: SQLSTATE), constraint e mensagem/stack
 * REDIGIDOS. Campos de drivers que carregam valores (detail, hint, where,
 * query, parameters, cause) nunca são registrados. Em produção, sem stack.
 */
export function serializeError(production: boolean): (err: unknown) => Record<string, unknown> {
  return (err) => {
    if (!(err instanceof Error)) return { type: typeof err };
    const { code, constraint } = err as { code?: unknown; constraint?: unknown };
    return {
      type: err.name,
      ...(typeof code === 'string' && SAFE_TOKEN.test(code) ? { code } : {}),
      ...(typeof constraint === 'string' && SAFE_TOKEN.test(constraint) ? { constraint } : {}),
      message: redactSensitiveText(err.message),
      ...(production || !err.stack ? {} : { stack: redactSensitiveText(err.stack, 4_000) }),
    };
  };
}

export function loggerOptions(level: string, production: boolean, service = 'tef-api'): LoggerOptions {
  return {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    serializers: {
      req: (req: RequestLike) => ({
        id: req.id,
        method: req.method,
        route: safeRoute(req),
      }),
      res: (res: { statusCode?: unknown }) => ({ statusCode: res.statusCode }),
      err: serializeError(production),
    },
  };
}

export function createLogger(level: string, production: boolean, destination?: DestinationStream, service = 'tef-api'): Logger {
  const options = loggerOptions(level, production, service);
  return destination ? pino(options, destination) : pino(options);
}
