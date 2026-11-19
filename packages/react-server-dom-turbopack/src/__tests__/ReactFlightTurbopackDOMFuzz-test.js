/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 * @jest-environment node
 */

'use strict';

import {patchSetImmediate} from '../../../../scripts/jest/patchSetImmediate';

// Scenarios are seeded from FUZZ_TEST_SEED, which the hourly fuzz workflow
// sets at random; the default seed runs a fixed sample. FLIGHT_FUZZ_SEEDS=first-last
// replays a range of seeds, and a failure prints the one to replay.
const SEED = process.env.FUZZ_TEST_SEED || 'default';
const SEED_RANGE = process.env.FLIGHT_FUZZ_SEEDS
  ? process.env.FLIGHT_FUZZ_SEEDS.split('-').map(Number)
  : null;
const SEEDS_PER_RUN = 40;
jest.setTimeout(SEED_RANGE ? 30 * 60 * 1000 : 60 * 1000);

let FlightFuzz;
let env;
let harness;

describe(`ReactFlightTurbopackDOMFuzz (random seed: ${SEED})`, () => {
  let stackTraceLimit;
  beforeEach(() => {
    // Fizz escapes an error's stack into the HTML in DEV; a deep generated
    // tree produces one long enough to trip the test loop guard.
    stackTraceLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 20;
    jest.resetModules();
    rowsByValue = 0;

    patchSetImmediate();
    const serverAct = require('internal-test-utils').serverAct;

    // Simulate the condition resolution
    jest.mock('react', () => require('react/react.react-server'));
    jest.mock('react-server-dom-turbopack/server', () =>
      jest.requireActual('react-server-dom-turbopack/server.node'),
    );
    const ReactServer = require('react');
    const ReactServerDOMServer = require('react-server-dom-turbopack/server');

    const TurbopackMock = require('./utils/TurbopackMock');

    jest.resetModules();
    __unmockReact();
    jest.unmock('react-server-dom-turbopack/server');
    jest.mock('react-server-dom-turbopack/client', () =>
      jest.requireActual('react-server-dom-turbopack/client.node'),
    );

    const React = require('react');
    const ReactDOMFizzStatic = require('react-dom/static');
    const ReactServerDOMClient = require('react-server-dom-turbopack/client');
    const Stream = require('stream');
    FlightFuzz = require('./utils/FlightFuzz');
    env = {
      React,
      ReactServer,
      ReactDOMFizzStatic,
      ReactServerDOMServer,
      ReactServerDOMClient,
      Stream,
      serverAct,
      clientExports: TurbopackMock.clientExports,
      clientManifest: TurbopackMock.turbopackMap,
      moduleLoading: TurbopackMock.moduleLoading,
    };
    harness = FlightFuzz.createHarness(env);
  });

  afterEach(() => {
    Error.stackTraceLimit = stackTraceLimit;
  });

  // The path each scenario is checked against the browser's: the in-process
  // tee. Builds without enableFlightTee have no tee, so the comparison tests
  // check the harness against itself there.
  let rowsByValue = 0;
  async function readUnderTest(scenario, reported) {
    if (gate(flags => flags.enableFlightTee)) {
      const result = await harness.readFromTee(scenario, reported);
      rowsByValue += result.rowsByValue;
      return result;
    }
    return harness.readFromBytes(scenario, reported);
  }

  // The tee builds model rows by value rather than parsing them.
  function expectRowsBuiltByValue() {
    if (gate(flags => flags.enableFlightTee)) {
      expect(rowsByValue).toBeGreaterThan(0);
    }
  }

  async function forEachSeed(run) {
    let first;
    let last;
    if (SEED_RANGE) {
      first = SEED_RANGE[0];
      last = SEED_RANGE[1];
    } else {
      // A random seed picks one of a million fixed ranges, so a failure
      // replays by seed number.
      first =
        SEED === 'default'
          ? 1
          : 1 + FlightFuzz.createRng(+SEED).int(1000000) * SEEDS_PER_RUN;
      last = first + SEEDS_PER_RUN - 1;
    }
    for (let seed = first; seed <= last; seed++) {
      try {
        await run(seed);
      } catch (error) {
        console.log(
          `Failed seed ${seed} (FUZZ_TEST_SEED=${SEED}). Replay with ` +
            `FLIGHT_FUZZ_SEEDS=${seed}-${seed} yarn test ReactFlightTurbopackDOMFuzz`,
        );
        throw error;
      }
    }
  }

  // FLIGHT_FUZZ_DUMP=seed prints a generated model and its bytes, to debug a
  // seed.
  if (process.env.FLIGHT_FUZZ_DUMP) {
    it('dumps a scenario', async () => {
      const scenario = harness.createScenario(+process.env.FLIGHT_FUZZ_DUMP, {
        allowErrors: process.env.FLIGHT_FUZZ_DUMP_ERRORS === '1',
        allowInvalid: process.env.FLIGHT_FUZZ_DUMP_INVALID === '1',
        maxDepth: process.env.FLIGHT_FUZZ_DUMP_INVALID === '1' ? 3 : undefined,
      });
      const {bytes} = await harness.readFromBytes(scenario);
      process.stdout.write(
        'MODEL\n' +
          FlightFuzz.describeModel(scenario.model) +
          '\nBYTES\n' +
          bytes,
      );
    });
  }

  // The reference itself must be deterministic for a seed, or the comparisons
  // below would flake.
  it('renders a scenario the same way across independent renders', async () => {
    await forEachSeed(async seed => {
      const a = harness.createScenario(seed, {allowErrors: seed % 2 === 0});
      const first = await harness.readFromBytes(a);
      const b = harness.createScenario(seed, {allowErrors: seed % 2 === 0});
      const second = await harness.readFromBytes(b);
      expect(harness.comparableBytes(second.bytes)).toBe(
        harness.comparableBytes(first.bytes),
      );
      expect(await harness.observe(b, second)).toEqual(
        await harness.observe(a, first),
      );
    });
  });

  it('renders the same HTML and values as the browser', async () => {
    await forEachSeed(async seed => {
      const a = harness.createScenario(seed, {});
      const browser = await harness.readFromBytes(a);
      const b = harness.createScenario(seed, {});
      const underTest = await readUnderTest(b);
      expect(harness.comparableBytes(underTest.bytes)).toBe(
        harness.comparableBytes(browser.bytes),
      );
      expect(await harness.observe(b, underTest)).toEqual(
        await harness.observe(a, browser),
      );
    });
    expectRowsBuiltByValue();
  });

  it('renders the same HTML and values as the browser with errors', async () => {
    await forEachSeed(async seed => {
      const a = harness.createScenario(seed, {allowErrors: true});
      const browser = await harness.readFromBytes(a);
      const b = harness.createScenario(seed, {allowErrors: true});
      const underTest = await readUnderTest(b);
      expect(harness.comparableBytes(underTest.bytes)).toBe(
        harness.comparableBytes(browser.bytes),
      );
      expect(await harness.observe(b, underTest)).toEqual(
        await harness.observe(a, browser),
      );
    });
    expectRowsBuiltByValue();
  });

  it('rejects the values the browser path rejects, reporting the same errors', async () => {
    await forEachSeed(async seed => {
      // Shallow, so the message describing an invalid value's parent stays
      // under the test environment's loop iteration cap when Fizz escapes it.
      const options = {allowInvalid: true, maxDepth: 3};
      const a = harness.createScenario(seed, options);
      const browserErrors = [];
      const browser = await harness.readFromBytes(a, browserErrors);
      const b = harness.createScenario(seed, options);
      const underTestErrors = [];
      const underTest = await readUnderTest(b, underTestErrors);
      expect(harness.firstLines(underTestErrors)).toEqual(
        harness.firstLines(browserErrors),
      );
      expect(await harness.observe(b, underTest)).toEqual(
        await harness.observe(a, browser),
      );
    });
    expectRowsBuiltByValue();
  });
});
