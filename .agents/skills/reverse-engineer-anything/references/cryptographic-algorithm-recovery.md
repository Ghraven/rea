# Cryptographic algorithm recovery from execution traces

Identify, and where the evidence allows reconstruct, a cryptographic, signing,
or encoding algorithm from a recorded execution trace or passive runtime
observation of a shipped binary. Use this when a claim depends on *how* a
ciphertext, header, token, MAC, or signature was produced and that behavior is
not established by available source. The output is an Evidence-backed
identification or reconstruction with explicit limitations, not a guarantee.

This workflow pairs with [runtime observation](runtime-observation.md) for
capturing behavior and [evidence workflows](evidence-workflows.md) for recording
findings, comparisons, and unknowns. Static-only inputs (a disassembly region,
a decompiled function) follow [native and artifacts](native-and-artifacts.md).

## Scope boundary

This is an identification-and-evidence workflow. Recognizing and reporting a
protection (packer, control-flow obfuscation, VM, white-box) is in scope;
defeating it is not. Do not use this document to recover automatically
protected code, lift a VM's bytecode into cleartext logic, extract a white-box's
embedded key for bypass, or forge a signature or token. When a target's
algorithm sits behind such protection, identify and report the protection, then
stop and `record_unknown`. Algorithm understanding for interoperability,
verification, or evidence stays in scope; protection defeat does not.

## Evidence discipline

Answer only from trace evidence. Never invent instructions, register values,
memory bytes, function boundaries, keys, constants, field semantics, branch
outcomes, or call relations. Cite the `evidence_id` or trace anchor behind every
structural claim. A fingerprint or matching pattern is a hypothesis, not causal
proof of which algorithm ran.

Before concluding a high-confidence identification, run an adversarial pass
against your own claim: list the observations that would be present if you were
wrong, confirm they are absent in the trace rather than merely unmentioned, and
keep every residual gap in `record_unknown` with its required authority or
coverage. A conclusion that no counter-evidence was sought is not high
confidence.

## Multi-signal correlation

No single signal identifies an algorithm on a hardened target. Correlate at
least two of: constant fingerprints, instruction fingerprints, data-flow shape
(key schedule, round count, block size, table lookups), and the I/O boundary
(input bytes in, output bytes out). Treat agreement across independent signals
as the evidence, not any one hit.

- **Zero constant hits is not absence.** Constants may be computed at runtime,
  loaded from a data section the trace never reads as immediates, masked by a
  modification, broadcast through SIMD lanes rather than scalar loads, or hidden
  by a white-box table. Enumerate the benign explanations before concluding
  "no crypto."
- **An instruction fingerprint is strong but not final.** ARM Crypto Extensions
  (`aes*`, `sha1*`, `sha256*`, `sha512*`, `pmull`/`pmull2`, `crc32*`) pin the
  primitive family but not the mode, key, or whether the primitive is load-
  bearing versus incidental. Confirm the surrounding data flow.
- **A primitive can run without a recognizable mnemonic** — table-driven
  software AES, a bitsliced implementation, or a NEON-vectorized core. Absence
  of the mnemonic does not rule the primitive out; look for the table or the
  lane pattern instead.
- **ALU-only "hits" are usually false positives.** A constant that appears only
  as the result of arithmetic, never as a loaded immediate or a memory read, is
  typically a collision. Weight real immediate/memory evidence over ALU
  coincidence, and SIMD-broadcast evidence (e.g. HMAC ipad/opad across lanes)
  as its own class.

## Four-phase recovery

**A — Locate.** Find the crypto region from the I/O boundary: the trace window
where the known input is consumed and the known output is produced. Bound it by
call-frame entry/exit so later phases reason over a finite region, not the whole
trace.

**B — Reconstruct data flow.** Within the region, recover the key schedule
(how key material expands across rounds), the round function and round count,
and any table lookups (sbox, T-tables, permutation tables). Record block size,
endianness, and padding from observed bytes, not assumption.

