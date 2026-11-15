export function requestLog({ log = console.log, now = () => performance.now() } = {}) {
  return (request, response, next) => {
    const started = now();
    response.on('finish', () => {
      const ms = Math.round(now() - started);
      const path = request.originalUrl.split('?')[0];
      // request.user lo completa requireSession más adelante (mismo objeto request).
      const user = request.user?.id ? ` user=${request.user.id}` : '';
      log(`${new Date().toISOString()} ${request.method} ${path} ${response.statusCode} ${ms}ms${user}`);
    });
    next();
  };
}
