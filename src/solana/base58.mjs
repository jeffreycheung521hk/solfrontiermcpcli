// Base58 (Bitcoin alphabet), the encoding of every Solana address, blockhash
// and signature string.
//
// Byte-wise arithmetic instead of one BigInt: the same code serves 32-byte
// keys and 1232-byte transactions without quadratic BigInt division, and it
// keeps leading zero bytes explicit ('1' per zero byte), which is exactly where
// naive implementations lose data -- the System program id is 32 zero bytes.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((ch, i) => [ch, i]));

/**
 * Encode bytes as base58.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function encode(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('base58.encode expects a Uint8Array');
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = []; // base-58 digits, little-endian
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

/**
 * Decode a base58 string. Throws on a non-string or any character outside the
 * alphabet (0, O, I, l, whitespace, ...): a silently skipped character would
 * turn one address into another.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function decode(text) {
  if (typeof text !== 'string') throw new TypeError('base58.decode expects a string');
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  const bytes = []; // little-endian
  for (let i = zeros; i < text.length; i++) {
    const digit = INDEX.get(text[i]);
    if (digit === undefined) throw new Error(`invalid base58 character at position ${i}`);
    let carry = digit;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

/**
 * Decode a base58 public key and insist on 32 bytes.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function decodePublicKey(text) {
  const bytes = decode(text);
  if (bytes.length !== 32) throw new Error(`expected a 32-byte public key, got ${bytes.length} bytes`);
  return bytes;
}
