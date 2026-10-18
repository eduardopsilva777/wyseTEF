/**
 * Redação de texto livre (mensagens de erro, stacks) antes de ir para logs ou
 * saídas de linha de comando. É uma barreira de defesa em profundidade: o
 * código não deve colocar segredos em mensagens de erro, mas bibliotecas
 * (drivers, parsers) podem fazê-lo.
 */
const IDENTIFIER = /^(?:pay_|op_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RULES: ReadonlyArray<readonly [RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]'],
  // Credenciais embutidas em URLs: esquema://usuario:senha@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi, '$1$2:[REDACTED]@'],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]'],
  [
    /\b(password|passwd|pwd|secret|token|api[_-]?key|authorization|senha|credential)\b(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    '$1$2[REDACTED]',
  ],
  // Sequências longas de dígitos (possíveis PANs ou documentos).
  [/(?<!\d)\d{13,19}(?!\d)/g, '[REDACTED_NUMBER]'],
  // Tokens opacos longos (chaves base64url, hashes hex), preservando identificadores internos.
  [/[A-Za-z0-9_=-]{32,}/g, (match: string) => (IDENTIFIER.test(match) ? match : '[REDACTED_TOKEN]')],
];

export function redactSensitiveText(text: string, maxLength = 1_000): string {
  let result = text;
  for (const [pattern, replacement] of RULES) {
    result = typeof replacement === 'string' ? result.replace(pattern, replacement) : result.replace(pattern, replacement);
  }
  return result.length > maxLength ? `${result.slice(0, maxLength)}…[truncated]` : result;
}
