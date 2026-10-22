/**
 * طبقة التشفير — الواجهة العامة. كل فك التشفير يمر من هنا (§6.3): المكونات
 * لا ترى Plaintext إلا عند العرض.
 */
export { initMlsWasm, getSpikeClientClass } from './wasm';
export {
  u8ToB64,
  b64ToU8,
  u8ToHex,
  hexToU8,
  u8ToBase32,
  base32ToU8,
  utf8ToU8,
  u8ToUtf8,
  randomBytes,
  uuid4,
} from './encoding';
export { wipeCryptoStore } from './keystore';
export * as keystore from './keystore';
export { cryptoApi, type TransparencyEntry } from './api';
export {
  bootstrapUserCrypto,
  loadIdentity,
  loadCurrentDevice,
  listDeviceKeys,
  refreshDeviceStatus,
  signWithCurrentDevice,
  userIdBytes,
  type StoredIdentity,
  type StoredDeviceKeys,
} from './identity';
export { devicesApi, deviceStatusLabel, type ApiDevice } from './devices';
export {
  setMlsTransport,
  ensureKeyPackage,
  createConversation,
  initThreadGroup,
  verifyMlsSender,
  getCurrentDeviceId,
  feedMessages,
  syncConversation,
  syncNewDeviceToGroups,
  encryptMessage,
  decryptMessage,
  decryptTitle,
  addMembers,
  removeMembers,
  exportGroupState,
  importGroupState,
  resetMlsSession,
  getChatSeq,
  setLastReadSeq,
  type FeedResult,
  type EncryptedOutgoing,
  type DeviceSyncSummary,
} from './mls';
export {
  generateRecoveryKey,
  encryptRecoveryBundle,
  uploadBackup,
  restoreFromRecoveryKey,
  type RecoveryKeyDisplay,
  type RecoveryBackupRecord,
} from './recovery';
export { setAuthBridge, useAuthUser } from './authBridge';
