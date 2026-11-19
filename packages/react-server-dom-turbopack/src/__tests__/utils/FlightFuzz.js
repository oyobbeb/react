/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

// Fuzz testing for Flight consumers. A scenario is a seeded model that
// several render paths consume; what they produce must normalize to the same
// structure. The generator, the normalizer and the harness live here so that
// every consumer's test compares the same way.

const REACT_ELEMENT_TYPE = Symbol.for('react.transitional.element');
const REACT_LAZY_TYPE = Symbol.for('react.lazy');
const REACT_FRAGMENT_TYPE = Symbol.for('react.fragment');
const REACT_SUSPENSE_TYPE = Symbol.for('react.suspense');

// mulberry32: deterministic across runs so a failing seed replays exactly.
function createRng(seed) {
  let state = seed >>> 0;
  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    int(max) {
      return Math.floor(next() * max);
    },
    pick(items) {
      return items[Math.floor(next() * items.length)];
    },
    chance(probability) {
      return next() < probability;
    },
  };
}

exports.createRng = createRng;

// Pending promises are created during generation and resolved later in rng
// order, so the same seed produces the same resolution order on every path.
function createScheduler(rng) {
  const pending = [];
  return {
    defer(settle) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // Flight attaches handlers lazily; an unobserved rejection would fail
      // the run before the consumer gets to it.
      promise.catch(() => {});
      pending.push(() => settle(resolve, reject));
      return promise;
    },
    hasPending() {
      return pending.length > 0;
    },
    settleOne() {
      const index = rng.int(pending.length);
      const settle = pending[index];
      pending.splice(index, 1);
      settle();
    },
  };
}

exports.createScheduler = createScheduler;

