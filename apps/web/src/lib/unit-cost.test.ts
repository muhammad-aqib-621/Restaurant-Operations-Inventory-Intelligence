import { describe, expect, it } from 'vitest';
import { convertQuotedCost } from './unit-cost';

describe('quoted purchase costs', () => {
  it('preserves the total quotation when switching grams and kilograms', () => {
    expect(convertQuotedCost('0.25', 'G', 'KG')).toBe('250');
    expect(convertQuotedCost('250', 'KG', 'G')).toBe('0.25');
  });
  it('handles millilitres and litres without losing decimal precision', () => {
    expect(convertQuotedCost('12.345678', 'ML', 'L')).toBe('12345.678');
    expect(convertQuotedCost('0.000001', 'L', 'ML')).toBe('0.000000001');
  });
  it('keeps empty/invalid text available for form validation and forbids incompatible units', () => {
    expect(convertQuotedCost('', 'G', 'KG')).toBe('');
    expect(() => convertQuotedCost('1', 'G', 'L')).toThrow('Incompatible');
  });
});
