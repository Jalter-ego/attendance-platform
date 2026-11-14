export function redact(value, secrets = []) {
  let text = String(value);
  for (const secret of [...secrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    text = text.replaceAll(secret, '[REDACTED]');
  return text
    .replace(/(postgres(?:ql)?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/(bearer\s+)[a-z0-9._~-]+/gi, '$1[REDACTED]')
    .replace(
      /((?:[a-z_]*(?:password|secret|token|access_key)[a-z_]*)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      '$1[REDACTED]',
    )
    .slice(0, 4000);
}