// Generates a model from a grammar of values Flight can carry. `env` provides
// the server React, the client component references and the scheduler.
// Server Components are generated as closures over generated return values so
// that both arms execute the same function bodies.
function generateModel(rng, env, options) {
  const {React, Show, Box, scheduler} = env;
  const maxDepth = options.maxDepth === undefined ? 5 : options.maxDepth;
  const shared = [];
  let componentCount = 0;
  let errorCount = 0;
  // Values that cannot be placed inside an item: a value a stream or an
  // async iterable yields, or an element of an iterable that is not an
  // array. Flight renders a stream's items outside of its work loop, with no
  // hooks dispatcher, so nothing below one may call use(). And a cycle that
  // closes inside any item is not detected: the serializer recurses until
  // the stack overflows, at a depth that varies between renders.
  const unsafeInItem = new WeakSet();
  // Counts the values unsafe in an item generated or placed so far, so that
  // a node can tell whether its subtree holds one.
  let unsafeInItemCount = 0;
  // Called where a value unsafe in an item is placed: every data container
  // around it holds it too.
  function markUnsafeInItem() {
    unsafeInItemCount++;
    for (let i = 0; i < ancestors.length; i++) {
      unsafeInItem.add(ancestors[i]);
    }
  }

  function maybeShare(value) {
    if (value !== null && typeof value === 'object' && rng.chance(0.3)) {
      shared.push(value);
    }
    return value;
  }

  function genString() {
    const kind = rng.int(5);
    switch (kind) {
      case 0:
        return '';
      case 1:
        // Leading '$' is the escape prefix on the wire.
        return '$' + rng.int(1000);
      case 2:
        // Large strings are written as separate text rows. Not with invalid
        // values: the error message that describes the parent repeats the
        // string, and the test environment caps loop iterations.
        return options.allowInvalid
          ? 'x'.repeat(16)
          : 'x'.repeat(1024 + rng.int(512));
      case 3:
        return 'héllo wörld ' + rng.int(100);
      default:
        return 'str' + rng.int(1000);
    }
  }

  function genPrimitive() {
    const kind = rng.int(9);
    switch (kind) {
      case 0:
        return null;
      case 1:
        return undefined;
      case 2:
        return rng.chance(0.5);
      case 3:
        return rng.int(100000) - 50000;
      case 4:
        return rng.pick([NaN, Infinity, -Infinity, -0, 1.5]);
      case 5:
        return BigInt(rng.int(100000));
      default:
        return genString();
    }
  }

  // Containers whose children are being generated. A child that is one of
  // them closes a cycle.
  const ancestors = [];
  function genContainer(container, fill) {
    ancestors.push(container);
    try {
      fill();
    } finally {
      ancestors.pop();
    }
    return maybeShare(container);
  }
  // A child of a container: sometimes an enclosing container (a cycle), and
  // sometimes an object an earlier sibling already holds (deduped within the
  // row). `siblings` collects the container's object children.
  function genChild(depth, siblings) {
    if (insideItem === 0 && ancestors.length > 0 && rng.chance(0.1)) {
      markUnsafeInItem();
      return rng.pick(ancestors);
    }
    if (siblings.length > 0 && rng.chance(0.15)) {
      return rng.pick(siblings);
    }
    const value = genData(depth);
    if (value !== null && typeof value === 'object') {
      siblings.push(value);
    }
    return value;
  }

  function genData(depth) {
    if (depth <= 0 || rng.chance(0.2)) {
      return genPrimitive();
    }
    if (shared.length > 0 && rng.chance(0.15)) {
      const candidates =
        insideItem > 0
          ? shared.filter(value => !unsafeInItem.has(value))
          : shared;
      if (candidates.length > 0) {
        const value = rng.pick(candidates);
        if (unsafeInItem.has(value)) {
          markUnsafeInItem();
        }
        return value;
      }
    }
    if (options.allowInvalid && rng.chance(0.2)) {
      return genInvalid();
    }
    // With invalid values, no streams. In DEV, a stream item that refers to
    // an errored row leaves an unhandled rejection in the client:
    // reactPromiseThen's DEV wrapper is chained with no reject callback.
    const kind = rng.int(options.allowInvalid ? 12 : 14);
    switch (kind) {
      case 12:
        return genStream(depth - 1);
      case 13:
        return genAsyncIterable(depth - 1, genData, false);
      case 8:
        return Symbol.for('sym' + rng.int(3));
      case 9:
        return 'str' + rng.int(1000);
      case 10: {
        // A multi-shot iterable that is not an array.
        const items = [
          genItem(depth - 1, genData),
          genItem(depth - 1, genData),
        ];
        return {
          [Symbol.iterator]() {
            return items[Symbol.iterator]();
          },
        };
      }
      case 11:
        return rng.chance(0.5)
          ? new Uint8Array([rng.int(256), rng.int(256)])
          : new Error('value ' + rng.int(100));
      case 0: {
        const length = 1 + rng.int(4);
        const array = [];
        const siblings = [];
        return genContainer(array, () => {
          for (let i = 0; i < length; i++) {
            array.push(genChild(depth - 1, siblings));
          }
        });
      }
      case 1:
        return new Date(rng.int(2000000000000));
      case 2: {
        const map = new Map();
        const size = 1 + rng.int(3);
        const siblings = [];
        return genContainer(map, () => {
          for (let i = 0; i < size; i++) {
            const key = genChild(depth - 1, siblings);
            map.set(key, genChild(depth - 1, siblings));
          }
        });
      }
      case 3: {
        const set = new Set();
        const size = 1 + rng.int(3);
        const siblings = [];
        return genContainer(set, () => {
          for (let i = 0; i < size; i++) {
            set.add(genChild(depth - 1, siblings));
          }
        });
      }
      case 4:
        return genPromise(depth - 1, genData);
      default: {
        const object = {};
        const size = 1 + rng.int(4);
        const siblings = [];
        return genContainer(object, () => {
          for (let i = 0; i < size; i++) {
            object['k' + i] = genChild(depth - 1, siblings);
          }
        });
      }
    }
  }

  // Streams and async iterables settle through the scheduler so that their
  // timing relative to the consumers is seeded too.
  function genStream(depth) {
    if (rng.chance(0.4)) {
      const chunks = [
        new Uint8Array([rng.int(256), rng.int(256)]),
        new Uint8Array([rng.int(256)]),
      ];
      return new ReadableStream({
        type: 'bytes',
        async start(controller) {
          for (let i = 0; i < chunks.length; i++) {
            await scheduler.defer(resolve => resolve());
            controller.enqueue(chunks[i]);
          }
          controller.close();
        },
      });
    }
    const chunks = [genItem(depth, genData), genItem(depth, genData)];
    return new ReadableStream({
      async start(controller) {
        for (let i = 0; i < chunks.length; i++) {
          await scheduler.defer(resolve => resolve());
          controller.enqueue(chunks[i]);
        }
        controller.close();
      },
    });
  }

  // Whether an item is being generated. See unsafeInItem.
  let insideItem = 0;
  function genItem(depth, gen) {
    insideItem++;
    try {
      return gen(depth);
    } finally {
      insideItem--;
    }
  }

  function genAsyncIterable(depth, gen, multiShot) {
    const items = [genItem(depth, gen), genItem(depth, gen)];
    const gates = items.map(() => scheduler.defer(resolve => resolve()));
    async function* generate() {
      for (let i = 0; i < items.length; i++) {
        await gates[i];
        yield items[i];
      }
    }
    let iterable;
    if (!multiShot && rng.chance(0.5)) {
      // An async generator object is its own iterator: single-shot.
      iterable = generate();
    } else {
      iterable = {
        [Symbol.asyncIterator]: generate,
      };
    }
    iterable.debugItems = items;
    return iterable;
  }

  // Values the serializer rejects. Each arm must report the same error.
  function genInvalid() {
    const kind = rng.int(5);
    switch (kind) {
      case 0:
        return function notAnAction() {};
      case 1:
        return Symbol('local' + rng.int(10));
      case 2:
        return new (class Model {
          constructor() {
            this.field = rng.int(10);
          }
        })();
      case 3: {
        const object = Object.create(null);
        object.field = rng.int(10);
        return object;
      }
      default:
        return {onClick: function handler() {}};
    }
  }

  function genPromise(depth, gen) {
    const kind = rng.int(3);
    if (kind === 0) {
      return Promise.resolve(gen(depth));
    }
    if (kind === 1 && options.allowErrors) {
      const error = new Error('rejected ' + errorCount++);
      return scheduler.defer((resolve, reject) => reject(error));
    }
    const value = gen(depth);
    return scheduler.defer(resolve => resolve(value));
  }

  // Elements in an array need keys or React warns, so those get unique ones;
  // elsewhere a key is optional.
  let keyCount = 0;
  function genKey(inArray) {
    if (inArray) {
      return 'i' + keyCount++;
    }
    return rng.chance(0.3) ? 'key' + rng.int(5) : null;
  }

  // createElement reads any present key, so a null key must be absent.
  function keyProps(key) {
    return key === null ? {} : {key};
  }

  // Children passed as an array. Spread into createElement instead, the same
  // list needs no keys.
  function genChildren(depth, inArray) {
    const length = 1 + rng.int(3);
    const children = [];
    for (let i = 0; i < length; i++) {
      children.push(genNode(depth - 1, inArray));
    }
    return children;
  }

  const sharedNodes = [];
  function maybeShareNode(node) {
    if (node !== null && typeof node === 'object' && rng.chance(0.3)) {
      sharedNodes.push(node);
    }
    return node;
  }

  function genNode(depth, inArray) {
    if (depth <= 0) {
      return rng.chance(0.5) ? genString() : null;
    }
    // The same element object in two places, including Server Components.
    // Not inside an array, where the repeated key would warn.
    if (!inArray && sharedNodes.length > 0 && rng.chance(0.1)) {
      let candidates = sharedNodes;
      if (insideItem > 0) {
        candidates = candidates.filter(node => !unsafeInItem.has(node));
      }
      if (candidates.length > 0) {
        const node = rng.pick(candidates);
        if (unsafeInItem.has(node)) {
          markUnsafeInItem();
        }
        return node;
      }
    }
    const before = unsafeInItemCount;
    const node = genNodeImpl(depth, inArray);
    if (node !== null && unsafeInItemCount !== before) {
      unsafeInItem.add(node);
    }
    return maybeShareNode(node);
  }

  function genNodeImpl(depth, inArray) {
    const kind = rng.int(options.allowInvalid ? 11 : 12);
    const key = genKey(inArray);
    switch (kind) {
      case 11:
        // Async iterable children render as a fragment. React rejects an
        // iterator here since rendering may enumerate it more than once.
        return genAsyncIterable(depth - 1, d => genNode(d, true), true);
      case 10:
        // Errors below a boundary stay inside it in the HTML.
        return React.createElement(
          REACT_SUSPENSE_TYPE,
          Object.assign(keyProps(key), {
            fallback: 'loading ' + rng.int(100),
          }),
          ...genChildren(depth, false),
        );
      case 0:
      case 1: {
        const props = {};
        if (rng.chance(0.5)) {
          props.className = 'c' + rng.int(5);
        }
        if (rng.chance(0.5)) {
          props['data-x'] = String(genPrimitive());
        }
        props.children = genChildren(depth, true);
        return React.createElement(
          rng.pick(['div', 'span', 'p']),
          Object.assign(keyProps(key), props),
        );
      }
      case 2:
        return React.createElement(
          REACT_FRAGMENT_TYPE,
          keyProps(key),
          ...genChildren(depth, false),
        );
      case 3:
        return genChildren(depth, true);
      case 4: {
        // Client Component receiving data props, sometimes a single-shot
        // iterator. Where the element is shared, the second read finds it
        // exhausted, on every path alike.
        let value;
        if (rng.chance(0.15)) {
          const items = [genData(depth - 1), genData(depth - 1)];
          value = items[Symbol.iterator]();
        } else {
          value = genData(depth - 1);
        }
        return React.createElement(Show, Object.assign(keyProps(key), {value}));
      }
      case 5: {
        return React.createElement(
          Box,
          Object.assign(keyProps(key), {label: genString()}),
          ...genChildren(depth, false),
        );
      }
      case 6:
      case 7:
      case 8: {
        return genServerComponentElement(depth, key);
      }
      default:
        return genString();
    }
  }

  function genServerComponentElement(depth, key) {
    const id = componentCount++;
    let kind = rng.int(5);
    if (kind === 2 && insideItem > 0) {
      kind = 0;
    }
    const props = {label: 'c' + id};
    let Component;
    let debugOutput;
    function genOutput(gen) {
      const output = gen();
      debugOutput = output;
      return output;
    }
    switch (kind) {
      case 0: {
        const output = genOutput(() => genNode(depth - 1, false));
        Component = function Sync() {
          return output;
        };
        break;
      }
      case 1: {
        const output = genOutput(() => genNode(depth - 1, false));
        const promise = scheduler.defer(resolve => resolve(output));
        Component = async function Async() {
          return await promise;
        };
        break;
      }
      case 2: {
        markUnsafeInItem();
        const output = genOutput(() => genNode(depth - 1, false));
        const promise = scheduler.defer(resolve => resolve(output));
        Component = function Using() {
          return React.use(promise);
        };
        break;
      }
      case 3: {
        if (options.allowErrors) {
          const error = new Error('thrown ' + errorCount++);
          if (rng.chance(0.3)) {
            Component = function Throwing() {
              throw error;
            };
          } else {
            const promise = scheduler.defer(resolve => resolve(null));
            Component = async function ThrowingLater() {
              await promise;
              throw error;
            };
          }
        } else {
          const output = genOutput(() => genChildren(depth - 1, true));
          Component = function ReturningArray() {
            return output;
          };
        }
        break;
      }
      default: {
        // The output renders inside a host element.
        const output = genOutput(() => genNode(depth - 1, false));
        Component = function Nested(nestedProps) {
          return React.createElement(
            'div',
            {className: nestedProps.label},
            output,
          );
        };
      }
    }
    Object.defineProperty(Component, 'name', {value: 'SC' + id});

    const Counted = function (componentProps) {
      env.onRender();
      return Component(componentProps);
    };
    Object.defineProperty(Counted, 'name', {value: 'SC' + id});
    // For debugging dumps only.
    Counted.debugOutput = debugOutput;
    const element = React.createElement(
      Counted,
      key === null ? props : Object.assign({key}, props),
    );
    return element;
  }

  const kind = options.kind || (rng.chance(0.7) ? 'tree' : 'data');
  const model =
    kind === 'tree'
      ? React.createElement('main', null, genChildren(maxDepth, true))
      : genData(maxDepth);
  return {model, kind};
}

