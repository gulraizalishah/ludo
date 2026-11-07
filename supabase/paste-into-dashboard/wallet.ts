// ../../mnt/user-data/outputs/ludo/supabase/functions/_shared/util.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
var cors = {
  // Set the ALLOWED_ORIGIN secret (e.g. https://your-site.netlify.app) to accept requests from your site only.
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
var json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
var admin = () => createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
async function userFrom(req) {
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  if (!token) return null;
  const { data, error } = await admin().auth.getUser(token);
  return error || !data.user ? null : data.user;
}
var countryOf = (req) => (req.headers.get("cf-ipcountry") ?? "").toUpperCase();
async function geoBlocked(db, req) {
  const { data } = await db.from("app_settings").select("key,value").in("key", ["blocked_countries", "geo_strict"]);
  const s = {};
  for (const r of data ?? []) s[r.key] = r.value;
  const blocked = Array.isArray(s.blocked_countries) ? s.blocked_countries.map((c2) => String(c2).toUpperCase()) : [];
  const c = countryOf(req);
  if (c && blocked.includes(c)) return "This service is not available in your country.";
  if (!c && s.geo_strict === true) return "We could not determine your country, so this action is not available.";
  return null;
}

// ../../mnt/user-data/outputs/ludo/supabase/functions/_shared/tron.js
import { HDKey } from "npm:@scure/bip32@1.5.0";
import { secp256k1 } from "npm:@noble/curves@1.6.0/secp256k1";
import { keccak_256 } from "npm:@noble/hashes@1.5.0/sha3";
import { sha256 } from "npm:@noble/hashes@1.5.0/sha256";
import { base58check } from "npm:@scure/base@1.1.9";
var b58 = base58check(sha256);
var hex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));
function addressFromPublicKey(uncompressed65) {
  const raw = new Uint8Array(21);
  raw[0] = 65;
  raw.set(keccak_256(uncompressed65.slice(1)).slice(-20), 1);
  return b58.encode(raw);
}
var addressFromPrivateKey = (privHex) => addressFromPublicKey(secp256k1.getPublicKey(hex(privHex), false));
function deriveAddress(seedHex, index) {
  if (!/^[0-9a-f]{64}$/i.test(seedHex || "")) throw new Error("The HD_SEED secret is missing or is not 64 hex characters.");
  const child = HDKey.fromMasterSeed(hex(seedHex)).derive(`m/44'/195'/0'/0/${index}`);
  return addressFromPublicKey(secp256k1.ProjectivePoint.fromHex(child.publicKey).toRawBytes(false));
}
function parseDeposits(json2, address, contract, min = 1) {
  const out = [];
  for (const t of json2?.data ?? []) {
    if (t.type && t.type !== "Transfer") continue;
    if (t.to !== address || t.token_info?.address !== contract || !t.transaction_id) continue;
    if (Number(t.token_info.decimals ?? 6) !== 6) continue;
    let v;
    try {
      v = BigInt(t.value ?? "0");
    } catch {
      continue;
    }
    if (v < BigInt(Math.round(min * 1e6))) continue;
    out.push({ tx: t.transaction_id, amount: `${v / 1000000n}.${(v % 1000000n).toString().padStart(6, "0")}` });
  }
  return out;
}
function isValidTronAddress(addr) {
  try {
    const raw = b58.decode(String(addr));
    return raw.length === 21 && raw[0] === 65;
  } catch {
    return false;
  }
}
var toHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
function privateKeyFor(seedHex, index) {
  if (!/^[0-9a-f]{64}$/i.test(seedHex || "")) throw new Error("The HD_SEED secret is missing or is not 64 hex characters.");
  return toHex(HDKey.fromMasterSeed(hex(seedHex)).derive(`m/44'/195'/0'/0/${index}`).privateKey);
}
var hotWallet = (seedHex) => {
  const priv = privateKeyFor(seedHex, 0);
  return { priv, address: addressFromPrivateKey(priv) };
};
function transferCall(toAddress, amountMicro) {
  const to20 = toHex(b58.decode(toAddress).slice(1)).padStart(64, "0");
  const amount = BigInt(amountMicro).toString(16).padStart(64, "0");
  return { parameter: to20 + amount, data: "a9059cbb" + to20 + amount };
}
var toMicro = (amountStr) => {
  const [w, f = ""] = String(amountStr).split(".");
  return BigInt(w) * 1000000n + BigInt((f + "000000").slice(0, 6));
};
async function post(cfg, path, body, fetchFn = fetch) {
  const headers = { "Content-Type": "application/json", ...cfg.apiKey ? { "TRON-PRO-API-KEY": cfg.apiKey } : {} };
  const res = await fetchFn(cfg.api + path, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`TRON node answered ${res.status}`);
  return res.json();
}
async function buildSignedTransfer(cfg, { fromPriv, fromAddress, to, amountMicro }, fetchFn = fetch) {
  const { parameter, data } = transferCall(to, amountMicro);
  const res = await post(cfg, "/wallet/triggersmartcontract", {
    owner_address: fromAddress,
    contract_address: cfg.contract,
    function_selector: "transfer(address,uint256)",
    parameter,
    fee_limit: cfg.feeLimit,
    call_value: 0,
    visible: true
  }, fetchFn);
  const tx = res?.transaction;
  if (!res?.result?.result || !tx?.raw_data_hex || !tx?.txID) throw new Error("The node could not build the transfer.");
  const raw = tx.raw_data_hex.toLowerCase();
  const contractCalls = tx.raw_data?.contract ?? [];
  const ok = toHex(sha256(hex(raw))) === String(tx.txID).toLowerCase() && contractCalls.length === 1 && contractCalls[0].type === "TriggerSmartContract" && raw.includes(toHex(b58.decode(fromAddress))) && raw.includes(toHex(b58.decode(cfg.contract))) && raw.includes(data);
  if (!ok) throw new Error("Refusing to sign: the built transaction is not the transfer that was requested.");
  const sig = secp256k1.sign(hex(tx.txID), hex(fromPriv));
  const signature = sig.r.toString(16).padStart(64, "0") + sig.s.toString(16).padStart(64, "0") + sig.recovery.toString(16).padStart(2, "0");
  return { txid: String(tx.txID).toLowerCase(), signed: { ...tx, signature: [signature] } };
}
async function broadcast(cfg, signed, fetchFn = fetch) {
  const r = await post(cfg, "/wallet/broadcasttransaction", signed, fetchFn);
  return { accepted: r?.result === true || r?.code === "DUP_TRANSACTION_ERROR", detail: r };
}
async function txStatus(cfg, txid, fetchFn = fetch, plain = false) {
  const i = await post(cfg, "/wallet/gettransactioninfobyid", { value: txid }, fetchFn);
  if (!i || !i.id) return "unknown";
  if (plain && i.blockNumber !== void 0 && !i.receipt?.result && i.result !== "FAILED") return "success";
  if (i.receipt?.result === "SUCCESS") return "success";
  if (i.result === "FAILED" || i.receipt?.result && i.receipt.result !== "SUCCESS") return "failed";
  return "unknown";
}
async function balancesOf(cfg, address, fetchFn = fetch) {
  const res = await fetchFn(`${cfg.api}/v1/accounts/${address}`, { headers: cfg.apiKey ? { "TRON-PRO-API-KEY": cfg.apiKey } : {} });
  if (!res.ok) throw new Error(`TRON node answered ${res.status}`);
  const a = (await res.json())?.data?.[0];
  const usdt = (a?.trc20 ?? []).map((o) => o[cfg.contract]).find((v) => v !== void 0);
  return { trx: Number(a?.balance ?? 0) / 1e6, trxSun: BigInt(a?.balance ?? 0), usdt: Number(usdt ?? 0) / 1e6, usdtMicro: BigInt(usdt ?? "0") };
}
var varintHex = (n) => {
  let v = BigInt(n), out = "";
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 128;
    out += b.toString(16).padStart(2, "0");
  } while (v);
  return out;
};
async function buildSignedTrxTransfer(cfg, { fromPriv, fromAddress, to, amountSun }, fetchFn = fetch) {
  const tx = await post(cfg, "/wallet/createtransaction", { owner_address: fromAddress, to_address: to, amount: Number(amountSun), visible: true }, fetchFn);
  if (!tx?.raw_data_hex || !tx?.txID) throw new Error("The node could not build the TRX transfer.");
  const raw = tx.raw_data_hex.toLowerCase(), c = tx.raw_data?.contract ?? [];
  const expected = "0a15" + toHex(b58.decode(fromAddress)) + "1215" + toHex(b58.decode(to)) + "18" + varintHex(amountSun);
  if (toHex(sha256(hex(raw))) !== String(tx.txID).toLowerCase() || c.length !== 1 || c[0].type !== "TransferContract" || !raw.includes(expected)) {
    throw new Error("Refusing to sign: the built TRX transfer is not the one that was requested.");
  }
  const sig = secp256k1.sign(hex(tx.txID), hex(fromPriv));
  const signature = sig.r.toString(16).padStart(64, "0") + sig.s.toString(16).padStart(64, "0") + sig.recovery.toString(16).padStart(2, "0");
  return { txid: String(tx.txID).toLowerCase(), signed: { ...tx, signature: [signature] } };
}
function parseTrxDeposits(json2, address, min = 1, ignoreFrom = "") {
  const mine = toHex(b58.decode(address)), skip = ignoreFrom ? toHex(b58.decode(ignoreFrom)) : "";
  const norm = (a) => typeof a === "string" && a.startsWith("T") ? toHex(b58.decode(a)) : String(a ?? "").toLowerCase();
  const out = [];
  for (const t of json2?.data ?? []) {
    const c = t.raw_data?.contract?.[0], v = c?.parameter?.value;
    if (c?.type !== "TransferContract" || !t.txID || t.ret?.[0]?.contractRet !== "SUCCESS") continue;
    if (norm(v?.to_address) !== mine || skip && norm(v?.owner_address) === skip) continue;
    let sun;
    try {
      sun = BigInt(v.amount);
    } catch {
      continue;
    }
    if (sun < BigInt(Math.round(min * 1e6))) continue;
    out.push({ tx: t.txID, amount: `${sun / 1000000n}.${(sun % 1000000n).toString().padStart(6, "0")}` });
  }
  return out;
}

