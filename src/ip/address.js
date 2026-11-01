import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { httpError } from '../errors.js';

export function parseIp(value) {
  if (typeof value !== 'string' || value.includes('%') || !isIP(value)) {
    throw httpError(400, 'invalid_request', 'ip must be an IPv4 or IPv6 literal');
  }
  return ipaddr.parse(value);
}

export function canonicalRule(type, value) {
  if (typeof value !== 'string') throw httpError(400, 'invalid_request', 'Rule value must be a string');
  if (type === 'region') {
    if (!/^[A-Z0-9][A-Z0-9-]{0,31}$/.test(value)) {
      throw httpError(400, 'invalid_request', 'Region must be an uppercase region code');
    }
    return value;
  }
  if (type === 'ip') {
    const address = parseIp(value);
    return address.kind() === 'ipv6' && address.isIPv4MappedAddress() ? address.toIPv4Address().toString() : address.toString();
  }
  if (type !== 'cidr') throw httpError(400, 'invalid_request', 'Unsupported IP rule type');
  const parts = value.split('/');
  if (parts.length !== 2 || !/^(0|[1-9]\d{0,2})$/.test(parts[1])) {
    throw httpError(400, 'invalid_request', 'CIDR must contain a valid prefix');
  }
  let address = parseIp(parts[0]);
  let prefix = Number(parts[1]);
  const bits = address.kind() === 'ipv4' ? 32 : 128;
  if (prefix > bits) throw httpError(400, 'invalid_request', 'CIDR prefix is out of range');
  if (address.kind() === 'ipv6' && address.isIPv4MappedAddress() && prefix >= 96) {
    address = address.toIPv4Address();
    prefix -= 96;
  }
  const bytes = address.toByteArray().map((byte, index) => {
    const keep = Math.min(8, Math.max(0, prefix - index * 8));
    return byte & (keep === 0 ? 0 : (0xff << (8 - keep)) & 0xff);
  });
  return `${ipaddr.fromByteArray(bytes).toString()}/${prefix}`;
}

export function matchesRule(address, rule) {
  const candidates = [address];
  if (address.kind() === 'ipv6' && address.isIPv4MappedAddress()) candidates.push(address.toIPv4Address());
  if (rule.type === 'ip') {
    const expected = ipaddr.parse(rule.value);
    return candidates.some(candidate => candidate.kind() === expected.kind() && candidate.toString() === expected.toString());
  }
  if (rule.type === 'cidr') {
    const [network, prefix] = ipaddr.parseCIDR(rule.value);
    return candidates.some(candidate => candidate.kind() === network.kind() && candidate.match(network, prefix));
  }
  return false;
}