exports.generateModel = generateModel;

// Resolves lazies and thenables and replaces objects with a comparable
// structure. Values are compared structurally: the wire path copies a shared
// object again when it meets it inside a keyed Server Component, while an
// in-process consumer may hand out the same object, and React treats both the
// same. Whether sharing survives is checked separately.
async function normalize(root, env) {
  const visiting = new Set();
  // Streams and iterators can only be read once; a second reference to one
  // gets what the first read saw.
  const consumed = new Map();

  async function visit(value) {
    if (value !== null && typeof value === 'object' && consumed.has(value)) {
      return consumed.get(value);
    }
    return visitOnce(value);
  }

  async function visitOnce(value) {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'function') {
        return {$$: 'function', name: env.nameOf(value)};
      }
      if (typeof value === 'bigint') {
        return {$$: 'bigint', value: value.toString()};
      }
      if (typeof value === 'number') {
        if (Object.is(value, -0)) {
          return {$$: 'number', value: '-0'};
        }
        if (!Number.isFinite(value)) {
          return {$$: 'number', value: String(value)};
        }
      }
      if (typeof value === 'symbol') {
        return {$$: 'symbol', description: value.description};
      }
      return value;
    }
    if (
      typeof ReadableStream === 'function' &&
      value instanceof ReadableStream
    ) {
      const reader = value.getReader();
      const chunks = [];
      const read = {$$: 'stream', chunks};
      consumed.set(value, read);
      try {
        while (true) {
          const {done, value: chunk} = await reader.read();
          if (done) {
            break;
          }
          chunks.push(await visit(chunk));
        }
      } catch (error) {
        read.error = await visitError(error);
      }
      return read;
    }
    if (typeof value[Symbol.asyncIterator] === 'function') {
      const items = [];
      const iterator = value[Symbol.asyncIterator]();
      const read = {$$: 'asyncIterable', isIterator: iterator === value, items};
      consumed.set(value, read);
      try {
        while (true) {
          const {done, value: item} = await iterator.next();
          if (done) {
            break;
          }
          items.push(await visit(item));
        }
      } catch (error) {
        read.error = await visitError(error);
      }
      return read;
    }
    if (
      typeof value.next === 'function' &&
      typeof value[Symbol.iterator] === 'function'
    ) {
      const items = [];
      const read = {$$: 'iterator', items};
      consumed.set(value, read);
      const iterated = Array.from(value);
      for (let i = 0; i < iterated.length; i++) {
        items.push(await visit(iterated[i]));
      }
      return read;
    }
    if (value.$$typeof === REACT_LAZY_TYPE) {
      // Whether a value arrives inline or behind a lazy depends on timing,
      // and React renders both the same, so lazies are transparent here.
      let resolved;
      try {
        resolved = await readLazy(value);
      } catch (reason) {
        return {$$: 'lazy-error', value: await visitError(reason)};
      }
      return visit(resolved);
    }
    if (typeof value.then === 'function') {
      let settled;
      try {
        settled = {status: 'fulfilled', value: await value};
      } catch (reason) {
        settled = {status: 'rejected', reason};
      }
      return {
        $$: 'promise',
        status: settled.status,
        value:
          settled.status === 'fulfilled'
            ? await visit(settled.value)
            : await visitError(settled.reason),
      };
    }
    if (value instanceof Date) {
      return {$$: 'date', value: value.toISOString()};
    }
    if (visiting.has(value)) {
      return {$$: 'cycle'};
    }
    visiting.add(value);
    let result;
    if (value.$$typeof === REACT_ELEMENT_TYPE) {
      result = {
        $$: 'element',
        type:
          typeof value.type === 'string'
            ? value.type
            : typeof value.type === 'symbol'
              ? {$$: 'symbol', description: value.type.description}
              : await visit(value.type),
        key: value.key,
        props: await visit(value.props),
      };
    } else if (Array.isArray(value)) {
      result = {$$: 'array', items: []};
      for (let i = 0; i < value.length; i++) {
        result.items.push(await visit(value[i]));
      }
    } else if (value instanceof Map) {
      result = {$$: 'map', entries: []};
      const entries = Array.from(value);
      for (let i = 0; i < entries.length; i++) {
        result.entries.push([
          await visit(entries[i][0]),
          await visit(entries[i][1]),
        ]);
      }
    } else if (value instanceof Set) {
      result = {$$: 'set', items: []};
      const items = Array.from(value);
      for (let i = 0; i < items.length; i++) {
        result.items.push(await visit(items[i]));
      }
    } else if (ArrayBuffer.isView(value)) {
      result = {
        $$: 'view',
        type: value.constructor.name,
        bytes: Array.from(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        ),
      };
    } else if (value instanceof Error) {
      result = await visitError(value);
    } else {
      result = {$$: 'object', props: {}};
      const keys = Object.keys(value);
      for (let i = 0; i < keys.length; i++) {
        result.props[keys[i]] = await visit(value[keys[i]]);
      }
    }
    visiting.delete(value);
    return result;
  }

  async function visitError(error) {
    if (error instanceof Error) {
      return {
        $$: 'error',
        message: error.message,
        digest: error.digest,
      };
    }
    return {$$: 'thrown', value: await visit(error)};
  }

  async function readLazy(lazy) {
    while (true) {
      try {
        return lazy._init(lazy._payload);
      } catch (thrown) {
        if (
          thrown !== null &&
          typeof thrown === 'object' &&
          typeof thrown.then === 'function'
        ) {
          await thrown;
          continue;
        }
        throw thrown;
      }
    }
  }

  return visit(root);
}

