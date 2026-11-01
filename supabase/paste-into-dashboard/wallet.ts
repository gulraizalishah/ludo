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
    await db.rpc("set_withdrawal_tx", { p_id: w.id, p_tx: txid });
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

// ../../mnt/user-data/outputs/ludo/supabase/functions/_shared/sweep.ts
var env2 = (k, d) => Deno.env.get(k) || d;
var MIN_USDT = () => Number(env2("SWEEP_MIN_USDT", "1"));
var MIN_TRX = () => Number(env2("SWEEP_MIN_TRX", "15"));
var TOPUP_TRX = () => Number(env2("SWEEP_TOPUP_TRX", "25"));
var HOT_KEEP_TRX = 30;
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
  const { data: open } = await db.from("sweeps").select("id").eq("address", c.address).eq("status", "sent");
  if ((open ?? []).length) return "waiting";
  const since = new Date(Date.now() - 36e5).toISOString();
  const { data: failed } = await db.from("sweeps").select("id").eq("address", c.address).eq("status", "failed").gte("created_at", since);
  if ((failed ?? []).length >= 3) return "paused";
  const bal = await balancesOf(cfg, c.address), asset = await assetOf(db);
  if (asset === "TRX") {
    const min = await setting(db, "sweep_min") || 5, keep = 1000000n;
    if (bal.trx < min) {
      await db.from("sweeps").insert({ user_id: c.user_id, address: c.address, kind: "check", status: "empty", amount: bal.trx });
      return "empty";
    }
    const key = privateKeyFor(Deno.env.get("HD_SEED") ?? "", c.derivation_index);
    if (addressFromPrivateKey(key) !== c.address) throw new Error("The derived key does not match this deposit address.");
    const sun = bal.trxSun - keep;
    const { txid: txid2, signed: signed2 } = await buildSignedTrxTransfer(cfg, { fromPriv: key, fromAddress: c.address, to: h.address, amountSun: sun });
    await db.from("sweeps").insert({ user_id: c.user_id, address: c.address, kind: "sweep", status: "sent", amount: Number(sun) / 1e6, tx_hash: txid2 });
    await broadcast(cfg, signed2);
    return "sweeping";
  }
  if (bal.usdtMicro < toMicro(String(MIN_USDT()))) {
    await db.from("sweeps").insert({ user_id: c.user_id, address: c.address, kind: "check", status: "empty", amount: bal.usdt });
    return "empty";
  }
  if (bal.trx < MIN_TRX()) {
    const hb = await balancesOf(cfg, h.address);
    if (hb.trx < TOPUP_TRX() + HOT_KEEP_TRX) return "hot_low";
    const { txid: txid2, signed: signed2 } = await buildSignedTrxTransfer(cfg, { fromPriv: h.priv, fromAddress: h.address, to: c.address, amountSun: BigInt(Math.round(TOPUP_TRX() * 1e6)) });
    await db.from("sweeps").insert({ user_id: c.user_id, address: c.address, kind: "topup", status: "sent", amount: TOPUP_TRX(), tx_hash: txid2 });
    await broadcast(cfg, signed2);
    return "funding";
  }
  const priv = privateKeyFor(Deno.env.get("HD_SEED") ?? "", c.derivation_index);
  if (addressFromPrivateKey(priv) !== c.address) throw new Error("The derived key does not match this deposit address.");
  const feeLimit = Math.min(cfg.feeLimit, Math.floor((bal.trx - 1) * 1e6));
  const { txid, signed } = await buildSignedTransfer({ ...cfg, feeLimit }, { fromPriv: priv, fromAddress: c.address, to: h.address, amountMicro: bal.usdtMicro });
  await db.from("sweeps").insert({ user_id: c.user_id, address: c.address, kind: "sweep", status: "sent", amount: bal.usdt, tx_hash: txid });
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
    }
    summary[r] = (summary[r] ?? 0) + 1;
  }
  return summary;
}

// ../../mnt/user-data/outputs/ludo/supabase/functions/wallet/index.ts
var env3 = (k, d = "") => Deno.env.get(k) || d;
var API = () => env3("TRON_API", "https://nile.trongrid.io");
var USDT = () => env3("USDT_CONTRACT", "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf");
var NETWORK = () => API().includes("nile") ? "nile" : API().includes("shasta") ? "shasta" : "mainnet";
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const { action } = body;
    const db = admin();
    if (action === "scan_all") {
      const secret = env3("CRON_SECRET");
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
      return json({ ok: true, scanned: data?.length ?? 0, credited, confirmed, swept });
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
      let result = { status: "queued", reason: "limit" };
      if (amount <= max && day <= dailyMax && env3("HD_SEED")) result = await tryPayout(db, { id: data, amount: amount.toFixed(6), to_address: to });
      else await setNote(db, data, !env3("HD_SEED") ? "Automatic payouts are not set up (the HD_SEED secret is missing)." : amount > max ? `Over the automatic limit of ${max} USDT per withdrawal.` : `This player passed the automatic limit of ${dailyMax} USDT in 24 hours.`);
      return json({ ok: true, id: data, status: result.status, reason: result.reason });
    }
    if (action === "check") await confirmProcessing(db);
    const address = await addressFor(db, user.id);
    if (action === "address") return json({ address, network: NETWORK(), contract: USDT(), asset: await assetOf(db), min: await setting(db, "min_deposit") || 1 });
    if (action === "check") {
      const credited = await scan(db, user.id, address);
      let collecting = null;
      if (credited.length) {
        try {
          const { data: a } = await db.from("deposit_addresses").select("user_id,address,derivation_index").eq("user_id", user.id).maybeSingle();
          if (a) collecting = await sweepAddress(db, a);
        } catch (e) {
          console.error("sweep after check", String(e));
        }
      }
      return json({ credited, network: NETWORK(), collecting });
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
  const address = deriveAddress(env3("HD_SEED"), index);
  await db.from("deposit_addresses").update({ address }).eq("user_id", uid);
  return address;
}
async function scan(db, uid, address) {
  const asset = await assetOf(db), min = await setting(db, "min_deposit") || 1;
  const url = asset === "TRX" ? `${API()}/v1/accounts/${address}/transactions?only_confirmed=true&only_to=true&limit=200` : `${API()}/v1/accounts/${address}/transactions/trc20?only_confirmed=true&only_to=true&limit=200&contract_address=${USDT()}`;
  const headers = {};
  if (env3("TRONGRID_API_KEY")) headers["TRON-PRO-API-KEY"] = env3("TRONGRID_API_KEY");
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