**C — Identify and check for modification.** Match the recovered structure
against candidates (cheat sheet below). When the structure matches a known
algorithm but a constant, rotation amount, sbox entry, or round count differs,
report it as "<algorithm>-like with modifications" and name the specific
deviation and its anchor. A modified algorithm shares the shape, not the test
vectors.

**D — Closed-loop verification.** An identification is unverified until a
reference implementation, driven with the trace's observed inputs and
parameters, reproduces the trace's observed output byte-for-byte. A partial or
structural-only match is a candidate; say so. If verification is impossible with
available inputs, deliver the candidate and `record_unknown` for the missing
input or parameter rather than overstating the result.

## Constant and structure fingerprints

Identification evidence only; presence of a fingerprint is a hypothesis to
corroborate, never a conclusion on its own.

- **Hash:** MD5 (init + 64-entry T table), SHA-1, SHA-256 (init + K table),
  SHA-512, SM3 (init + T_j round constants), SHA-3/Keccak round constants,
  CRC32, FNV-1a. In an active hashing region the main-loop constants (T/K/T_j)
  dominate the signal, not the IV. Count carefully: for algorithms with one
  distinct constant per round (MD5, SHA-256), each table entry appears about
  once per block, so its hit count tracks block count. This does not hold where
  a constant is reused across many rounds — SHA-1 reuses each of four constants
  for 20 rounds, SM3 reuses two base constants — so there a high hit count
  reflects per-round reuse, not many blocks.
- **Symmetric:** AES (sbox, `sbox[0]=0x63` / Te tables), SM4, DES/3DES
  (SP-boxes), TEA/XTEA/XXTEA (delta `0x9E3779B9`), ChaCha20/Salsa20
  (`"expand 32-byte k"`).
- **MAC:** HMAC (ipad `0x36` / opad `0x5C`, scalar or SIMD-broadcast),
  Poly1305, SipHash.
- **ECC:** NIST P-256, secp256k1, Ed25519 / Curve25519, SM2 `sm2p256v1` —
  field prime, curve parameters, and base point.

A fingerprint narrows the candidate family; it never settles block size, round
count, mode, or whether the primitive is load-bearing. Corroborate with
structure before concluding, and treat a changed constant as a modification,
not a different algorithm (phase C).

### Known-constant cheat sheet

Match any of these in the trace as strong family evidence, then confirm
structure. Values are byte-order sensitive, and a modified implementation may
alter them.

```text
GM/T (Chinese national)
  SM3 IV         7380166F 4914B2B9 172442D7 DA8A0600
                 A96F30BC 163138AA E38DEE4D B0FB0E4E
  SM4 FK         A3B1BAC6 56AA3350 677D9197 B27022DC
  SM4 CK[0..7]   00070E15 1C232A31 383F464D 545B6269   (32 round consts;
                 70777E85 8C939AA1 A8AFB6BD C4CBD2D9     +0x07 step, mod 0x100)
  SM2 sm2p256v1
    p  FFFFFFFE FFFFFFFF FFFFFFFF FFFFFFFF FFFFFFFF 00000000 FFFFFFFF FFFFFFFF
    a  FFFFFFFE FFFFFFFF FFFFFFFF FFFFFFFF FFFFFFFF 00000000 FFFFFFFF FFFFFFFC
    b  28E9FA9E 9D9F5E34 4D5A9E4B CF6509A7 F39789F5 15AB8F92 DDBCBD41 4D940E93
    n  FFFFFFFE FFFFFFFF FFFFFFFF FFFFFFFF 7203DF6B 21C6052B 53BBF409 39D54123
    Gx 32C4AE2C 1F198119 5F990446 6A39C994 8FE30BBF F2660BE1 715A4589 334C74C7
    Gy BC3736A2 F4F6779C 59BDCEE3 6B692153 D0A9877C C62A4740 02DF32E5 2139F0A0

Modern
  ChaCha20/Salsa  "expand 32-byte k" = 61707865 3320646E 79622D32 6B206574
                  "expand 16-byte k" = 61707865 3120646E 79622D36 6B206574
  Poly1305 r-mask 0FFFFFFC 0FFFFFFC 0FFFFFFC 0FFFFFFF
  Curve25519      a24 = 0x1DB41 (121665)
  Ed25519 d       high64 = 0x52036CEE2B6FFE73  low64 = 0x75EB4DCA135978A3
  GCM GHASH poly  E1000000 00000000 00000000 00000000  (reflected)
  SHA-256 IV[0]   6A09E667  (remaining IV/K are the standard tables)

Classic / checksums
  TEA/XTEA/XXTEA  delta 9E3779B9  (golden-ratio * 2^32)
  RC5/RC6 P,Q     P32 B7E15163  Q32 9E3779B9
                  P64 B7E151628AED2A6B  Q64 9E3779B97F4A7C15
  CRC-32 (802.3)  EDB88320 (reflected) / 04C11DB7 (normal)
  CRC-32C         82F63B78 (reflected)
```

