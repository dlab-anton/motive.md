import Decimal from 'decimal.js';
import type { DecimalAmount } from '../../domain/src/contracts.ts';

/** Postgres NUMERIC(30,12): eighteen integral digits and twelve fractional digits. */
export const MONEY_SCALE = 12;
/** Isolated constructor: global Decimal configuration must not affect the ledger. */
const MoneyDecimal = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -100, toExpPos: 100 });
const MAX_AMOUNT = new MoneyDecimal('999999999999999999.999999999999');

export class DecimalAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecimalAmountError';
  }
}

function parse(value: DecimalAmount, name: string): Decimal {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new DecimalAmountError(`${name} must be a non-negative base-10 decimal string.`);
  }
  const amount = new MoneyDecimal(value);
  if (!amount.isFinite() || amount.isNegative()) throw new DecimalAmountError(`${name} is not a valid non-negative amount.`);
  return amount;
}

function checkRange(amount: Decimal, name: string): void {
  if (amount.greaterThan(MAX_AMOUNT)) throw new DecimalAmountError(`${name} exceeds NUMERIC(30,12).`);
}

function format(amount: Decimal): DecimalAmount {
  checkRange(amount, 'amount');
  return amount.toFixed(MONEY_SCALE) as DecimalAmount;
}

/** Strict storage amount: callers may not silently discard a provider decimal residual. */
export function exactAmount(value: DecimalAmount, name = 'amount'): DecimalAmount {
  const amount = parse(value, name);
  if ((amount.decimalPlaces() ?? 0) > MONEY_SCALE) {
    throw new DecimalAmountError(`${name} has more than ${MONEY_SCALE} fractional places.`);
  }
  return format(amount);
}

/** Reservations are always rounded upward at the persisted scale. */
export function reservationAmount(value: DecimalAmount, name = 'reservation amount'): DecimalAmount {
  const amount = parse(value, name).toDecimalPlaces(MONEY_SCALE, MoneyDecimal.ROUND_CEIL);
  return format(amount);
}

/**
 * A provider charge with finer precision is persisted upward. Its original
 * string is retained in usage_records.raw_provider_amount, so the residual is
 * visible and never silently rounded down.
 */
export function chargedAmount(value: DecimalAmount, name = 'charged amount'): DecimalAmount {
  return reservationAmount(value, name);
}

export function positiveAmount(value: DecimalAmount, name = 'amount'): DecimalAmount {
  const normalized = exactAmount(value, name);
  if (new MoneyDecimal(normalized).isZero()) throw new DecimalAmountError(`${name} must be greater than zero.`);
  return normalized;
}

export function compareAmounts(left: DecimalAmount, right: DecimalAmount): -1 | 0 | 1 {
  const comparison = new MoneyDecimal(left).comparedTo(new MoneyDecimal(right));
  return comparison < 0 ? -1 : comparison > 0 ? 1 : 0;
}

export function addAmounts(...values: readonly DecimalAmount[]): DecimalAmount {
  const total = values.reduce((sum, value) => sum.plus(new MoneyDecimal(value)), new MoneyDecimal(0));
  return format(total);
}

export function subtractAmounts(left: DecimalAmount, right: DecimalAmount, name = 'amount'): DecimalAmount {
  const result = new MoneyDecimal(left).minus(new MoneyDecimal(right));
  if (result.isNegative()) throw new DecimalAmountError(`${name} cannot become negative.`);
  return format(result);
}

export function minAmount(left: DecimalAmount, right: DecimalAmount): DecimalAmount {
  return new MoneyDecimal(left).lessThan(new MoneyDecimal(right)) ? exactAmount(left) : exactAmount(right);
}

export const ZERO_AMOUNT: DecimalAmount = '0.000000000000';
