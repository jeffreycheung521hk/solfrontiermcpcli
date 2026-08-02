// Newline-delimited JSON framing.
//
// Extracted as its own unit because it is the one place where a subtle bug
// is both easy to write and nearly impossible to notice in production:
//
//  * chunk boundaries fall anywhere, including mid-line AND mid-character;
//    StringDecoder holds partial multi-byte sequences instead of emitting
//    U+FFFD replacement characters that would silently corrupt a payload
//  * a trailing \r (CRLF) must not reach JSON.parse
//  * a blank line is not a frame
//
// The class is deliberately free of transport concerns so it can be tested
// against arbitrary chunk splittings.
import { StringDecoder } from 'node:string_decoder';

export class LineFramer {
  #decoder = new StringDecoder('utf8');
  #buffer = '';

  /**
   * Feed one chunk; get back the complete lines it completed.
   * @param {Buffer|string} chunk
   * @returns {string[]} zero or more complete, non-empty lines
   */
  push(chunk) {
    this.#buffer += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
    const lines = [];
    let nl;
    while ((nl = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, nl).replace(/\r$/, '').trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (line) lines.push(line);
    }
    return lines;
  }

  /** Anything buffered but not yet terminated by a newline. */
  get pending() {
    return this.#buffer;
  }
}
