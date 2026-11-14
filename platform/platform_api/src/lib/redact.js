import { stripVTControlCharacters } from 'node:util';

export function redact(value, secrets = []) {
  let text = stripVTControlCharacters(String(value));
  // Incluir las representaciones que pueden imprimir los CLI (JSON y URL).
  const variants = secrets.filter((value) => typeof value === 'string' && value)
    .flatMap((secret) => [secret, encodeURIComponent(secret),
      JSON.stringify(secret).slice(1, -1), ...secret.split(/\r?\n/)]);
  for (const secret of [...new Set(variants)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    text = text.replaceAll(secret, '[REDACTED]');
  return text
    .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/(postgres(?:ql)?:\/\/)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[REDACTED]')
    .replace(/(X-Amz-(?:Signature|Credential|Security-Token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(
      /([\w.-]*(?:password|passwd|secret|token|access[_-]?key|private[_-]?key|authorization)[\w.-]*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .slice(0, 4000);
}

// Los procesos entregan líneas completas. No emitir partes de una clave PEM.
export function createLogRedactor(secrets = []) {
  const privateKey = new Set();
  return (line, stream = 'stdout') => {
    const clean = stripVTControlCharacters(String(line));
    if (/-----BEGIN [\w ]*PRIVATE KEY-----/.test(clean)) privateKey.add(stream);
    if (privateKey.has(stream)) {
      if (/-----END [\w ]*PRIVATE KEY-----/.test(clean)) privateKey.delete(stream);
      return '[REDACTED PRIVATE KEY]';
    }
    return redact(clean, secrets);
  };
}
