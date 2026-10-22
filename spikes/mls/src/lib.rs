//! MLS (RFC 9420) spike wrapper: mls-rs 0.56 + pure-Rust rustcrypto provider,
//! compiled to wasm32-unknown-unknown, driven from Node via wasm-bindgen.
//!
//! Mirrors the design in docs/phase1/03-key-management.md: each DEVICE is an
//! independent MLS client (BasicCredential carrying an app-defined identity
//! byte string, e.g. "userA|device1"). The server is a dumb pipe: only opaque
//! MLS payloads (KeyPackage / Welcome / Commit / Application) cross the wire.
//!
//! Architecture note: the wrapper deliberately does NOT keep live Group
//! objects between calls. Every operation builds a short-lived Client, loads
//! the group from the MemStorage snapshot, mutates, writes back — the same
//! pattern the browser will use with IndexedDB (docs/phase1/03 §3.9).

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};

use js_sys::{Array, Object, Reflect, Uint8Array};
use mls_rs::client_builder::MlsConfig;
use mls_rs::identity::basic::{BasicCredential, BasicIdentityProvider};
use mls_rs::identity::Credential;
use mls_rs::mls_rules::{CommitOptions, DefaultMlsRules};
use mls_rs::{
    group::Group, CipherSuite, CipherSuiteProvider, Client, CryptoProvider, ExtensionList,
    GroupStateStorage, KeyPackageStorage, MlsMessage,
};
use mls_rs_core::group::{EpochRecord, GroupState};
use mls_rs_core::key_package::KeyPackageData;
use mls_rs_crypto_rustcrypto::RustCryptoProvider;
use mls_rs::mls_rs_codec::{MlsDecode, MlsEncode};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

const CIPHER_SUITE: CipherSuite = CipherSuite::CURVE25519_AES128;

fn js_err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

// ---------------------------------------------------------------------------
// In-memory GroupStateStorage with observable contents, so export_state /
// import_state can snapshot it the way the browser will snapshot IndexedDB.
// Blobs are opaque to us (mls-rs Snapshot encodings); we never inspect them.
// ---------------------------------------------------------------------------

#[derive(Default, Clone)]
struct MemStorage {
    inner: Arc<Mutex<StorageMap>>,
}

#[derive(Default)]
struct StorageMap {
    /// group_id -> (current state blob, epoch -> prior epoch blob)
    groups: HashMap<Vec<u8>, (Zeroizing<Vec<u8>>, HashMap<u64, Zeroizing<Vec<u8>>>)>,
    max_epoch: HashMap<Vec<u8>, u64>,
}

impl GroupStateStorage for MemStorage {
    type Error = Infallible;

    fn state(&self, group_id: &[u8]) -> Result<Option<Zeroizing<Vec<u8>>>, Infallible> {
        Ok(self
            .inner
            .lock()
            .unwrap()
            .groups
            .get(group_id)
            .map(|(current, _)| current.clone()))
    }

    fn epoch(
        &self,
        group_id: &[u8],
        epoch_id: u64,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, Infallible> {
        Ok(self
            .inner
            .lock()
            .unwrap()
            .groups
            .get(group_id)
            .and_then(|(_, epochs)| epochs.get(&epoch_id).cloned()))
    }

    fn write(
        &mut self,
        state: GroupState,
        epoch_inserts: Vec<EpochRecord>,
        epoch_updates: Vec<EpochRecord>,
    ) -> Result<(), Infallible> {
        let mut map = self.inner.lock().unwrap();
        let entry = map.groups.entry(state.id).or_default();
        entry.0 = state.data;
        for record in epoch_inserts.into_iter().chain(epoch_updates) {
            entry.1.insert(record.id, record.data);
        }
        Ok(())
    }

    fn max_epoch_id(&self, group_id: &[u8]) -> Result<Option<u64>, Infallible> {
        Ok(self.inner.lock().unwrap().max_epoch.get(group_id).copied())
    }
}

impl MemStorage {
    fn snapshot(&self) -> Vec<u8> {
        let map = self.inner.lock().unwrap();
        let mut out = Vec::new();
        put_u32(&mut out, map.groups.len() as u32);
        for (gid, (current, epochs)) in map.groups.iter() {
            put_bytes(&mut out, gid);
            put_bytes(&mut out, current);
            put_u32(&mut out, epochs.len() as u32);
            for (epoch, data) in epochs.iter() {
                out.extend_from_slice(&epoch.to_be_bytes());
                put_bytes(&mut out, data);
            }
        }
        out
    }

