export function httpError(status, error, message) {
  return Object.assign(new Error(message), { status, error });
}

export function errorHandler(error, req, res, _next) {
  let status = Number.isInteger(error.status) ? error.status : 500;
  let code = error.error;
  let message = error.message;
  if (error.type === 'entity.too.large') {
    status = 413;
    code = 'payload_too_large';
    message = 'JSON request exceeds 256 KiB';
  } else if (error.type === 'entity.parse.failed') {
    status = 400;
    code = 'invalid_request';
    message = 'Malformed JSON';
  } else if (['charset.unsupported', 'encoding.unsupported'].includes(error.type)) {
    status = 415;
    code = 'unsupported_media_type';
    message = 'Unsupported JSON encoding';
  } else if (error instanceof URIError) {
    status = 400;
    code = 'invalid_request';
    message = 'Invalid URL encoding';
  } else if (error.code?.startsWith('ERR_SQLITE') && /UNIQUE constraint failed/.test(error.message)) {
    status = 409;
    code = 'conflict';
    message = 'The resource already exists';
  }
  if (!code || status < 400 || status > 599 || status === 500) {
    status = 500;
    code = 'internal_error';
    message = 'Internal service error';
  }
  res.status(status).json({ error: code, message, requestId: req.requestId });
}