### AEAD mode composition

No single marker identifies an AEAD; require the composition in the trace. The
authentication tag is produced on encryption and compared on decryption, so key
the identification to the tag operation the trace actually shows — a tag write,
not a compare, for an encrypting trace. Tag length is 16 bytes by default but
not fixed (GCM supports shorter tags); treat a shorter tag as supported, not as
counter-evidence.

- **AES-GCM:** AES block encryption + GHASH accumulation (a GF(2^128) multiply
  per 16 bytes, GHASH poly above) + a tag produced or verified; IV usually
  12 bytes.
- **AES-CCM:** AES + CBC-MAC accumulation + a tag produced or verified; nonce
  `15-L` bytes, where `L` is the message-length field size (a 13-byte nonce is
  `L=2`).
- **ChaCha20-Poly1305:** the `"expand 32-byte k"` constant + Poly1305
  mod-2^130-5 accumulation + a tag produced or verified; IV 12 bytes.
- **AES-SIV:** AES-CMAC + AES-CTR with the IV derived from the CMAC step
  (synthetic IV).

### Rolling / derived token schemes

Common in mobile anti-fraud / risk-control headers: a stored seed plus repeated
keyed derivation. Identify and map the chain as evidence; do not forge or
predict tokens.

- **Fingerprint:** one request enters an HMAC/SHA-256 region two or more times;
  a 32-byte intermediate immediately becomes the next HMAC key; a 32-byte seed
  (a previous token) persists across requests.
- **Typical chain:** `device_secret = HMAC(master_key, device_fingerprint)` →
  `rolling_key = HMAC(device_secret, prev_token || counter || timestamp)` →
  `token = HMAC(rolling_key, body_digest || timestamp || nonce)`.
- **Map it:** from the outermost HMAC input, follow each key's source inward,
  labelling every layer's key provenance (constant, config, or derived from a
  prior request) down to the seed or master key. Verify end-to-end against a
  reference; a chain you cannot reproduce byte-for-byte stays a hypothesis.

## Protection detection (identify, then defer)

Recognize and report these; do not attempt defeat or automated recovery.

- **Code virtualization (VMP/Themida/Code Virtualizer/custom VM):** a dispatch
  loop, a handler table, and a bytecode/context structure appearing together.
  Report the fingerprint and stop; recovering the handler semantics or lifting
  the bytecode is out of scope here.
- **Control-flow obfuscation (OLLVM):** flattening (a dispatcher switching on a
  state variable), bogus control flow, instruction substitution. Report that
  the region is obfuscated and which pass is indicated.
- **White-box crypto:** large embedded lookup tables standing in for the key, no
  recognizable key schedule, primitive structure present but key material
  absent. Report as white-box and record the key recovery as out of scope.

## Delivery and discipline

Deliver the identification or reconstruction, the evidence anchors behind it,
the verification result (byte-exact, partial, or none), and the residual
unknowns. When three consecutive steps in one direction yield no progress,
switch signal or phase rather than repeating. Keep the investigation bounded to
the user's actual question; do not expand into protection defeat or unrequested
targets.
