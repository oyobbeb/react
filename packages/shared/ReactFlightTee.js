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
export type FlightTee = {
  +_version: number,
  // Returns false if the tee is already connected to another request.
  _connect(): boolean,
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
