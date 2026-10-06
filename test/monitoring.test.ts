import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/domain/errors.ts';
import { correctSample } from '../src/domain/monitoring/correction.ts';
import type { Calibration, SensorSample } from '../src/domain/types.ts';

const baseCalibration: Calibration = { id: 'cal-1', sensorId: 'p-1', validFrom: '2025-01-01T00:00:00Z', offset: 0, scale: 1, uncertainty: 0.5, createdAt: '2025-01-01T00:00:00Z' };
const goodSample: SensorSample = { sensorId: 'p-1', observedAt: '2026-01-02T00:00:00Z', value: 10, quality: 'good', unit: 'kPa' };
const hasCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

test('cross-unit samples are normalized before scale and offset are applied', () => {
  const result = correctSample({ ...goodSample, value: 2, unit: 'MPa' }, [{ ...baseCalibration, scale: 1.5, offset: 10, unit: 'kPa' }], 0.01);
  assert.equal(result.canonicalUnit, 'kPa');
  assert.equal(result.correctedValue, 2 * 1000 * 1.5 + 10);
  const expectedUncertainty = Math.sqrt((0.01 * 1000 * 1.5) ** 2 + 0.5 ** 2) + 10 * 1.5 * 0.01;
  assert.ok(Math.abs(result.uncertainty - expectedUncertainty) < 1e-12);
});

test('temperature spreads stay affine-invariant across unit normalization', () => {
  const result = correctSample({ ...goodSample, value: 25, unit: 'C' }, [{ ...baseCalibration, unit: 'K', uncertainty: 0.3 }], 0.5);
  assert.equal(result.correctedValue, 298.15);
  assert.ok(Math.abs(result.uncertainty - Math.sqrt(0.5 ** 2 + 0.3 ** 2)) < 1e-12);
});

test('standard uncertainty, quality weight and certificate id come from one certificate version', () => {
  const result = correctSample(goodSample, [{ ...baseCalibration, uncertainty: 0.5, standardUncertainty: 0.2 }]);
  assert.equal(result.calibrationId, 'cal-1');
  assert.ok(Math.abs(result.uncertainty - 0.2) < 1e-12);
  assert.equal(result.qualityWeight, 1);
});

test('a usable standardUncertainty does not fail on a stale legacy uncertainty field', () => {
  const result = correctSample(goodSample, [{ ...baseCalibration, uncertainty: -1, standardUncertainty: 0.2 }]);
  assert.ok(Math.abs(result.uncertainty - 0.2) < 1e-12);
});

test('an invalid standardUncertainty is rejected instead of silently zeroed', () => {
  assert.throws(() => correctSample(goodSample, [{ ...baseCalibration, standardUncertainty: -0.1 }]), hasCode('INVALID_CALIBRATION'));
  assert.throws(() => correctSample(goodSample, [{ ...baseCalibration, standardUncertainty: Number.NaN }]), hasCode('INVALID_CALIBRATION'));
});

test('overlapping certificates resolve to the superseding revision at the sample time', () => {
  const result = correctSample(goodSample, [
    { ...baseCalibration, id: 'rev-1', validTo: '2026-06-01T00:00:00Z', offset: 1 },
    { ...baseCalibration, id: 'rev-2', validFrom: '2026-01-01T00:00:00Z', supersedesId: 'rev-1', offset: 2 },
  ]);
  assert.equal(result.calibrationId, 'rev-2');
  assert.equal(result.correctedValue, 12);
});

test('expired or foreign-sensor certificates enter the not-found path', () => {
  assert.throws(() => correctSample(goodSample, [{ ...baseCalibration, validTo: '2026-01-01T00:00:00Z' }]), hasCode('CALIBRATION_NOT_FOUND'));
  assert.throws(() => correctSample(goodSample, [{ ...baseCalibration, sensorId: 'other' }]), hasCode('CALIBRATION_NOT_FOUND'));
});

test('non-positive or non-finite scale enters the calibration error path', () => {
  assert.throws(() => correctSample(goodSample, [{ ...baseCalibration, scale: -2 }]), hasCode('INVALID_CALIBRATION'));
  assert.throws(() => correctSample(goodSample, [{ ...baseCalibration, scale: 0 }]), hasCode('INVALID_CALIBRATION'));
  assert.throws(() => correctSample(goodSample, [{ ...baseCalibration, scale: Number.NaN }]), hasCode('INVALID_CALIBRATION'));
});

test('non-finite samples enter the sensor-value error path regardless of the registry', () => {
  assert.throws(() => correctSample({ ...goodSample, value: Number.NaN }, []), hasCode('INVALID_SENSOR_VALUE'));
  assert.throws(() => correctSample({ ...goodSample, value: Number.POSITIVE_INFINITY }, [baseCalibration]), hasCode('INVALID_SENSOR_VALUE'));
});

test('negative or non-finite raw uncertainty enters the measurement error path', () => {
  assert.throws(() => correctSample(goodSample, [baseCalibration], -0.1), hasCode('INVALID_MEASUREMENT_UNCERTAINTY'));
  assert.throws(() => correctSample(goodSample, [baseCalibration], Number.NaN), hasCode('INVALID_MEASUREMENT_UNCERTAINTY'));
});

test('suspect samples are down-weighted instead of rejected or silently trusted', () => {
  const suspect = correctSample({ ...goodSample, quality: 'suspect' }, [baseCalibration]);
  const good = correctSample(goodSample, [baseCalibration]);
  assert.equal(suspect.qualityWeight, 0.75);
  assert.equal(good.qualityWeight, 1);
  assert.equal(suspect.correctedValue, good.correctedValue);
  assert.throws(() => correctSample({ ...goodSample, quality: 'invalid' }, [baseCalibration]), hasCode('INVALID_SENSOR_SAMPLE'));
});