// ../../mnt/user-data/outputs/ludo/supabase/functions/_shared/payout.ts
var env = (k, d = "") => Deno.env.get(k) || d;
var chainCfg = () => ({
  api: env("TRON_API", "https://nile.trongrid.io"),
  apiKey: env("TRONGRID_API_KEY"),
  contract: env("USDT_CONTRACT", "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"),
  feeLimit: Number(env("FEE_LIMIT_SUN", "100000000"))
});
var hot = () => hotWallet(env("HD_SEED"));
var MIN_TRX_FOR_FEES = 30;
async function setting(db, key) {
  const { data } = await db.from("app_settings").select("value").eq("key", key).maybeSingle();
  return Number(data?.value ?? 0);
}
async function assetOf(db) {
  const { data } = await db.from("app_settings").select("value").eq("key", "asset").maybeSingle();
  return data?.value === "TRX" ? "TRX" : "USDT";
}
async function setNote(db, id, text) {
  try {
    await db.from("withdrawals").update({ note: text }).eq("id", id);
  } catch (_e) {
  }
}
async function tryPayout(db, w) {
  const { data: claimed } = await db.rpc("claim_withdrawal", { p_id: w.id });
  if (!claimed) return { status: "queued", reason: "busy" };
  let stored = false;
  try {
    const cfg = chainCfg(), h = hot(), amount = Number(w.amount), asset = await assetOf(db);
    const bal = await balancesOf(cfg, h.address);
    const short = asset === "TRX" ? bal.trx < amount + 1 : bal.usdt < amount || bal.trx < MIN_TRX_FOR_FEES;
    if (short) {
      await db.rpc("release_withdrawal", { p_id: w.id });
      await setNote(db, w.id, asset === "TRX" ? `Payout wallet is low: it holds ${bal.trx.toFixed(2)} TRX but needs ${amount} TRX plus about 1 TRX for the fee. Top it up, then press "Try automatic payout again".` : `Payout wallet is low: it holds ${bal.usdt.toFixed(2)} USDT and ${bal.trx.toFixed(1)} TRX, but needs ${amount} USDT and about ${MIN_TRX_FOR_FEES} TRX for fees. Top it up, then press "Try automatic payout again".`);
      return { status: "queued", reason: "wallet" };
    }
    const { txid, signed } = asset === "TRX" ? await buildSignedTrxTransfer(cfg, { fromPriv: h.priv, fromAddress: h.address, to: w.to_address, amountSun: toMicro(w.amount) }) : await buildSignedTransfer(cfg, { fromPriv: h.priv, fromAddress: h.address, to: w.to_address, amountMicro: toMicro(w.amount) });
    const saved = await db.rpc("set_withdrawal_tx", { p_id: w.id, p_tx: txid });
    if (saved.error) throw new Error("Could not record the transaction id: " + saved.error.message);
    stored = true;
    await broadcast(cfg, signed);
    await setNote(db, w.id, null);
    return { status: "processing" };
  } catch (e) {
    console.error("payout", w.id, String(e));
    if (!stored) {
      await db.rpc("release_withdrawal", { p_id: w.id });
      await setNote(db, w.id, "Automatic payout failed: " + String(e instanceof Error ? e.message : e).slice(0, 140));
    }
    return stored ? { status: "processing" } : { status: "queued", reason: "error" };
  }
}
async function confirmProcessing(db) {
  const { data } = await db.from("withdrawals").select("id,tx_hash,processing_at").eq("status", "processing").limit(50);
  const cfg = chainCfg();
  let done = 0;
  for (const w of data ?? []) {
    const age = Date.now() - new Date(w.processing_at).getTime();
    try {
      if (!w.tx_hash) {
        if (age > 5 * 6e4) await db.rpc("release_withdrawal", { p_id: w.id });
        continue;
      }
      const s = await txStatus(cfg, w.tx_hash, fetch, true);
      if (s === "success") {
        await db.rpc("mark_withdrawal_sent", { p_id: w.id, p_tx: w.tx_hash });
        done++;
      } else if (s === "failed") {
        await db.rpc("reject_withdrawal", { p_id: w.id });
        done++;
      } else if (age > 15 * 6e4) {
        await db.rpc("reject_withdrawal", { p_id: w.id });
        done++;
      }
    } catch (e) {
      console.error("confirm", w.id, String(e));
    }
  }
  return done;
}
async function hotStatus() {
  const cfg = chainCfg(), h = hot();
  try {
    const b = await balancesOf(cfg, h.address);
    return { address: h.address, trx: b.trx, usdt: b.usdt };
  } catch (e) {
    return { address: h.address, trx: null, usdt: null, error: String(e) };
  }
}

