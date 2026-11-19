/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Thenable} from 'shared/ReactTypes';
import type {FlightTee, FlightTeeRow} from 'shared/ReactFlightTee';
import type {
  Response,
  StreamState,
  RowInitialization,
} from './ReactFlightClient';

import {FLIGHT_TEE_VERSION} from 'shared/ReactFlightTee';
import {enableFlightTee} from 'shared/ReactFeatureFlags';

import {
  createStreamState,
  getRoot,
  processWireRow,
  processWireText,
  processWireBinary,
  setReaderContext,
  beginRow,
  endRow,
  abortRow,
  beginElement,
  completeElement,
  decodeModelString,
  ELEMENT_FIELDS,
  close,
  reportGlobalError,
} from './ReactFlightClient';

// The client side of a tee (see shared/ReactFlightTee). It reads one Flight
// render into one Response.
type TeeInstance = {
  +_version: number,
  +_elementFields: Object,
  _response: Response,
  _streamState: StreamState,
  _connected: boolean,
  _read: boolean,
  // Hints and module preinits that arrived before the reader did.
  _readerTasks: null | Array<() => void>,
  // How many model rows were built by value, for tests.
  _rowsByValue: number,
  _connect(): boolean,
  _beginRow(id: number): null | FlightTeeRow,
  _endRow(row: FlightTeeRow, value: mixed): void,
  _abortRow(row: FlightTeeRow): void,
  _beginElement(): void,
  _completeElement(
    type: mixed,
    key: mixed,
    props: mixed,
    owner: mixed,
    stack: mixed,
    validated: number,
  ): mixed,
  _decode(parent: Object, key: string, value: string): mixed,
  _processWireRow(row: string): void,
  _processWireText(id: number, text: string): void,
  _processWireBinary(id: number, tag: number, bytes: Uint8Array): void,
  _close(): void,
  _error(error: mixed): void,
};

// The methods are shared by every tee, and every tee has the same shape, so
// the server's calls stay monomorphic.
function connect(this: TeeInstance): boolean {
  if (this._connected) {
    return false;
  }
  this._connected = true;
  return true;
}

function teeBeginRow(this: TeeInstance, id: number): null | FlightTeeRow {
  return beginRow(this._response, this._streamState, id);
}

function teeEndRow(this: TeeInstance, row: FlightTeeRow, value: mixed): void {
  this._rowsByValue++;
  endRow(this._response, row as any as RowInitialization, value);
}

function teeAbortRow(this: TeeInstance, row: FlightTeeRow): void {
  abortRow(row as any as RowInitialization);
}

function teeBeginElement(this: TeeInstance): void {
  beginElement();
}

function teeCompleteElement(
  this: TeeInstance,
  type: mixed,
  key: mixed,
  props: mixed,
  owner: mixed,
  stack: mixed,
  validated: number,
): mixed {
  return completeElement(
    this._response,
    type,
    key,
    props,
    owner as any,
    stack as any,
    validated as any,
  );
}

function teeDecode(
  this: TeeInstance,
  parent: Object,
  key: string,
  value: string,
): mixed {
  return decodeModelString(this._response, parent, key, value);
}

function teeProcessWireRow(this: TeeInstance, row: string): void {
  processWireRow(this._response, this._streamState, row);
}

function teeProcessWireText(this: TeeInstance, id: number, text: string): void {
  processWireText(this._response, this._streamState, id, text);
}

function teeProcessWireBinary(
  this: TeeInstance,
  id: number,
  tag: number,
  bytes: Uint8Array,
): void {
  processWireBinary(this._response, this._streamState, id, tag, bytes);
}

function teeClose(this: TeeInstance): void {
  close(this._response);
}

function teeError(this: TeeInstance, error: mixed): void {
  reportGlobalError(this._response, error as any);
}

export function createTee(response: Response): FlightTee {
  if (!enableFlightTee) {
    throw new Error('createTee is not supported in this build of React.');
  }
  const readerTasks: Array<() => void> = [];
  const tee: TeeInstance = {
    _version: FLIGHT_TEE_VERSION,
    _elementFields: ELEMENT_FIELDS,
    _response: response,
    // There's no stream to show as the I/O's value in DEV.
    _streamState: createStreamState(response, null),
    _connected: false,
    _read: false,
    _readerTasks: readerTasks,
    _rowsByValue: 0,
    _connect: connect,
    _beginRow: teeBeginRow,
    _endRow: teeEndRow,
    _abortRow: teeAbortRow,
    _beginElement: teeBeginElement,
    _completeElement: teeCompleteElement,
    _decode: teeDecode,
    _processWireRow: teeProcessWireRow,
    _processWireText: teeProcessWireText,
    _processWireBinary: teeProcessWireBinary,
    _close: teeClose,
    _error: teeError,
  };
  setReaderContext(response, task => {
    readerTasks.push(task);
  });
  return tee;
}

// Reads the tee's root. Call it after the tee has been passed to the server's
// render, from inside the reader's context: `runInReaderContext` runs a task
// there.
export function createFromTee<T>(
  flightTee: FlightTee,
  runInReaderContext: (task: () => void) => void,
): Thenable<T> {
  const tee: TeeInstance = flightTee as any;
  if (tee._read) {
    throw new Error(
      'A Flight tee can only be read once. Read any later copies from the stream.',
    );
  }
  if (!tee._connected) {
    throw new Error(
      'The tee has not been passed to a render. Pass it as the `tee` option ' +
        'of a Flight render before reading it.',
    );
  }
  tee._read = true;
  const readerTasks = tee._readerTasks;
  tee._readerTasks = null;
  setReaderContext(tee._response, runInReaderContext);
  if (readerTasks !== null) {
    for (let i = 0; i < readerTasks.length; i++) {
      runInReaderContext(readerTasks[i]);
    }
  }
  return getRoot(tee._response);
}
