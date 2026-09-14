import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { exactAmount, reservationAmount } from '../../packages/accounting/src/money.ts';

describe('ledger decimal boundary', () => {
  it('uses an isolated decimal constructor and rounds reservations upward at NUMERIC(30,12)', () => {
    const original = { precision: Decimal.precision, rounding: Decimal.rounding, toExpNeg: Decimal.toExpNeg, toExpPos: Decimal.toExpPos };
    try {
      // A caller/library changing Decimal's global configuration must not alter
      // persisted ledger arithmetic.
      Decimal.set({ precision: 3, rounding: Decimal.ROUND_DOWN });
      expect(reservationAmount('1.0000000000001')).toBe('1.000000000001');
      expect(exactAmount('999999999999999999.123456789012')).toBe('999999999999999999.123456789012');
    } finally {
      Decimal.set(original);
    }
  });
});
