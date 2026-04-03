/**
 * Pad an input array to request length
 * @param byteArray - Input array
 * @param length - Size
 * @returns - Padded array of Uint8Array
 */
function arrayToByteLength (byteArray: Uint8Array, length: number) : Uint8Array {
  // Check the length of array requested is large enough to accommodate the original array
  if (byteArray.length > length) throw new Error('BigInt byte size is larger than length')

  // Create Uint8Array of requested length
  return new Uint8Array(new Array(length - byteArray.length).concat(...byteArray))
}
/**
 * Convert number string to Uint8Array
 * @param ns - Number string
 * @param length  - Padded length required for hex string
 * @returns - Uint8Array representation of number string
 */
function numberStringToUint8Array (ns: string, length: number): Uint8Array {
  // Convert bigint to hex string
  let hex = BigInt(ns).toString(16)

  // If hex is odd length then add leading zero
  if (hex.length % 2) hex = `0${hex}`

  // Split into groups of 2 to create hex array
  const hexArray = hex.match(/.{2}/g) ?? []

  // Convert hex array to uint8 byte array
  const byteArray = new Uint8Array(hexArray.map((byte) => parseInt(byte, 16)))

  return arrayToByteLength(byteArray, length)
}

export { numberStringToUint8Array }