exports.normalize = normalize;

// Same shape as `normalize`, for rendering props inside a Client Component
// under Fizz: thenables go through `use`, so a pending value suspends the
// component rather than being awaited here.
function describeProps(root, use) {
  const visiting = new Set();

  function visit(value) {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'bigint') {
        return {$$: 'bigint', value: value.toString()};
      }
      if (typeof value === 'number') {
        if (Object.is(value, -0)) {
          return {$$: 'number', value: '-0'};
        }
        if (!Number.isFinite(value)) {
          return {$$: 'number', value: String(value)};
        }
      }
      if (typeof value === 'function') {
        return {$$: 'function', name: value.name};
      }
      if (typeof value === 'symbol') {
        return {$$: 'symbol', description: value.description};
      }
      return value;
    }
    if (
      typeof ReadableStream === 'function' &&
      value instanceof ReadableStream
    ) {
      return {$$: 'stream'};
    }
    if (typeof value[Symbol.asyncIterator] === 'function') {
      return {$$: 'asyncIterable'};
    }
    if (
      typeof value.next === 'function' &&
      typeof value[Symbol.iterator] === 'function'
    ) {
      return {$$: 'iterator', items: Array.from(value).map(visit)};
    }
    if (value.$$typeof === REACT_LAZY_TYPE) {
      return visit(value._init(value._payload));
    }
    if (typeof value.then === 'function') {
      return {$$: 'promise', value: visit(use(value))};
    }
    if (value instanceof Date) {
      return {$$: 'date', value: value.toISOString()};
    }
    if (value instanceof Error) {
      return {$$: 'error', message: value.message};
    }
    if (visiting.has(value)) {
      return {$$: 'cycle'};
    }
    visiting.add(value);
    let result;
    if (value.$$typeof === REACT_ELEMENT_TYPE) {
      result = {
        $$: 'element',
        type: typeof value.type === 'string' ? value.type : '<component>',
        key: value.key,
        props: visit(value.props),
      };
    } else if (Array.isArray(value)) {
      result = {$$: 'array', items: value.map(visit)};
    } else if (value instanceof Map) {
      const entries = Array.from(value).map(([k, v]) => [visit(k), visit(v)]);
      result = {$$: 'map', entries};
    } else if (value instanceof Set) {
      result = {$$: 'set', items: Array.from(value).map(visit)};
    } else {
      const props = {};
      const keys = Object.keys(value);
      for (let i = 0; i < keys.length; i++) {
        props[keys[i]] = visit(value[keys[i]]);
      }
      result = {$$: 'object', props};
    }
    visiting.delete(value);
    return result;
  }

  return JSON.stringify(visit(root), (key, value) =>
    value === undefined ? '$undefined' : value,
  );
}

