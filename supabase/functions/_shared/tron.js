// TRON helpers: per-player deposit addresses (HD wallet) and reading USDT (TRC20) deposits from TronGrid.
// Only PUBLIC addresses are ever produced here. The seed (HD_SEED secret) stays on the server.
import { HDKey } from 'npm:@scure/bip32@1.5.0';
import { secp256k1 } from 'npm:@noble/curves@1.6.0/secp256k1';
import { keccak_256 } from 'npm:@noble/hashes@1.5.0/sha3';
import { sha256 } from 'npm:@noble/hashes@1.5.0/sha256';
import { base58check } from 'npm:@scure/base@1.1.9';

const b58 = base58check(sha256);
const hex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));

// TRON address = base58check( 0x41 + last 20 bytes of keccak256(uncompressed public key without its 0x04 prefix) )
export function addressFromPublicKey(uncompressed65) {
  const raw = new Uint8Array(21);
  raw[0] = 0x41;
  raw.set(keccak_256(uncompressed65.slice(1)).slice(-20), 1);
  return b58.encode(raw);
}
export const addressFromPrivateKey = (privHex) => addressFromPublicKey(secp256k1.getPublicKey(hex(privHex), false));

// Address number `index` of the wallet made from the secret seed (path m/44'/195'/0'/0/index, TRON's standard).
export function deriveAddress(seedHex, index) {
  if (!/^[0-9a-f]{64}$/i.test(seedHex || '')) throw new Error('The HD_SEED secret is missing or is not 64 hex characters.');
  const child = HDKey.fromMasterSeed(hex(seedHex)).derive(`m/44'/195'/0'/0/${index}`);
  return addressFromPublicKey(secp256k1.ProjectivePoint.fromHex(child.publicKey).toRawBytes(false));
}

// Turn a TronGrid "TRC20 transactions of an address" reply into credit-able deposits.
// Only real USDT transfers INTO this address, 6 decimals, at least `min` USDT. Fake tokens are ignored by contract address.
export function parseDeposits(json, address, contract, min = 1) {
  const out = [];
  for (const t of json?.data ?? []) {
    if (t.type && t.type !== 'Transfer') continue;
    if (t.to !== address || t.token_info?.address !== contract || !t.transaction_id) continue;
    if (Number(t.token_info.decimals ?? 6) !== 6) continue;
    let v; try { v = BigInt(t.value ?? '0'); } catch { continue; }
    if (v < BigInt(Math.round(min * 1e6))) continue;
    out.push({ tx: t.transaction_id, amount: `${v / 1000000n}.${(v % 1000000n).toString().padStart(6, '0')}` });
  }
  return out;
}

// True only for a real TRON address (T..., correct checksum). Used before any payout, so a typo can never send money away.
export function isValidTronAddress(addr) {
  try { const raw = b58.decode(String(addr)); return raw.length === 21 && raw[0] === 0x41; } catch { return false; }
}

// ---------------------------------------------------------------------------------------------------------
// Sending USDT (TRC20) from the platform's hot wallet. The hot wallet is address number 0 of the same seed
// (players' deposit addresses start at 1). Safety rules: we check what the node built BEFORE signing, and the
// transaction id is known before broadcasting, so a lost reply can be traced.
const toHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

export function privateKeyFor(seedHex, index) {
  if (!/^[0-9a-f]{64}$/i.test(seedHex || '')) throw new Error('The HD_SEED secret is missing or is not 64 hex characters.');
  return toHex(HDKey.fromMasterSeed(hex(seedHex)).derive(`m/44'/195'/0'/0/${index}`).privateKey);
}
export const hotWallet = (seedHex) => { const priv = privateKeyFor(seedHex, 0); return { priv, address: addressFromPrivateKey(priv) }; };

