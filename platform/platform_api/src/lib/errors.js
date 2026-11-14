export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function errorHandler(error, _request, response, _next) {
  if (error.name === 'ZodError') {
    return response
      .status(400)
      .json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Revisa los campos enviados.',
          fields: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
  }
  if (error.type === 'entity.parse.failed') {
    return response
      .status(400)
      .json({
        error: {
          code: 'INVALID_JSON',
          message: 'El cuerpo debe ser JSON válido.',
        },
      });
  }
  if (error.type === 'entity.too.large') {
    return response
      .status(413)
      .json({
        error: {
          code: 'BODY_TOO_LARGE',
          message: 'La solicitud supera el tamaño permitido.',
        },
      });
  }
  if (error.code === '23505') {
    const busy = error.constraint === 'operations_one_active_per_tenant';
    return response
      .status(409)
      .json({
        error: {
          code: busy ? 'TENANT_BUSY' : 'ALREADY_EXISTS',
          message: busy
            ? 'Esta institución ya tiene una operación pendiente.'
            : 'Ya existe un registro con esos datos.',
        },
      });
  }
  if (error.code === '23503') {
    return response
      .status(400)
      .json({
        error: {
          code: 'INVALID_REFERENCE',
          message: 'El registro relacionado no existe.',
        },
      });
  }
  const status = error instanceof HttpError ? error.status : 500;
  if (status === 500)
    console.error('Error interno de API; código:', error.code ?? error.name);
  return response
    .status(status)
    .json({
      error: {
        code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR',
        message:
          status === 500 ? 'No se pudo completar la solicitud.' : error.message,
      },
    });
}