// ../../mnt/user-data/outputs/ludo/supabase/functions/_shared/alerts.ts
var env2 = (k) => Deno.env.get(k) || "";
async function notify(text) {
  const token = env2("TELEGRAM_BOT_TOKEN"), chat = env2("TELEGRAM_CHAT_ID");
  if (!token || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text }) });
    return r.ok;
  } catch {
    return false;
  }
}
async function once(db, topic, text, hours) {
  const key = "alert_" + topic;
  const { data } = await db.from("app_settings").select("value").eq("key", key).maybeSingle();
  if (data?.value && Date.now() - new Date(String(data.value)).getTime() < hours * 36e5) return false;
  if (!await notify(text)) return false;
  await db.from("app_settings").upsert({ key, value: (/* @__PURE__ */ new Date()).toISOString() }, { onConflict: "key" });
  return true;
}
async function runAlerts(db) {
  const sent = [];
  const { data: ov } = await db.from("admin_overview").select("*").maybeSingle();
  if (ov && (Number(ov.unaccounted) !== 0 || Number(ov.wallet_mismatches) !== 0)) {
    if (await once(db, "books", `ALERT: the books do not balance (unaccounted ${ov.unaccounted}, wallet mismatches ${ov.wallet_mismatches}). Open the admin page now.`, 3)) sent.push("books");
  }
  const asset = await assetOf(db), hot2 = await hotStatus(), min = await setting(db, "alert_hot_min") || 0, pending = Number(ov?.pending_amount ?? 0);
  const bal = asset === "TRX" ? hot2.trx : hot2.usdt;
  if (bal != null && bal < min + pending) {
    if (await once(db, "hot", `Payout wallet is low: ${Number(bal).toFixed(2)} ${asset} (withdrawals waiting: ${pending}). Top it up so payouts keep going.`, 6)) sent.push("hot");
  }
  const { data: old } = await db.from("withdrawals").select("id").eq("status", "pending").lt("created_at", new Date(Date.now() - 30 * 6e4).toISOString()).limit(1);
  if ((old ?? []).length && await once(db, "waiting", "A withdrawal has been waiting for your approval for over 30 minutes. Open the admin page.", 6)) sent.push("waiting");
  const { data: failed } = await db.from("sweeps").select("id").eq("status", "failed").gte("created_at", new Date(Date.now() - 36e5).toISOString()).limit(5);
  if ((failed ?? []).length >= 3 && await once(db, "sweeps", "Collecting deposits keeps failing (3+ failures in the last hour). Open the admin page.", 6)) sent.push("sweeps");
  if ((/* @__PURE__ */ new Date()).getUTCHours() === 6 && ov) {
    const text = `Daily summary: books ${Number(ov.unaccounted) === 0 && Number(ov.wallet_mismatches) === 0 ? "balance" : "DO NOT BALANCE"}. Deposited in total ${Number(ov.deposits_total).toFixed(2)} ${asset}, paid out ${Number(ov.paid_out_total).toFixed(2)}, your fees ${Number(ov.platform_fees).toFixed(2)}, matches running ${ov.active_matches}, withdrawals waiting ${ov.pending_count}.`;
    if (await once(db, "daily", text, 20)) sent.push("daily");
  }
  return sent;
}

