import { httpError } from './errors.js';

export function assertObject(value, name = 'body') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, 'invalid_request', `${name} must be an object`);
  }
  return value;
}

export function stringField(value, name, { required = true, max = 128, values } = {}) {
  if (!required && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || [...value].length > max) {
    throw httpError(400, 'invalid_request', `${name} must be a nonempty string of at most ${max} characters`);
  }
  if (values && !values.includes(value)) {
    throw httpError(400, 'invalid_request', `${name} is not a supported value`);
  }
  return value;
}

export function booleanField(value, name, defaultValue = true) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') throw httpError(400, 'invalid_request', `${name} must be a boolean`);
  return value;
}

export function pagination(query) {
  function integer(value, fallback, min, max, name) {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
      throw httpError(400, 'invalid_request', `${name} must be an integer`);
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
      throw httpError(400, 'invalid_request', `${name} is out of range`);
    }
    return number;
  }
  return {
    limit: integer(query.limit, 50, 1, 100, 'limit'),
    offset: integer(query.offset, 0, 0, 1_000_000, 'offset')
  };
}
