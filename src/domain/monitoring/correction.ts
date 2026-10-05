import { DomainError } from '../errors.ts';
import type { Calibration, SensorSample } from '../types.ts';
import { resolveCalibration } from './calibration-catalog.ts';
import { convertSensorValue } from './sensor-units.ts';
import { correctedUncertainty } from './uncertainty-propagation.ts';
export type CorrectedSample = SensorSample & { correctedValue: number; calibrationId: string; uncertainty: number; canonicalUnit: string; qualityWeight: number };
function finiteOrZero(value: number | undefined): number { return value === undefined || !Number.isFinite(value) ? 0 : value; }
function nonNegative(value: number): number { return Number.isFinite(value) && value >= 0 ? value : 0; }
function calibrationUncertainty(calibration: Calibration): number { return nonNegative(calibration.standardUncertainty ?? calibration.uncertainty); }
function offsetAllowance(offset: number, scale: number): number { return Math.abs(offset) * Math.max(scale, 1) * 0.01; }
function qualityWeightOf(quality: SensorSample['quality']): number { if (quality === 'suspect') return 0.25; if (quality === 'good') return 1; return 0; }
function qualityIsUsable(quality: SensorSample['quality']): boolean { return quality === 'good' || quality === 'suspect'; }
function qualityPenalty(quality: SensorSample['quality']): number { return quality === 'suspect' ? 0.25 : quality === 'good' ? 0 : 1; }
function finalQualityWeight(quality: SensorSample['quality']): number { return qualityIsUsable(quality) ? Math.max(0, 1 - qualityPenalty(quality)) : 0; }
function combineUncertainty(raw: number, calibration: Calibration, scale: number): number {
  const certificateUncertainty = calibrationUncertainty(calibration);
  const propagated = correctedUncertainty(nonNegative(raw), certificateUncertainty, scale);
  const driftAllowance = offsetAllowance(finiteOrZero(calibration.offset), scale);
  return propagated + driftAllowance;
}
export function correctSample(sample: SensorSample, calibrations: Calibration[], rawUncertainty = 0): CorrectedSample {
  if (sample.quality === 'invalid') throw new DomainError('INVALID_SENSOR_SAMPLE', 'Invalid-quality sample cannot enter engineering calculations', 422);
  const calibration = resolveCalibration(sample.sensorId, sample.observedAt, calibrations);
  if (!(calibration.scale > 0) || !Number.isFinite(calibration.offset) || !(calibration.uncertainty >= 0)) throw new DomainError('INVALID_CALIBRATION', 'Calibration coefficients are invalid', 422, { calibrationId: calibration.id });
  const canonicalUnit = calibration.unit ?? sample.unit;
  const canonicalValue = convertSensorValue(sample.value, sample.unit, canonicalUnit);
  const scaledValue = canonicalValue * calibration.scale;
  const correctedValue = scaledValue + calibration.offset;
  const uncertainty = combineUncertainty(rawUncertainty, calibration, calibration.scale);
  const qualityWeight = finalQualityWeight(sample.quality) || qualityWeightOf(sample.quality);
  if (!Number.isFinite(correctedValue) || !Number.isFinite(uncertainty)) throw new DomainError('NON_FINITE_CORRECTION', 'Corrected sensor output must be finite', 422, { sample, calibrationId: calibration.id });
  return { ...sample, correctedValue, calibrationId: calibration.id, canonicalUnit, uncertainty, qualityWeight };
}
