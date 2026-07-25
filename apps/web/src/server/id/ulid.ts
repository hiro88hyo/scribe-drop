const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RANDOM_BYTES = 10;
const ULID_TIME_LENGTH = 10;
const ULID_RANDOM_LENGTH = 16;
const MAX_ULID_TIMESTAMP = 2 ** 48 - 1;

export type RandomBytes = (length: number) => Uint8Array;

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function encodeBase32(value: bigint, length: number): string {
  let remaining = value;
  let encoded = "";

  for (let index = 0; index < length; index += 1) {
    const character = CROCKFORD_BASE32[Number(remaining & 31n)];
    if (character === undefined) {
      throw new Error("ULID alphabet lookup failed");
    }
    encoded = character + encoded;
    remaining >>= 5n;
  }

  if (remaining !== 0n) {
    throw new Error("ULID value exceeds its encoded length");
  }
  return encoded;
}

export function createUlid(
  timestampMilliseconds: number,
  randomBytes: RandomBytes = defaultRandomBytes,
): string {
  if (
    !Number.isSafeInteger(timestampMilliseconds) ||
    timestampMilliseconds < 0 ||
    timestampMilliseconds > MAX_ULID_TIMESTAMP
  ) {
    throw new Error("ULID timestamp is outside the supported range");
  }

  const random = randomBytes(ULID_RANDOM_BYTES);
  if (random.byteLength !== ULID_RANDOM_BYTES) {
    throw new Error("ULID random source returned an invalid byte count");
  }

  let randomValue = 0n;
  for (const byte of random) {
    randomValue = (randomValue << 8n) | BigInt(byte);
  }

  return (
    encodeBase32(BigInt(timestampMilliseconds), ULID_TIME_LENGTH) +
    encodeBase32(randomValue, ULID_RANDOM_LENGTH)
  );
}
