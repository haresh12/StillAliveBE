/**
 * cost-cap.test.js — daily cost cap circuit breaker.
 */

'use strict';

const config = require('../config');
const { record, drain, circuitOpen, todaySpendUsd } = require('../llm/telemetry');

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { console.log('  ✓ ' + label); pass++; }
  else { console.log('  ✗ ' + label); fail++; }
}

drain(); // clear buffer

console.log('cost cap circuit breaker');
const cap = (config.COST && config.COST.MAX_DAILY_TOTAL_USD) || 100;

assert('circuit closed at start', circuitOpen() === false);
assert('todaySpendUsd 0 at start', todaySpendUsd() === 0);

// Record a tiny spend
record({ role: 'planner', cost_usd: 0.001, input_tokens: 100, output_tokens: 50 });
assert('after 0.001 → still closed', circuitOpen() === false);
assert('todaySpendUsd reflects 0.001', todaySpendUsd() >= 0.0009);

// Record enough to trip the breaker
const overshoot = cap + 1;
record({ role: 'executor', cost_usd: overshoot, input_tokens: 1, output_tokens: 1 });
assert('after large spend → circuit open', circuitOpen() === true);

// Drain doesn't reset cost counter (only midnight does)
drain();
assert('after drain → circuit still open (only date-rollover resets)', circuitOpen() === true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
