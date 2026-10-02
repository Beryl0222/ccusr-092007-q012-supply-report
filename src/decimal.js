/**
 * 精确十进制数：全程 BigInt 分子 + 固定比例，避免 0.1+0.2 一类浮点误差
 * 污染库存对账。对外以规范化十进制字符串呈现。
 */

export class Decimal {
  /** @param {bigint} value 内部分子（以 SCALE 为分母） @param {bigint} [scale] */
  constructor(value, scale = SCALE) {
    this.value = typeof value === 'bigint' ? value : BigInt(value);
    this.scale = scale;
  }

  static get zero() {
    return new Decimal(0n);
  }

  /** 从字符串/数字/BigInt 构造，支持 "12"、"1.20"。 */
  static of(input) {
    if (input instanceof Decimal) return input;
    const s = String(input).trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`非法十进制数值: ${input}`);
    const neg = s.startsWith('-');
    const [intPart, fracPart = ''] = s.replace('-', '').split('.');
    const frac = fracPart.padEnd(SCALE_EXP, '0').slice(0, SCALE_EXP);
    const num = BigInt(intPart) * SCALE + BigInt(frac || '0');
    return new Decimal(neg ? -num : num);
  }

  add(other) {
    return new Decimal(this.value + Decimal.of(other).rescaleTo(this.scale).value, this.scale);
  }

  sub(other) {
    return new Decimal(this.value - Decimal.of(other).rescaleTo(this.scale).value, this.scale);
  }

  mul(other) {
    const o = Decimal.of(other);
    return new Decimal((this.value * o.value) / SCALE, this.scale);
  }

  /** 四舍五入到整数（标准单位换算后若要求整数可调用）。 */
  round() {
    const half = SCALE / 2n;
    const rounded = this.value >= 0n
      ? (this.value + half) / SCALE * SCALE
      : -((-this.value + half) / SCALE * SCALE);
    return new Decimal(rounded, this.scale);
  }

  isZero() {
    return this.value === 0n;
  }

  isNegative() {
    return this.value < 0n;
  }

  rescaleTo(targetScale) {
    if (targetScale === this.scale) return this;
    if (targetScale > this.scale) {
      return new Decimal(this.value * (targetScale / this.scale), targetScale);
    }
    return new Decimal(this.value / (this.scale / targetScale), targetScale);
  }

  /** 规范化字符串：去尾零、去小数点，整数绝不带 ".0"。 */
  toString() {
    const neg = this.value < 0n;
    const abs = neg ? -this.value : this.value;
    const intPart = abs / SCALE;
    let frac = (abs % SCALE).toString().padStart(SCALE_EXP, '0').replace(/0+$/, '');
    return `${neg ? '-' : ''}${intPart}${frac ? '.' + frac : ''}`;
  }

  equals(other) {
    return this.value === Decimal.of(other).rescaleTo(this.scale).value;
  }
}

export const SCALE_EXP = 6;
export const SCALE = 10n ** BigInt(SCALE_EXP);
