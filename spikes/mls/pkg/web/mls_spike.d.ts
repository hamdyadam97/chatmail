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

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_spikeclient_free: (a: number, b: number) => void;
    readonly spikeclient_add_member: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly spikeclient_create_group: (a: number, b: number, c: number, d: any) => [number, number, number];
    readonly spikeclient_encrypt: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly spikeclient_epoch: (a: number, b: number, c: number) => [bigint, number, number];
    readonly spikeclient_export_state: (a: number, b: number, c: number) => [number, number, number, number];
    readonly spikeclient_import_state: (a: number, b: number, c: number) => [number, number];
    readonly spikeclient_join_from_welcome: (a: number, b: number, c: number) => [number, number, number, number];
    readonly spikeclient_key_package: (a: number) => [number, number, number, number];
    readonly spikeclient_member_identities: (a: number, b: number, c: number) => [number, number, number];
    readonly spikeclient_member_index: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly spikeclient_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly spikeclient_process: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly spikeclient_remove_member: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
