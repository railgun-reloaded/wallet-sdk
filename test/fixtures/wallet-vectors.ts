// Known-vector BIP39 mnemonic + derived values, captured from
// @railgun-reloaded/wallet-node's RailgunWallet combined with the
// production wallet-ID scheme: sha256(seed || indexHex_bytes).
//
// Regenerate via:
//   node -e "(async () => {
//     const { RailgunWallet, Mnemonic, uint8ArrayToHex, initializeCryptographyLibs }
//       = require('@railgun-reloaded/wallet-node');
//     const { sha256 } = require('@railgun-reloaded/cryptography');
//     await initializeCryptographyLibs();
//     // ... (see test/fixtures/wallet-vectors.ts head comment for full snippet)
//   })();"

const MNEMONIC = 'test test test test test test test test test test test junk'

type Vector = {
  index: number
  walletId: string          // hex, no 0x
  masterPublicKey: string   // hex, no 0x
  viewingPublicKey: string  // hex, no 0x
  viewingPrivateKey: string // hex, no 0x
  nullifyingKey: string     // hex, no 0x
}

const VECTORS: Vector[] = [
  {
    index: 0,
    walletId: 'bee63912e0e4cfa6830ebc8342d3efa9aa1336548c77bf4336c54c17409f2990',
    masterPublicKey: '2c59cd4733f911ba740da68fb7ba3b873f21daece4e3a105aef12d6414e54ebf',
    viewingPublicKey: '77d7aa7c5b978060be2ba78cbc0ef92a4f3aa3fc29803eaf47847cf510b986ea',
    viewingPrivateKey: '9da4b4f0b5493a6ba3f7df0611c3e0842f7e2bb3d640f313b235f1b75c1d80b9',
    nullifyingKey: '12804a19eb4b9bf67d2bafbd0ec05f0bfa071a2344c1688553ef5c4be6f44178'
  },
  {
    index: 1,
    walletId: '89924cf2e0138b4cf1bcfca869a9513a8f2a3745b433841834baf90afe0fd7bc',
    masterPublicKey: '22c3d1870a9f3bddf34492262f9a1ce280133fb2751f346aab32df97149bcd91',
    viewingPublicKey: '45f25fda60af06969b609b94203e90bbeb54ccb7cca7c1060862dc2f5f7395ea',
    viewingPrivateKey: '9960238a86a7ecff390b7f37f680e7468fa0c41ee3704fcc68f0be82d19be4b2',
    nullifyingKey: '09748607b56623bb09d7bd240e2dab896e362701f2926815db35a3f94652fb4b'
  }
]

export { MNEMONIC, VECTORS }
export type { Vector }