    fn restore(&self, mut data: &[u8]) -> Result<(), JsValue> {
        let mut map = self.inner.lock().unwrap();
        map.groups.clear();
        map.max_epoch.clear();
        let n = take_u32(&mut data)? as usize;
        for _ in 0..n {
            let gid = take_bytes(&mut data)?;
            let current = take_bytes(&mut data)?.into();
            let ec = take_u32(&mut data)? as usize;
            let mut epochs = HashMap::new();
            for _ in 0..ec {
                let epoch = take_u64(&mut data)?;
                let blob = take_bytes(&mut data)?.into();
                epochs.insert(epoch, blob);
            }
            let max = epochs.keys().max().copied().unwrap_or(0);
            map.max_epoch.insert(gid.clone(), max);
            map.groups.insert(gid, (current, epochs));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Shared in-memory KeyPackageStorage: generated KeyPackages (and their secret
// keys) must survive between wrapper calls, exactly like the browser's
// IndexedDB will persist pending KeyPackages across sessions.
// ---------------------------------------------------------------------------

#[derive(Default, Clone)]
struct MemKeyPackageStorage {
    inner: Arc<Mutex<HashMap<Vec<u8>, Zeroizing<Vec<u8>>>>>,
}

impl KeyPackageStorage for MemKeyPackageStorage {
    type Error = mls_rs::mls_rs_codec::Error;

    fn insert(&mut self, id: Vec<u8>, pkg: KeyPackageData) -> Result<(), Self::Error> {
        let bytes = pkg.mls_encode_to_vec()?;
        self.inner.lock().unwrap().insert(id, bytes.into());
        Ok(())
    }

    fn get(&self, id: &[u8]) -> Result<Option<KeyPackageData>, Self::Error> {
        match self.inner.lock().unwrap().get(id) {
            Some(bytes) => Ok(Some(KeyPackageData::mls_decode(&mut &bytes[..])?)),
            None => Ok(None),
        }
    }

    fn delete(&mut self, id: &[u8]) -> Result<(), Self::Error> {
        self.inner.lock().unwrap().remove(id);
        Ok(())
    }
}

impl MemKeyPackageStorage {
    fn snapshot(&self) -> Vec<u8> {
        let map = self.inner.lock().unwrap();
        let mut out = Vec::new();
        put_u32(&mut out, map.len() as u32);
        for (id, data) in map.iter() {
            put_bytes(&mut out, id);
            put_bytes(&mut out, data);
        }
        out
    }

    fn restore(&self, mut data: &[u8]) -> Result<(), JsValue> {
        let mut map = self.inner.lock().unwrap();
        map.clear();
        let n = take_u32(&mut data)? as usize;
        for _ in 0..n {
            let id = take_bytes(&mut data)?;
            let blob = take_bytes(&mut data)?.into();
            map.insert(id, blob);
        }
        Ok(())
    }
}

fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}
fn put_bytes(out: &mut Vec<u8>, v: &[u8]) {
    put_u32(out, v.len() as u32);
    out.extend_from_slice(v);
}
fn take_u32(data: &mut &[u8]) -> Result<u32, JsValue> {
    if data.len() < 4 {
        return Err(JsValue::from_str("snapshot truncated (u32)"));
    }
    let (a, b) = data.split_at(4);
    *data = b;
    Ok(u32::from_be_bytes(a.try_into().unwrap()))
}
fn take_u64(data: &mut &[u8]) -> Result<u64, JsValue> {
    if data.len() < 8 {
        return Err(JsValue::from_str("snapshot truncated (u64)"));
    }
    let (a, b) = data.split_at(8);
    *data = b;
    Ok(u64::from_be_bytes(a.try_into().unwrap()))
}
fn take_bytes(data: &mut &[u8]) -> Result<Vec<u8>, JsValue> {
    let n = take_u32(data)? as usize;
    if data.len() < n {
        return Err(JsValue::from_str("snapshot truncated (bytes)"));
    }
    let (a, b) = data.split_at(n);
    *data = b;
    Ok(a.to_vec())
}

// ---------------------------------------------------------------------------
// Client factory. Returns `impl MlsConfig` so we never have to name the
// (deliberately opaque) concrete config type.
// ---------------------------------------------------------------------------

fn make_client(
    identity: &[u8],
    seed: &[u8],
    storage: MemStorage,
    kp_store: MemKeyPackageStorage,
) -> Result<Client<impl MlsConfig>, JsValue> {
    let crypto = RustCryptoProvider::default();
    let cs = crypto
        .cipher_suite_provider(CIPHER_SUITE)
        .ok_or_else(|| JsValue::from_str("cipher suite unavailable"))?;
    // The rustcrypto provider expects Ed25519 secrets in ed25519-dalek
    // keypair format (64 bytes = 32-byte seed || 32-byte public key). Accept a
    // plain 32-byte seed for determinism and expand it here.
    let secret = if seed.len() == 32 {
        let signing = ed25519_dalek::SigningKey::from_bytes(
            seed.try_into()
                .map_err(|_| JsValue::from_str("seed must be 32 bytes"))?,
        );
        let mut bytes = seed.to_vec();
        bytes.extend_from_slice(&signing.verifying_key().to_bytes());
        mls_rs::crypto::SignatureSecretKey::new(bytes)
    } else {
        mls_rs::crypto::SignatureSecretKey::new(seed.to_vec())
    };
    let public = cs.signature_key_derive_public(&secret).map_err(js_err)?;
    let credential = BasicCredential::new(identity.to_vec());
    let signing_identity = mls_rs::identity::SigningIdentity::new(
        Credential::Basic(credential),
        public,
    );

    Ok(Client::builder()
        .crypto_provider(crypto)
        .identity_provider(BasicIdentityProvider)
        .group_state_storage(storage)
        .key_package_repo(kp_store)
        .mls_rules(
            DefaultMlsRules::new()
                .with_commit_options(CommitOptions::new().with_path_required(true)),
        )
        .signing_identity(signing_identity, secret, CIPHER_SUITE)
        .build())
}

fn load_group<C>(client: &Client<C>, group_id: &[u8]) -> Result<Group<C>, JsValue>
where
    C: MlsConfig,
{
    client.load_group(group_id).map_err(js_err)
}

/// Convenience: run a mutating operation against a stored group and persist
/// the result back to storage.
fn with_group_mut<C, T>(
    client: &Client<C>,
    group_id: &[u8],
    op: impl FnOnce(&mut Group<C>) -> Result<T, JsValue>,
) -> Result<T, JsValue>
where
    C: MlsConfig,
{
    let mut group = client.load_group(group_id).map_err(js_err)?;
    let out = op(&mut group)?;
    group.write_to_storage().map_err(js_err)?;
    Ok(out)
}

fn commit_output_to_js(
    output: &mls_rs::group::CommitOutput,
) -> Result<Array, JsValue> {
    let arr = Array::new();
    arr.push(&Uint8Array::from(
        output.commit_message.to_bytes().map_err(js_err)?.as_slice(),
    ));
    // One welcome per added member (unless the MLS rules merge them into a
    // single message); callers hand each new member their own welcome.
    for welcome in output.welcome_messages.iter() {
        arr.push(&Uint8Array::from(welcome.to_bytes().map_err(js_err)?.as_slice()));
    }
    Ok(arr)
}

fn set(obj: &Object, key: &str, value: impl Into<JsValue>) -> Result<(), JsValue> {
    Reflect::set(obj, &JsValue::from_str(key), &value.into())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kp_gen_host() {
        let storage = MemStorage::default();
        let kp_store = MemKeyPackageStorage::default();
        let client = make_client(b"alice|dev1", &vec![7u8; 32], storage, kp_store).unwrap();
        match client.generate_key_package_message(Default::default(), Default::default(), None) {
            Ok(k) => println!("KP OK {} bytes", k.to_bytes().unwrap().len()),
            Err(e) => panic!("KP ERR: {e:?}"),
        }
    }
}

// ---------------------------------------------------------------------------
// WASM API
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct SpikeClient {
    identity: Vec<u8>,
    seed: Vec<u8>,
    storage: MemStorage,
    kp_store: MemKeyPackageStorage,
}

#[wasm_bindgen]
impl SpikeClient {
    /// Create a device client. `identity` is the app-level credential bytes
    /// (e.g. "userA|device1"); `seed` is a 32-byte Ed25519 secret seed so
    /// tests are deterministic and clients can be re-instantiated.
    #[wasm_bindgen(constructor)]
    pub fn new(identity: &[u8], seed: &[u8]) -> Result<SpikeClient, JsValue> {
        Ok(SpikeClient {
            identity: identity.to_vec(),
            seed: seed.to_vec(),
            storage: MemStorage::default(),
            kp_store: MemKeyPackageStorage::default(),
        })
    }

    fn client(&self) -> Result<Client<impl MlsConfig>, JsValue> {
        make_client(&self.identity, &self.seed, self.storage.clone(), self.kp_store.clone())
    }

    /// Generate a serialized KeyPackage (MlsMessage bytes) for this device.
    pub fn key_package(&self) -> Result<Vec<u8>, JsValue> {
        let client = self.client()?;
        let kp = client
            .generate_key_package_message(Default::default(), Default::default(), None)
            .map_err(|e| JsValue::from_str(&format!("key_package failed: {e:?}")))?;
        kp.to_bytes().map_err(js_err)
    }

    /// Create a group with the given id and add every serialized KeyPackage in
    /// `key_packages` (js Array of Uint8Array) in a single commit.
    /// Returns [commit_bytes, welcome_bytes].
    pub fn create_group(&mut self, group_id: &[u8], key_packages: Array) -> Result<Array, JsValue> {
        let client = self.client()?;
        let mut group = client
            .create_group_with_id(group_id.to_vec(), ExtensionList::default(), ExtensionList::default(), None)
            .map_err(js_err)?;

        let mut builder = group.commit_builder();
        for kp in key_packages.iter() {
            let bytes = Uint8Array::from(kp).to_vec();
            let msg = MlsMessage::from_bytes(&bytes).map_err(js_err)?;
            builder = builder.add_member(msg).map_err(js_err)?;
        }
        let output = builder.build().map_err(js_err)?;
        group.apply_pending_commit().map_err(js_err)?;
        group.write_to_storage().map_err(js_err)?;

        commit_output_to_js(&output)
    }

    /// Join a group from a serialized Welcome message. Returns the group id.
    pub fn join_from_welcome(&mut self, welcome: &[u8]) -> Result<Vec<u8>, JsValue> {
        let client = self.client()?;
        let msg = MlsMessage::from_bytes(welcome).map_err(js_err)?;
        let (mut group, _info) = client.join_group(None, &msg, None).map_err(js_err)?;
        let gid = group.group_id().to_vec();
        group.write_to_storage().map_err(js_err)?;
        Ok(gid)
    }

    /// Add a member (serialized KeyPackage) to an existing group.
    /// Returns [commit_bytes, welcome_bytes].
    pub fn add_member(&mut self, group_id: &[u8], key_package: &[u8]) -> Result<Array, JsValue> {
        let client = self.client()?;
        let kp = MlsMessage::from_bytes(key_package).map_err(js_err)?;
        let out = with_group_mut(&client, group_id, |g| {
            let output = g.commit_builder().add_member(kp).map_err(js_err)?.build().map_err(js_err)?;
            g.apply_pending_commit().map_err(js_err)?;
            commit_output_to_js(&output)
        })?;
        Ok(out)
    }

    /// Remove the member whose credential identity equals `identity`.
    /// Returns the commit bytes (no welcome for a removal).
    pub fn remove_member(&mut self, group_id: &[u8], identity: &[u8]) -> Result<Vec<u8>, JsValue> {
        let client = self.client()?;
        let idx = self.member_index(group_id, identity)?;
        let out = with_group_mut(&client, group_id, |g| {
            let output = g
                .commit_builder()
                .remove_member(idx)
                .map_err(js_err)?
                .build()
                .map_err(js_err)?;
            g.apply_pending_commit().map_err(js_err)?;
            output.commit_message.to_bytes().map_err(js_err)
        })?;
        Ok(out)
    }

    /// Encrypt an application message. Returns serialized MlsMessage bytes.
    /// The sender ratchet advances, so the group is persisted afterwards.
    pub fn encrypt(&mut self, group_id: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, JsValue> {
        let client = self.client()?;
        let out = with_group_mut(&client, group_id, |g| {
            let msg = g
                .encrypt_application_message(plaintext, Vec::new())
                .map_err(js_err)?;
            msg.to_bytes().map_err(js_err)
        })?;
        Ok(out)
    }

    /// Process an incoming MLS message (commit / application / proposal).
    /// Returns {type: "application"|"commit"|"proposal"|..., epoch, ...}.
    /// Cryptographic failures (post-removal epochs, tampered ciphertext,
    /// replayed messages) come back as Err -> JS exception; that is what the
    /// security scenarios assert on.
    pub fn process(&mut self, group_id: &[u8], msg: &[u8]) -> Result<Object, JsValue> {
        let client = self.client()?;
        let msg = MlsMessage::from_bytes(msg).map_err(js_err)?;
        let (obj, epoch) = with_group_mut(&client, group_id, |g| {
            let processed = g.process_incoming_message(msg).map_err(js_err)?;
            let epoch = g.current_epoch();
            let obj = Object::new();
            match processed {
                mls_rs::group::ReceivedMessage::ApplicationMessage(app) => {
                    set(&obj, "type", "application")?;
                    set(&obj, "epoch", epoch)?;
                    set(&obj, "sender_index", app.sender_index)?;
                    set(&obj, "plaintext", Uint8Array::from(app.data()))?;
                }
                mls_rs::group::ReceivedMessage::Commit(commit) => {
                    set(&obj, "type", "commit")?;
                    set(&obj, "epoch", epoch)?;
                    set(&obj, "committer", commit.committer)?;
                }
                mls_rs::group::ReceivedMessage::Proposal(_) => {
                    set(&obj, "type", "proposal")?;
                    set(&obj, "epoch", epoch)?;
                }
                _ => {
                    set(&obj, "type", "other")?;
                    set(&obj, "epoch", epoch)?;
                }
            }
            Ok((obj, epoch))
        })?;
        let _ = epoch;
        Ok(obj)
    }

    /// Serialize every stored group state plus pending KeyPackages to one
    /// opaque blob.
    pub fn export_state(&self, _group_id: &[u8]) -> Result<Vec<u8>, JsValue> {
        let mut out = self.storage.snapshot();
        out.extend_from_slice(&self.kp_store.snapshot());
        Ok(out)
    }

    /// Restore storage from a blob. Groups are loaded lazily on next use.
    pub fn import_state(&mut self, blob: &[u8]) -> Result<(), JsValue> {
        // The blob is [group section][kp section]; each section is
        // length-prefixed, so split by parsing the group section first.
        let mut data = blob;
        let n = take_u32(&mut data)? as usize;
        // rewind: re-parse from the start via restore paths
        let mut groups_len = 4;
        for _ in 0..n {
            let gid = take_bytes(&mut data)?;
            groups_len += 4 + gid.len();
            let current = take_bytes(&mut data)?;
            groups_len += 4 + current.len();
            let ec = take_u32(&mut data)? as usize;
            groups_len += 4;
            for _ in 0..ec {
                let _epoch = take_u64(&mut data)?;
                groups_len += 8;
                let b = take_bytes(&mut data)?;
                groups_len += 4 + b.len();
            }
        }
        self.storage.restore(&blob[..groups_len])?;
        self.kp_store.restore(&blob[groups_len..])?;
        Ok(())
    }

    /// Current epoch of a group.
    pub fn epoch(&self, group_id: &[u8]) -> Result<u64, JsValue> {
        let client = self.client()?;
        let group = load_group(&client, group_id)?;
        Ok(group.current_epoch())
    }

    /// Identities (credential identifiers) of current members, roster order.
    pub fn member_identities(&self, group_id: &[u8]) -> Result<Array, JsValue> {
        let client = self.client()?;
        let group = load_group(&client, group_id)?;
        let arr = Array::new();
        let roster = group.roster();
        for m in roster.members_iter() {
            if let Credential::Basic(basic) = &m.signing_identity.credential {
                arr.push(&Uint8Array::from(basic.identifier.as_slice()));
            }
        }
        Ok(arr)
    }

    /// Leaf index of a member by identity bytes.
    pub fn member_index(&self, group_id: &[u8], identity: &[u8]) -> Result<u32, JsValue> {
        let client = self.client()?;
        let group = load_group(&client, group_id)?;
        let roster = group.roster();
        let found = roster
            .members_iter()
            .find(|m| match &m.signing_identity.credential {
                Credential::Basic(basic) => basic.identifier == identity,
                _ => false,
            })
            .map(|m| m.index);
        found.ok_or_else(|| JsValue::from_str("member not found"))
    }
}
