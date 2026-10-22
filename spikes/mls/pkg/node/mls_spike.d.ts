/* tslint:disable */
/* eslint-disable */

export class SpikeClient {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add a member (serialized KeyPackage) to an existing group.
     * Returns [commit_bytes, welcome_bytes].
     */
    add_member(group_id: Uint8Array, key_package: Uint8Array): Array<any>;
    /**
     * Create a group with the given id and add every serialized KeyPackage in
     * `key_packages` (js Array of Uint8Array) in a single commit.
     * Returns [commit_bytes, welcome_bytes].
     */
    create_group(group_id: Uint8Array, key_packages: Array<any>): Array<any>;
    /**
     * Encrypt an application message. Returns serialized MlsMessage bytes.
     * The sender ratchet advances, so the group is persisted afterwards.
     */
    encrypt(group_id: Uint8Array, plaintext: Uint8Array): Uint8Array;
    /**
     * Current epoch of a group.
     */
    epoch(group_id: Uint8Array): bigint;
    /**
     * Serialize every stored group state plus pending KeyPackages to one
     * opaque blob.
     */
    export_state(_group_id: Uint8Array): Uint8Array;
    /**
     * Restore storage from a blob. Groups are loaded lazily on next use.
     */
    import_state(blob: Uint8Array): void;
    /**
     * Join a group from a serialized Welcome message. Returns the group id.
     */
    join_from_welcome(welcome: Uint8Array): Uint8Array;
    /**
     * Generate a serialized KeyPackage (MlsMessage bytes) for this device.
     */
    key_package(): Uint8Array;
    /**
     * Identities (credential identifiers) of current members, roster order.
     */
    member_identities(group_id: Uint8Array): Array<any>;
    /**
     * Leaf index of a member by identity bytes.
     */
    member_index(group_id: Uint8Array, identity: Uint8Array): number;
    /**
     * Create a device client. `identity` is the app-level credential bytes
     * (e.g. "userA|device1"); `seed` is a 32-byte Ed25519 secret seed so
     * tests are deterministic and clients can be re-instantiated.
     */
    constructor(identity: Uint8Array, seed: Uint8Array);
    /**
     * Process an incoming MLS message (commit / application / proposal).
     * Returns {type: "application"|"commit"|"proposal"|..., epoch, ...}.
     * Cryptographic failures (post-removal epochs, tampered ciphertext,
     * replayed messages) come back as Err -> JS exception; that is what the
     * security scenarios assert on.
     */
    process(group_id: Uint8Array, msg: Uint8Array): object;
    /**
     * Remove the member whose credential identity equals `identity`.
     * Returns the commit bytes (no welcome for a removal).
     */
    remove_member(group_id: Uint8Array, identity: Uint8Array): Uint8Array;
}
