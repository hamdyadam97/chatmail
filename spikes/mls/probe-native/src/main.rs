use mls_rs::identity::basic::{BasicCredential, BasicIdentityProvider};
use mls_rs::identity::{Credential, SigningIdentity};
use mls_rs::{CipherSuite, CipherSuiteProvider, Client, CryptoProvider};

fn main() {
    let crypto0 = mls_rs_crypto_rustcrypto::RustCryptoProvider::default();
    let cs0 = crypto0
        .cipher_suite_provider(CipherSuite::CURVE25519_AES128)
        .expect("cipher suite");
    // Mirror the wasm wrapper: 32-byte Ed25519 seed supplied by the caller.
    let secret = mls_rs::crypto::SignatureSecretKey::new(vec![7u8; 32]);
    let public = cs0.signature_key_derive_public(&secret).expect("derive");
    println!("derive ok from 32-byte seed");

    let cred = BasicCredential::new(b"alice|dev1".to_vec());
    let si = SigningIdentity::new(Credential::Basic(cred), public);
    let client = Client::builder()
        .crypto_provider(crypto0)
        .identity_provider(BasicIdentityProvider)
        .signing_identity(si, secret, CipherSuite::CURVE25519_AES128)
        .build();

    match client.generate_key_package_message(Default::default(), Default::default(), None) {
        Ok(kp) => println!("KP OK {} bytes", kp.to_bytes().unwrap().len()),
        Err(e) => println!("KP ERR {e:?}"),
    }
}