exports.describeProps = describeProps;

// A readable outline of a generated model: elements, the output a generated
// Server Component returns, the items a generated stream yields, and shared
// objects by number.
function describeModel(model) {
  const seen = new Map();
  function describe(value, depth) {
    if (value === null || typeof value !== 'object') {
      return typeof value === 'function'
        ? 'fn:' + (value.name || '?')
        : typeof value === 'string'
          ? JSON.stringify(value.slice(0, 20))
          : String(value);
    }
    if (seen.has(value)) {
      return '#' + seen.get(value);
    }
    const id = seen.size;
    seen.set(value, id);
    const pad = ' '.repeat(depth + 1);
    const list = items =>
      items.map(item => '\n' + pad + describe(item, depth + 1)).join('');
    if (value.$$typeof === REACT_ELEMENT_TYPE) {
      const type =
        typeof value.type === 'string'
          ? value.type
          : typeof value.type === 'symbol'
            ? value.type.description
            : value.type.$$id
              ? 'client:' + value.type.$$id.slice(-10)
              : value.type.name;
      const props = Object.keys(value.props)
        .map(k => '\n' + pad + k + ': ' + describe(value.props[k], depth + 1))
        .join('');
      const output =
        typeof value.type === 'function' && 'debugOutput' in value.type
          ? '\n' + pad + '=> ' + describe(value.type.debugOutput, depth + 1)
          : '';
      return (
        `#${id} <${type} key=${JSON.stringify(value.key)}>` + props + output
      );
    }
    if (Array.isArray(value)) {
      return `#${id} [` + list(value) + ']';
    }
    if (typeof value[Symbol.asyncIterator] === 'function') {
      return (
        `#${id} asyncIterable` +
        (value.debugItems ? list(value.debugItems) : '')
      );
    }
    if (typeof value.then === 'function') {
      return `#${id} promise`;
    }
    if (value instanceof Map) {
      return `#${id} Map` + list(Array.from(value).flat());
    }
    if (value instanceof Set) {
      return `#${id} Set` + list(Array.from(value));
    }
    if (Object.getPrototypeOf(value) === Object.prototype) {
      const props = Object.keys(value)
        .map(k => '\n' + pad + k + ': ' + describe(value[k], depth + 1))
        .join('');
      return `#${id} {` + props + '}';
    }
    return `#${id} ` + Object.prototype.toString.call(value);
  }
  return describe(model, 0);
}