// ../../mnt/user-data/outputs/ludo/supabase/functions/_shared/sweep.ts
var env3 = (k, d) => Deno.env.get(k) || d;
var MIN_USDT = () => Number(env3("SWEEP_MIN_USDT", "1"));
var MIN_TRX = () => Number(env3("SWEEP_MIN_TRX", "15"));
var TOPUP_TRX = () => Number(env3("SWEEP_TOPUP_TRX", "25"));
var HOT_KEEP_TRX = 30;
var must = (r, what) => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};
async function confirmSweeps(db, address) {
  let q = db.from("sweeps").select("id,kind,tx_hash,created_at").eq("status", "sent");
  if (address) q = q.eq("address", address);
  const { data } = await q.limit(100);
  const cfg = chainCfg();
  for (const s of data ?? []) {
    try {
      const age = Date.now() - new Date(s.created_at).getTime();
      const st = s.tx_hash ? await txStatus(cfg, s.tx_hash, fetch, true) : "failed";
      if (st === "success") await db.from("sweeps").update({ status: "confirmed" }).eq("id", s.id);
      else if (st === "failed" || age > 15 * 6e4) await db.from("sweeps").update({ status: "failed" }).eq("id", s.id);
    } catch (e) {
      console.error("confirmSweeps", s.id, String(e));
    }
  }
}
async function sweepAddress(db, c) {
  const cfg = chainCfg(), h = hot();
  await confirmSweeps(db, c.address);
  const open = must(await db.from("sweeps").select("id").eq("address", c.address).eq("status", "sent"), "Cannot read the sweeps table (was migration 8 run?)");
  if ((open ?? []).length) return "waiting";
  const since = new Date(Date.now() - 36e5).toISOString();
  const { data: failed } = await db.from("sweeps").select("id").eq("address", c.address).eq("status", "failed").gte("created_at", since);
  if ((failed ?? []).length >= 3) return "paused";
  const bal = await balancesOf(cfg, c.address), asset = await assetOf(db);
  if (asset === "TRX") {
    const min = await setting(db, "sweep_min") || 5, keep = 1000000n;
    if (bal.trx < min) {
      must(await db.from("sweeps").insert({ user_id: c.user_id, address: c.address, kind: "check", status: "empty", amount: bal.trx }), "Cannot record the sweep");
      return "empty";
    }
    const key = privateKeyFor(Deno.env.get("HD_SEED") ?? "", c.derivation_index);
    if (addressFromPrivateKey(key) !== c.address) throw new Error("The derived key does not match this deposit address.");
    const sun = bal.trxSun - keep;
    const { txid: txid2, signed: signed2 } = await buildSignedTrxTransfer(cfg, { fromPriv: key, fromAddress: c.address, to: h.address, amountSun: sun });
    must(await db.from("sweeps").insert({ user_id: c.user_id, address: c.address, kind: "sweep", status: "sent", amount: Number(sun) / 1e6, tx_hash: txid2 }), "Cannot record the sweep");
    await broadcast(cfg, signed2);
    return "sweeping";
  }
  if (bal.usdtMicro < toMicro(String(MIN_USDT()))) {
    must(await db.from("sweeps").insert({ user_id: c.user_id, address: c.address, kind: "check", status: "empty", amount: bal.usdt }), "Cannot record the sweep");
    return "empty";
  }
  if (bal.trx < MIN_TRX()) {
    const hb = await balancesOf(cfg, h.address);
    if (hb.trx < TOPUP_TRX() + HOT_KEEP_TRX) return "hot_low";
    const { txid: txid2, signed: signed2 } = await buildSignedTrxTransfer(cfg, { fromPriv: h.priv, fromAddress: h.address, to: c.address, amountSun: BigInt(Math.round(TOPUP_TRX() * 1e6)) });
    must(await db.from("sweeps").insert({ user_id: c.user_id, address: c.address, kind: "topup", status: "sent", amount: TOPUP_TRX(), tx_hash: txid2 }), "Cannot record the sweep");
    await broadcast(cfg, signed2);
    return "funding";
  }
  const priv = privateKeyFor(Deno.env.get("HD_SEED") ?? "", c.derivation_index);
  if (addressFromPrivateKey(priv) !== c.address) throw new Error("The derived key does not match this deposit address.");
  const feeLimit = Math.min(cfg.feeLimit, Math.floor((bal.trx - 1) * 1e6));
  const { txid, signed } = await buildSignedTransfer({ ...cfg, feeLimit }, { fromPriv: priv, fromAddress: c.address, to: h.address, amountMicro: bal.usdtMicro });
  must(await db.from("sweeps").insert({ user_id: c.user_id, address: c.address, kind: "sweep", status: "sent", amount: bal.usdt, tx_hash: txid }), "Cannot record the sweep");
  await broadcast(cfg, signed);
  return "sweeping";
}
async function sweepAll(db, limit = 10) {
  await confirmSweeps(db);
  const { data } = await db.rpc("sweep_candidates", { p_limit: limit });
  const summary = {};
  for (const c of data ?? []) {
    let r = "error";
    try {
      r = await sweepAddress(db, c);
    } catch (e) {
      console.error("sweep", c.address, String(e));
      summary.errors = [...summary.errors ?? [], String(e instanceof Error ? e.message : e).slice(0, 160)];
    }
    summary[r] = (summary[r] ?? 0) + 1;
  }
  return summary;
}

