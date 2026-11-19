/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// A tee lets a Flight Client in the same process read a Flight render without
// parsing its bytes. The client creates it with `createTee` and it's passed to
// the server render, which keeps writing bytes to its destination and also
// hands every row to the tee as it's emitted. The reader then calls
// `createFromTee` to get the root.
//
// The server and client are built as separate bundles, so the server checks
// that the tee's version matches its own.
export const FLIGHT_TEE_VERSION = 1;

// The methods the server calls. Rows arrive in the order the server emits
// them, which isn't the order they're written to the destination.
//
// A model row is built by value: the server calls `_beginRow`, builds the
// row's value with `_decode`, `_beginElement` and `_completeElement` while it
// walks the row, and calls `_endRow` with the value. Every other row, and a
// model row that `_beginRow` declines, is passed as wire text and parsed.
export type FlightTee = {
  +_version: number,
  // Stands for an element's own fields when decoding them, keyed by their
  // slot in the wire tuple: props ('3'), owner ('4') and debug stack ('5').
  +_elementFields: Object,
  // Returns false if the tee is already connected to another request.
  _connect(): boolean,
  // Begins building model row `id`. Returns null if the row can't be built by
  // value, in which case the server sends it as wire text instead.
  _beginRow(id: number): null | FlightTeeRow,
  // Ends a row with the value built for it.
  _endRow(row: FlightTeeRow, value: mixed): void,
  // Abandons a row whose walk threw. The row stays pending.
  _abortRow(row: FlightTeeRow): void,
  // Enters an element, before any of its fields are decoded.
  _beginElement(): void,
  // Creates the element and leaves it.
  _completeElement(
    type: mixed,
    key: mixed,
    props: mixed,
    owner: mixed,
    stack: mixed,
    validated: number,
  ): mixed,
  // Decodes a `$` string. `parent` is the value it goes in, and `key` its key
  // there, so that a reference that hasn't resolved yet can fill it in later.
  _decode(parent: Object, key: string, value: string): mixed,
  // A complete row, including its header and trailing newline.
  _processWireRow(row: string): void,
  // A length-prefixed text row. The text is passed by reference.
  _processWireText(id: number, text: string): void,
  // A length-prefixed binary row. The tee copies the bytes.
  _processWireBinary(id: number, tag: number, bytes: Uint8Array): void,
  // The render finished and both destinations would close.
  _close(): void,
  // The render failed with a fatal error and the destination would error.
  _error(error: mixed): void,
  ...
};

// Opaque to the server.
export type FlightTeeRow = {...};
