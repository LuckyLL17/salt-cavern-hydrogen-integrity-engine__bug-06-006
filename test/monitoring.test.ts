import test from 'node:test';
import assert from 'node:assert/strict';
import { correctSample } from '../src/domain/monitoring/correction.ts';
import { DomainError } from '../src/domain/errors.ts';
import type { Calibration, SensorSample } from '../src/domain/types.ts';

function calibration(overrides: Partial<Calibration>): Calibration {
  return { id: 'cal', sensorId: 'p-1', validFrom: '2025-01-01T00:00:00Z', offset: 0, scale: 1, uncertainty: 0.5, createdAt: '2025-01-01T00:00:00Z', ...overrides };
}
function sample(overrides: Partial<SensorSample>): SensorSample {
  return { sensorId: 'p-1', observedAt: '2026-01-02T00:00:00Z', value: 10, quality: 'good', unit: 'kPa', ...overrides };
}
function errorCode(error: unknown): string {
  assert.ok(error instanceof DomainError);
  return error.code;
}

test('inputs are unit-normalized before scale and offset are applied', () => {
  const corrected = correctSample(sample({ value: 1, unit: 'MPa' }), [calibration({ unit: 'kPa', scale: 2, offset: 3 })]);
  assert.equal(corrected.canonicalUnit, 'kPa');
  assert.equal(corrected.correctedValue, 2003);
});

test('raw uncertainty is unit-normalized before scaling', () => {
  const corrected = correctSample(sample({ value: 1, unit: 'MPa' }), [calibration({ unit: 'kPa', uncertainty: 0.5 })], 0.001);
  assert.ok(Math.abs(corrected.uncertainty - Math.hypot(1, 0.5)) < 1e-12);
});

test('temperature uncertainties convert as intervals without the absolute-temperature shift', () => {
  const corrected = correctSample(sample({ sensorId: 't-1', value: 25, unit: 'C' }), [calibration({ sensorId: 't-1', unit: 'K', uncertainty: 0.25 })], 0.5);
  assert.ok(Math.abs(corrected.correctedValue - 298.15) < 1e-9);
  assert.ok(Math.abs(corrected.uncertainty - Math.hypot(0.5, 0.25)) < 1e-12);
});

test('corrected value, uncertainty and certificate id come from the certificate effective at sample time', () => {
  const calibrations = [
    calibration({ id: 'old', validTo: '2026-06-01T00:00:00Z', scale: 1, offset: 1, uncertainty: 0.1 }),
    calibration({ id: 'new', validFrom: '2026-06-01T00:00:00Z', scale: 2, offset: 3, uncertainty: 0.9, createdAt: '2026-06-01T00:00:00Z' }),
  ];
  const corrected = correctSample(sample({ observedAt: '2026-07-01T00:00:00Z' }), calibrations);
  assert.equal(corrected.calibrationId, 'new');
  assert.equal(corrected.correctedValue, 23);
  assert.ok(Math.abs(corrected.uncertainty - (0.9 + 3 * 2 * 0.01)) < 1e-12);
});

test('standard uncertainty, weight and certificate id are taken from the same resolved certificate', () => {
  const corrected = correctSample(sample({}), [calibration({ id: 'rev-b', uncertainty: 5, standardUncertainty: 0.2 })]);
  assert.equal(corrected.calibrationId, 'rev-b');
  assert.ok(Math.abs(corrected.uncertainty - 0.2) < 1e-12);
});

test('a superseded certificate is not selected over its successor', () => {
  const calibrations = [
    calibration({ id: 'recalled', validFrom: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' }),
    calibration({ id: 'successor', validFrom: '2025-06-01T00:00:00Z', supersedesId: 'recalled', createdAt: '2025-06-01T00:00:00Z' }),
    calibration({ id: 'independent', validFrom: '2025-01-01T00:00:00Z' }),
  ];
  const corrected = correctSample(sample({ observedAt: '2026-02-01T00:00:00Z' }), calibrations);
  assert.equal(corrected.calibrationId, 'successor');
});

test('supersession cycles are rejected instead of silently resolved', () => {
  const calibrations = [
    calibration({ id: 'a', supersedesId: 'b' }),
    calibration({ id: 'b', validFrom: '2025-06-01T00:00:00Z', supersedesId: 'a', createdAt: '2025-06-01T00:00:00Z' }),
  ];
  assert.throws(() => correctSample(sample({}), calibrations), (error) => errorCode(error) === 'CALIBRATION_LINEAGE_CYCLE');
});

test('expired certificates are rejected instead of applied', () => {
  const calibrations = [calibration({ validTo: '2026-06-01T00:00:00Z' })];
  assert.throws(() => correctSample(sample({ observedAt: '2027-01-02T00:00:00Z' }), calibrations), (error) => errorCode(error) === 'CALIBRATION_NOT_FOUND');
});

test('negative calibration scale is rejected', () => {
  assert.throws(() => correctSample(sample({}), [calibration({ scale: -1 })]), (error) => errorCode(error) === 'INVALID_CALIBRATION');
});

test('corrupt standard uncertainty is rejected instead of silently zeroed', () => {
  assert.throws(() => correctSample(sample({}), [calibration({ standardUncertainty: Number.NaN })]), (error) => errorCode(error) === 'INVALID_CALIBRATION');
  assert.throws(() => correctSample(sample({}), [calibration({ standardUncertainty: -0.1 })]), (error) => errorCode(error) === 'INVALID_CALIBRATION');
});

test('non-finite samples are rejected', () => {
  assert.throws(() => correctSample(sample({ value: Number.NaN }), [calibration({})]), (error) => errorCode(error) === 'INVALID_SENSOR_VALUE');
});

test('non-finite raw uncertainty is rejected instead of silently zeroed', () => {
  assert.throws(() => correctSample(sample({}), [calibration({})], Number.POSITIVE_INFINITY), (error) => errorCode(error) === 'INVALID_MEASUREMENT_UNCERTAINTY');
  assert.throws(() => correctSample(sample({}), [calibration({})], -0.1), (error) => errorCode(error) === 'INVALID_MEASUREMENT_UNCERTAINTY');
});

test('suspect samples are corrected on the down-weight path', () => {
  const corrected = correctSample(sample({ quality: 'suspect' }), [calibration({})]);
  assert.equal(corrected.correctedValue, 10);
  assert.equal(corrected.qualityWeight, 0.25);
});

test('invalid-quality samples are rejected', () => {
  assert.throws(() => correctSample(sample({ quality: 'invalid' }), [calibration({})]), (error) => errorCode(error) === 'INVALID_SENSOR_SAMPLE');
});