// ../../mnt/user-data/outputs/ludo/supabase/functions/wallet/index.ts
var env4 = (k, d = "") => Deno.env.get(k) || d;
var API = () => env4("TRON_API", "https://nile.trongrid.io");
var USDT = () => env4("USDT_CONTRACT", "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf");
var NETWORK = () => API().includes("nile") ? "nile" : API().includes("shasta") ? "shasta" : "mainnet";
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const { action } = body;
    const db = admin();
    if (action === "scan_all") {
      const secret = env4("CRON_SECRET");
      if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "forbidden" }, 403);
      const { data } = await db.from("deposit_addresses").select("user_id,address").not("address", "like", "pending-%").limit(100);
      let credited = 0;
      for (const r of data ?? []) {
        try {
          credited += (await scan(db, r.user_id, r.address)).length;
        } catch (e) {
          console.error(r.user_id, String(e));
        }
        await new Promise((ok) => setTimeout(ok, 400));
      }
      const confirmed = await confirmProcessing(db);
      const swept = await sweepAll(db, 10).catch((e) => ({ error: String(e) }));
      const alerts = await runAlerts(db).catch((e) => {
        console.error("alerts", String(e));
        return [];
      });
      await db.from("app_settings").upsert({ key: "last_scan_at", value: (/* @__PURE__ */ new Date()).toISOString() }, { onConflict: "key" });
      return json({ ok: true, scanned: data?.length ?? 0, credited, confirmed, swept, alerts });
    }
    const user = await userFrom(req);
    if (!user) return json({ error: "Please log in first." }, 401);
    if (action === "withdraw") {
      const amount = Number(body.amount), to = String(body.to ?? "").trim();
      if (!(amount > 0)) return json({ error: "Enter an amount." }, 400);
      if (!isValidTronAddress(to)) return json({ error: "That is not a valid TRON (TRC20) address. Check it and try again." }, 400);
      const { count } = await db.from("withdrawals").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "pending");
      if ((count ?? 0) >= 3) return json({ error: "You already have 3 withdrawals waiting. Please wait for them to be processed." }, 400);
      const { data, error } = await db.rpc("request_withdrawal", { p_user: user.id, p_amount: amount.toFixed(6), p_address: to });
      if (error) return json({ error: /violates check|wallets/i.test(error.message) ? "Not enough available balance." : error.message }, 400);
      const max = await setting(db, "auto_withdraw_max"), dailyMax = await setting(db, "auto_withdraw_daily_max");
      const since = new Date(Date.now() - 24 * 36e5).toISOString();
      const { data: recent } = await db.from("withdrawals").select("amount").eq("user_id", user.id).neq("status", "rejected").gte("created_at", since);
      const day = (recent ?? []).reduce((s, r) => s + Number(r.amount), 0);
      const { data: fm } = await db.from("app_settings").select("value").eq("key", "first_withdrawal_manual").maybeSingle();
      const { count: sentBefore } = await db.from("withdrawals").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "sent");
      const review = fm?.value === true && !(sentBefore && sentBefore > 0);
      let result = { status: "queued", reason: review ? "review" : "limit" };
      if (review) await setNote(db, data, "First withdrawal of this account: needs your approval.");
      else if (amount <= max && day <= dailyMax && env4("HD_SEED")) result = await tryPayout(db, { id: data, amount: amount.toFixed(6), to_address: to });
      else await setNote(db, data, !env4("HD_SEED") ? "Automatic payouts are not set up (the HD_SEED secret is missing)." : amount > max ? `Over the automatic limit of ${max} USDT per withdrawal.` : `This player passed the automatic limit of ${dailyMax} USDT in 24 hours.`);
      return json({ ok: true, id: data, status: result.status, reason: result.reason });
    }
    if (["limits_get", "limits_set", "exclude", "accept_terms"].includes(action)) {
      const fail = (m) => json({ error: m }, 400);
      if (action === "accept_terms") {
        const { error } = await db.rpc("accept_terms", { p_user: user.id });
        if (error) return fail(error.message);
      }
      if (action === "limits_set") {
        const lim = body.limit === null || body.limit === "" ? null : Number(body.limit);
        if (lim !== null && !(lim > 0)) return fail("Enter an amount above zero.");
        const { error } = await db.rpc("set_stake_limit", { p_user: user.id, p_limit: lim });
        if (error) return fail(error.message);
      }
      if (action === "exclude") {
        const { error } = await db.rpc("self_exclude", { p_user: user.id, p_days: Number(body.days) });
        if (error) return fail(error.message);
      }
      const { data: p } = await db.from("profiles").select("age_confirmed_at,terms_accepted_at,limit_stake_daily,limit_pending,limit_pending_at,excluded_until").eq("id", user.id).maybeSingle();
      const { data: staked } = await db.from("match_players").select("stake_locked").eq("user_id", user.id).gte("joined_at", new Date(Date.now() - 24 * 36e5).toISOString());
      return json({
        ok: true,
        accepted: !!(p?.age_confirmed_at && p?.terms_accepted_at),
        limit: p?.limit_stake_daily ?? null,
        pending: p?.limit_pending ?? null,
        pending_at: p?.limit_pending_at ?? null,
        excluded_until: p?.excluded_until ?? null,
        staked_24h: (staked ?? []).reduce((s, r) => s + Number(r.stake_locked), 0)
      });
    }
    if (action === "address" || action === "check") {
      const g = await geoBlocked(db, req);
      if (g) return json({ error: g }, 403);
    }
    if (action === "check") await confirmProcessing(db);
    const address = await addressFor(db, user.id);
    if (action === "address") return json({ address, network: NETWORK(), contract: USDT(), asset: await assetOf(db), min: await setting(db, "min_deposit") || 1 });
    if (action === "check") {
      const credited = await scan(db, user.id, address);
      let collecting = null, collectingError = null;
      try {
        const { data: cands } = await db.rpc("sweep_candidates", { p_limit: 200 });
        const mine = (cands ?? []).find((c) => c.user_id === user.id);
        if (mine) collecting = await sweepAddress(db, mine);
      } catch (e) {
        collectingError = String(e instanceof Error ? e.message : e).slice(0, 200);
        console.error("collect after check", collectingError);
      }
      return json({ credited, network: NETWORK(), collecting, collectingError });
    }
    return json({ error: "bad action" }, 400);
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
async function addressFor(db, uid) {
  const { data } = await db.from("deposit_addresses").select("address,derivation_index").eq("user_id", uid).maybeSingle();
  let index = data?.derivation_index;
  if (data && !String(data.address).startsWith("pending-")) return data.address;
  if (!data) {
    const ins = await db.from("deposit_addresses").insert({ user_id: uid, address: "pending-" + crypto.randomUUID() }).select("derivation_index").single();
    if (ins.error) {
      const again = await db.from("deposit_addresses").select("address,derivation_index").eq("user_id", uid).maybeSingle();
      if (!again.data) throw new Error(ins.error.message);
      if (!String(again.data.address).startsWith("pending-")) return again.data.address;
      index = again.data.derivation_index;
    } else index = ins.data.derivation_index;
  }
  const address = deriveAddress(env4("HD_SEED"), index);
  await db.from("deposit_addresses").update({ address }).eq("user_id", uid);
  return address;
}
async function scan(db, uid, address) {
  const asset = await assetOf(db), min = await setting(db, "min_deposit") || 1;
  const url = asset === "TRX" ? `${API()}/v1/accounts/${address}/transactions?only_confirmed=true&only_to=true&limit=200` : `${API()}/v1/accounts/${address}/transactions/trc20?only_confirmed=true&only_to=true&limit=200&contract_address=${USDT()}`;
  const headers = {};
  if (env4("TRONGRID_API_KEY")) headers["TRON-PRO-API-KEY"] = env4("TRONGRID_API_KEY");
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`TronGrid answered ${res.status}`);
  const found = asset === "TRX" ? parseTrxDeposits(await res.json(), address, min, hot().address) : parseDeposits(await res.json(), address, USDT(), min);
  const credited = [];
  for (const d of found) {
    const { data, error } = await db.rpc("credit_deposit", { p_user: uid, p_tx: d.tx, p_amount: d.amount });
    if (error) throw new Error(error.message);
    if (data === true) credited.push(d);
  }
  return credited;
}
