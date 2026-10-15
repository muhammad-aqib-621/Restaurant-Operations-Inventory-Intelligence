type StockUnit = 'G' | 'KG' | 'ML' | 'L' | 'PIECE';
const factors: Record<StockUnit, bigint> = { G: 1n, KG: 1000n, ML: 1n, L: 1000n, PIECE: 1n };
const dimension: Record<StockUnit, string> = { G: 'mass', KG: 'mass', ML: 'volume', L: 'volume', PIECE: 'count' };

/** Preserve the entered cost when changing its quoted unit, without floating-point rounding. */
export function convertQuotedCost(value: string, from: StockUnit, to: StockUnit): string {
  if (from === to || !/^\d+(?:\.\d{1,6})?$/.test(value)) return value;
  if (dimension[from] !== dimension[to]) throw new Error('Incompatible cost units.');
  const [whole, fractional = ''] = value.split('.');
  const scaled = (BigInt(whole) * 1_000_000n + BigInt(fractional.padEnd(6, '0'))) * 1000n;
  const result = scaled * factors[to] / factors[from];
  const fraction = String(result % 1_000_000_000n).padStart(9, '0').replace(/0+$/, '');
  return `${result / 1_000_000_000n}${fraction ? `.${fraction}` : ''}`;
}
