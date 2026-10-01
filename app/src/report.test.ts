import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNS, reportRows, toCSV, toJSON } from './report.ts';
import { demoSnapshot } from './demo.ts';

test('one row per action, oldest first, each column mapped to a control', () => {
  const rows = reportRows(demoSnapshot);
  assert.equal(rows.length, demoSnapshot.actions.length);
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].requested_utc <= r.requested_utc));
  assert.ok(COLUMNS.every((c) => c.control.length > 0));
});

test('veto, refusal and timelock evidence survive into the report', () => {
  const rows = reportRows(demoSnapshot);
  const veto = rows.find((r) => r.change_id === 'P-3')!;
  assert.equal(veto.outcome, 'vetoed');
  assert.match(veto.independent_review, /sha256 [0-9a-f]{64}$/);
  assert.equal(veto.waiting_period_hours, '48');
  const fat = rows.find((r) => r.amount.startsWith('300000000000000 '))!;
  assert.equal(fat.outcome, 'refused');
  assert.equal(fat.reserve_check, 'Refused by program');
});

test('CSV quotes commas and quotes, and round-trips through JSON', () => {
  const s = { ...demoSnapshot, actions: [{ ...demoSnapshot.actions[0], action: 'Mint, "urgent"' }] };
  const csv = toCSV(reportRows(s));
  const [header, row] = csv.trimEnd().split('\r\n');
  assert.equal(header.split(',').length, COLUMNS.length);
  assert.ok(row.includes('"Mint, ""urgent"""'));
  const json = JSON.parse(toJSON(s, new Date(0)));
  assert.equal(json.generated_utc, '1970-01-01T00:00:00.000Z');
  assert.equal(json.rows[0].action, 'Mint, "urgent"');
  assert.deepEqual(Object.keys(json.controls), COLUMNS.map((c) => c.key));
});