exports.describeModel = describeModel;

// The harness a fuzz suite builds in beforeEach from the modules it required:
// the Client Components every scenario uses, how a scenario is read the way
// the browser reads it, and how a read is observed. Bundler specifics come in
// through `env`:
//
//   clientExports(moduleExports, chunk, blockOnChunk): registers a Client
//     Component module, loading `chunk` when `blockOnChunk` settles.
//   clientManifest: the server's client reference manifest.
//   moduleLoading: the consumer manifest's moduleLoading.
function createHarness(env) {
  const {
    React,
    ReactServer,
    ReactDOMFizzStatic,
    ReactServerDOMServer,
    ReactServerDOMClient,
    Stream,
    serverAct,
    clientExports,
    clientManifest,
    moduleLoading,
  } = env;
  let moduleCount = 0;

  // Client Components shared by every generated scenario. `Show` renders a
  // description of its props so the HTML reflects the data it received;
  // `Box` renders children passed through a Client Component. A module
  // listed in `late` loads its chunk when the scheduler settles it, so the
  // consumers have to wait for it, as they do on a server's first request.
  function createClientComponents(scheduler, late) {
    function Show({value}) {
      // Capped: the test loop guard trips on escaping a longer text.
      return React.createElement(
        'pre',
        null,
        describeProps(value, React.use).slice(0, 3000),
      );
    }
    function Box({label, children}) {
      return React.createElement('section', {'data-label': label}, children);
    }
    function exportModule(Component, name) {
      if (late.indexOf(name) === -1) {
        return clientExports(Component);
      }
      return clientExports(
        Component,
        name + '-' + moduleCount++ + '.js',
        scheduler.defer(resolve => resolve()),
      );
    }
    const ShowReference = exportModule(Show, 'Show');
    const BoxReference = exportModule(Box, 'Box');
    // The SSR bundle loads the same module the server referenced.
    const moduleMap = {};
    const references = [ShowReference, BoxReference];
    for (let i = 0; i < references.length; i++) {
      const metadata = clientManifest[references[i].$$id];
      moduleMap[metadata.id] = {'*': metadata};
    }
    return {
      Show: ShowReference,
      Box: BoxReference,
      serverConsumerManifest: {moduleMap, moduleLoading},
      nameOf(fn) {
        if (fn === Show) return 'Show';
        if (fn === Box) return 'Box';
        return fn.name;
      },
    };
  }

  function createScenario(seed, options) {
    const rng = createRng(seed);
    const scheduler = createScheduler(rng);
    const late = ['Show', 'Box'].filter(() => rng.int(2) === 1);
    const components = createClientComponents(scheduler, late);
    const counts = {renders: 0};
    const {model, kind} = generateModel(
      rng,
      {
        React: ReactServer,
        Show: components.Show,
        Box: components.Box,
        scheduler,
        onRender() {
          counts.renders++;
        },
      },
      options,
    );
    return {model, kind, scheduler, components, counts};
  }

  async function settleAll(scheduler) {
    while (scheduler.hasPending()) {
      await serverAct(() => {
        scheduler.settleOne();
      });
    }
  }

  function onError(error) {
    return 'digest(' + (error && error.message) + ')';
  }

  // The serializer's messages describe where the value sat; the first line
  // is the error itself.
  function firstLines(errors) {
    return errors.map(error => String(error.message).split('\n')[0]).sort();
  }

  // The browser's path: the model is rendered to bytes and the bytes are
  // read by the Flight client. Returns the client's root and the bytes.
  async function readFromBytes(scenario, reported) {
    // The bytes are recorded on the way through. A listener on the stream the
    // client reads would start it flowing before the client attaches.
    const readable = new Stream.PassThrough();
    const tap = new Stream.PassThrough();
    const chunks = [];
    tap.on('data', chunk => {
      // Copied: the client reads a byte stream's rows without copying, and
      // passing them on to the byte stream detaches the chunk's buffer.
      chunks.push(Buffer.from(chunk));
      readable.write(chunk);
    });
    tap.on('end', () => readable.end());
    await serverAct(() => {
      ReactServerDOMServer.renderToPipeableStream(
        scenario.model,
        clientManifest,
        {
          onError(error) {
            if (reported) reported.push(error);
            return onError(error);
          },
        },
      ).pipe(tap);
    });
    const response = ReactServerDOMClient.createFromNodeStream(
      readable,
      scenario.components.serverConsumerManifest,
    );
    await settleAll(scenario.scheduler);
    await serverAct(() => {});
    // Boxed so that awaiting this function does not adopt the thenable.
    return {
      response,
      bytes: Buffer.concat(chunks).toString('utf8'),
    };
  }

  // The in-process path: the same render also writes every row to a tee, and
  // the client reads the root from the tee. The bytes are recorded as in
  // readFromBytes.
  async function readFromTee(scenario, reported) {
    const tee = ReactServerDOMClient.createTee(
      scenario.components.serverConsumerManifest,
    );
    const readable = new Stream.PassThrough();
    const tap = new Stream.PassThrough();
    const chunks = [];
    tap.on('data', chunk => {
      chunks.push(Buffer.from(chunk));
      readable.write(chunk);
    });
    tap.on('end', () => readable.end());
    let response;
    await serverAct(() => {
      ReactServerDOMServer.renderToPipeableStream(
        scenario.model,
        clientManifest,
        {
          onError(error) {
            if (reported) reported.push(error);
            return onError(error);
          },
          tee,
        },
      ).pipe(tap);
      response = ReactServerDOMClient.createFromTee(tee);
    });
    await settleAll(scenario.scheduler);
    await serverAct(() => {});
    return {
      response,
      bytes: Buffer.concat(chunks).toString('utf8'),
      // How many model rows the tee built by value instead of parsing.
      rowsByValue: tee._rowsByValue,
    };
  }

  // The bytes to compare between two renders of one seed, or null in DEV.
  // DEV adds debug rows that legitimately differ between renders: timings,
  // stacks (DEV stops capturing owner stacks for a while after many
  // elements), and async debug info, which can pick up I/O still pending
  // from an earlier scenario. Each shifts the ids of the rows after it, so
  // DEV bytes are not compared. Module ids count every scenario's Client
  // Component modules, so they are taken out.
  function comparableBytes(bytes) {
    if (__DEV__) {
      return null;
    }
    return bytes.replace(/:I\["[^"]*",\[[^\]]*\]/g, ':I["module",[]]');
  }

  async function renderHTML(response) {
    function Root() {
      return React.use(response);
    }
    // Fizz reports one error per boundary, the first it meets; with two
    // erroring children, which one that is follows render order, and so
    // whether a child was lazy. Only the HTML is compared, without the
    // message and stack it carries in DEV.
    let result;
    try {
      result = await serverAct(() =>
        ReactDOMFizzStatic.prerender(React.createElement(Root), {
          onError() {},
        }),
      );
    } catch (error) {
      // No boundary caught a rejected root; the shell itself failed.
      return {shellError: true};
    }
    const reader = result.prelude.getReader();
    let html = '';
    while (true) {
      const {done, value} = await reader.read();
      if (done) {
        // DEV error boundaries carry stacks whose frames depend on which
        // render path threw. Fizz separates a text node from a following
        // lazy node with a comment, and whether a node is lazy or inline
        // depends on timing.
        return {
          html: html
            .replace(/ data-(msg|c?stck)="[^"]*"/g, '')
            .replace(/<!-- -->/g, ''),
        };
      }
      html += Buffer.from(value).toString('utf8');
    }
  }

  // What a read is compared by: the resolved value, the HTML Fizz renders
  // from it, and how many times Server Components ran.
  async function observe(scenario, {response}) {
    const value = await normalize(response, scenario.components);
    const html = scenario.kind === 'tree' ? await renderHTML(response) : null;
    return {value, html, renders: scenario.counts.renders};
  }

  return {
    createClientComponents,
    createScenario,
    settleAll,
    onError,
    firstLines,
    readFromBytes,
    readFromTee,
    comparableBytes,
    renderHTML,
    observe,
  };
}

exports.createHarness = createHarness;