// ABI call data for transfer(address,uint256)
export function transferCall(toAddress, amountMicro) {
  const to20 = toHex(b58.decode(toAddress).slice(1)).padStart(64, '0');
  const amount = BigInt(amountMicro).toString(16).padStart(64, '0');
  return { parameter: to20 + amount, data: 'a9059cbb' + to20 + amount };
}
export const toMicro = (amountStr) => { const [w, f = ''] = String(amountStr).split('.'); return BigInt(w) * 1000000n + BigInt((f + '000000').slice(0, 6)); };

async function post(cfg, path, body, fetchFn = fetch) {
  const headers = { 'Content-Type': 'application/json', ...(cfg.apiKey ? { 'TRON-PRO-API-KEY': cfg.apiKey } : {}) };
  const res = await fetchFn(cfg.api + path, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`TRON node answered ${res.status}`);
  return res.json();
}

// Ask the node to build the transfer, CHECK it really is the transfer we asked for, then sign it. Nothing is sent yet.
export async function buildSignedTransfer(cfg, { fromPriv, fromAddress, to, amountMicro }, fetchFn = fetch) {
  const { parameter, data } = transferCall(to, amountMicro);
  const res = await post(cfg, '/wallet/triggersmartcontract', {
    owner_address: fromAddress, contract_address: cfg.contract, function_selector: 'transfer(address,uint256)',
    parameter, fee_limit: cfg.feeLimit, call_value: 0, visible: true,
  }, fetchFn);
  const tx = res?.transaction;
  if (!res?.result?.result || !tx?.raw_data_hex || !tx?.txID) throw new Error('The node could not build the transfer.');
  const raw = tx.raw_data_hex.toLowerCase();
  const contractCalls = tx.raw_data?.contract ?? [];
  const ok = toHex(sha256(hex(raw))) === String(tx.txID).toLowerCase()                       // id really belongs to these bytes
    && contractCalls.length === 1 && contractCalls[0].type === 'TriggerSmartContract'
    && raw.includes(toHex(b58.decode(fromAddress))) && raw.includes(toHex(b58.decode(cfg.contract))) && raw.includes(data);
  if (!ok) throw new Error('Refusing to sign: the built transaction is not the transfer that was requested.');
  const sig = secp256k1.sign(hex(tx.txID), hex(fromPriv));
  const signature = sig.r.toString(16).padStart(64, '0') + sig.s.toString(16).padStart(64, '0') + sig.recovery.toString(16).padStart(2, '0');
  return { txid: String(tx.txID).toLowerCase(), signed: { ...tx, signature: [signature] } };
}
export async function broadcast(cfg, signed, fetchFn = fetch) {
  const r = await post(cfg, '/wallet/broadcasttransaction', signed, fetchFn);
  return { accepted: r?.result === true || r?.code === 'DUP_TRANSACTION_ERROR', detail: r };
}
// 'success' | 'failed' | 'unknown' (not on the chain yet)
export async function txStatus(cfg, txid, fetchFn = fetch) {
  const i = await post(cfg, '/wallet/gettransactioninfobyid', { value: txid }, fetchFn);
  if (!i || !i.id) return 'unknown';
  if (i.receipt?.result === 'SUCCESS') return 'success';
  if (i.result === 'FAILED' || (i.receipt?.result && i.receipt.result !== 'SUCCESS')) return 'failed';
  return 'unknown';
}
// TRX (in TRX) and USDT balances of an address
export async function balancesOf(cfg, address, fetchFn = fetch) {
  const res = await fetchFn(`${cfg.api}/v1/accounts/${address}`, { headers: cfg.apiKey ? { 'TRON-PRO-API-KEY': cfg.apiKey } : {} });
  if (!res.ok) throw new Error(`TRON node answered ${res.status}`);
  const a = (await res.json())?.data?.[0];
  const usdt = (a?.trc20 ?? []).map((o) => o[cfg.contract]).find((v) => v !== undefined);
  return { trx: Number(a?.balance ?? 0) / 1e6, usdt: Number(usdt ?? 0) / 1e6 };
}
