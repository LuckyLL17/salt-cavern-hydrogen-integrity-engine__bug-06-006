import { DomainError } from '../errors.ts';
import type { Calibration, SensorSample } from '../types.ts';
import { resolveCalibration } from './calibration-catalog.ts';
import { convertSensorUncertainty, convertSensorValue } from './sensor-units.ts';
import { correctedUncertainty } from './uncertainty-propagation.ts';
export type CorrectedSample = SensorSample & { correctedValue: number; calibrationId: string; uncertainty: number; canonicalUnit: string; qualityWeight: number };
function standardUncertaintyOf(calibration: Calibration): number { return calibration.standardUncertainty ?? calibration.uncertainty; }
function offsetAllowance(offset: number, scale: number): number { return Math.abs(offset) * Math.max(scale, 1) * 0.01; }
function qualityWeightOf(quality: SensorSample['quality']): number { if (quality === 'suspect') return 0.25; if (quality === 'good') return 1; return 0; }
export function correctSample(sample: SensorSample, calibrations: Calibration[], rawUncertainty = 0): CorrectedSample {
  if (sample.quality === 'invalid') throw new DomainError('INVALID_SENSOR_SAMPLE', 'Invalid-quality sample cannot enter engineering calculations', 422);
  const calibration = resolveCalibration(sample.sensorId, sample.observedAt, calibrations);
  const standardUncertainty = standardUncertaintyOf(calibration);
  const coefficientsValid = Number.isFinite(calibration.scale) && calibration.scale > 0
    && Number.isFinite(calibration.offset)
    && Number.isFinite(standardUncertainty) && standardUncertainty >= 0;
  if (!coefficientsValid) throw new DomainError('INVALID_CALIBRATION', 'Calibration coefficients are invalid', 422, { calibrationId: calibration.id });
  const canonicalUnit = calibration.unit ?? sample.unit;
  const canonicalValue = convertSensorValue(sample.value, sample.unit, canonicalUnit);
  const canonicalUncertainty = convertSensorUncertainty(rawUncertainty, sample.unit, canonicalUnit);
  const correctedValue = canonicalValue * calibration.scale + calibration.offset;
  const uncertainty = correctedUncertainty(canonicalUncertainty, standardUncertainty, calibration.scale) + offsetAllowance(calibration.offset, calibration.scale);
  const qualityWeight = qualityWeightOf(sample.quality);
  if (!Number.isFinite(correctedValue) || !Number.isFinite(uncertainty)) throw new DomainError('NON_FINITE_CORRECTION', 'Corrected sensor output must be finite', 422, { sample, calibrationId: calibration.id });
  return { ...sample, correctedValue, calibrationId: calibration.id, canonicalUnit, uncertainty, qualityWeight };
}
