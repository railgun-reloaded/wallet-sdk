function arrayToByteLength (byteArray: Uint8Array, length: number) : Uint8Array {
  if (byteArray.length > length) throw new Error('BigInt byte size is larger than length')
  return new Uint8Array(new Array(length - byteArray.length).concat(...byteArray))
}

function numberStringToUint8Array (ns: string, length: number): Uint8Array {
  let hex = BigInt(ns).toString(16)
  if (hex.length % 2) hex = `0${hex}`
  const hexArray = hex.match(/.{2}/g) ?? []
  const byteArray = new Uint8Array(hexArray.map((byte) => parseInt(byte, 16)))
  return arrayToByteLength(byteArray, length)
}

export { numberStringToUint8Array }
