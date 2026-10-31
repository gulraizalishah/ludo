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
async function txStatus(cfg, txid, fetchFn = fetch) {
  const i = await post(cfg, "/wallet/gettransactioninfobyid", { value: txid }, fetchFn);
  if (!i || !i.id) return "unknown";
  if (i.receipt?.result === "SUCCESS") return "success";
  if (i.result === "FAILED" || i.receipt?.result && i.receipt.result !== "SUCCESS") return "failed";
  return "unknown";
}
async function balancesOf(cfg, address, fetchFn = fetch) {
  const res = await fetchFn(`${cfg.api}/v1/accounts/${address}`, { headers: cfg.apiKey ? { "TRON-PRO-API-KEY": cfg.apiKey } : {} });
  if (!res.ok) throw new Error(`TRON node answered ${res.status}`);
  const a = (await res.json())?.data?.[0];
  const usdt = (a?.trc20 ?? []).map((o) => o[cfg.contract]).find((v) => v !== void 0);
  return { trx: Number(a?.balance ?? 0) / 1e6, usdt: Number(usdt ?? 0) / 1e6 };
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
    const cfg = chainCfg(), h = hot(), amount = Number(w.amount);
    const bal = await balancesOf(cfg, h.address);
    if (bal.usdt < amount || bal.trx < MIN_TRX_FOR_FEES) {
      await db.rpc("release_withdrawal", { p_id: w.id });
      await setNote(db, w.id, `Payout wallet is low: it holds ${bal.usdt.toFixed(2)} USDT and ${bal.trx.toFixed(1)} TRX, but needs ${amount} USDT and about ${MIN_TRX_FOR_FEES} TRX for fees. Top it up, then press "Try automatic payout again".`);
      return { status: "queued", reason: "wallet" };
    }
    const { txid, signed } = await buildSignedTransfer(cfg, { fromPriv: h.priv, fromAddress: h.address, to: w.to_address, amountMicro: toMicro(w.amount) });
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
      const s = await txStatus(cfg, w.tx_hash);
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
    return { address: h.address, ...await balancesOf(cfg, h.address) };
  } catch (e) {
    return { address: h.address, trx: null, usdt: null, error: String(e) };
  }
}

// ../../mnt/user-data/outputs/ludo/supabase/functions/admin/index.ts
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const user = await userFrom(req);
    if (!user) return json({ error: "Please log in first." }, 401);
    const db = admin();
    const { data: me } = await db.from("profiles").select("is_admin").eq("id", user.id).maybeSingle();
    if (!me?.is_admin) return json({ error: "Admins only." }, 403);
    const body = await req.json().catch(() => ({}));
    if (body.action === "overview") {
      await confirmProcessing(db).catch(() => 0);
      const { data, error } = await db.from("admin_overview").select("*").single();
      if (error) return json({ error: error.message }, 500);
      let hot2 = null;
      try {
        hot2 = await hotStatus();
      } catch (e) {
        hot2 = { error: String(e instanceof Error ? e.message : e) };
      }
      const api = chainCfg().api, network = api.includes("nile") ? "nile" : api.includes("shasta") ? "shasta" : "mainnet";
      return json({ overview: data, hot: hot2, network });
    }
    if (body.action === "pending" || body.action === "recent") {
      const pending = body.action === "pending";
      let q = db.from("withdrawals").select("id,user_id,amount,to_address,status,tx_hash,note,created_at,processed_at");
      q = pending ? q.in("status", ["pending", "processing"]).order("created_at", { ascending: true }) : q.in("status", ["sent", "rejected"]).order("processed_at", { ascending: false });
      const { data } = await q.limit(pending ? 50 : 15);
      const rows = [];
      for (const w of data ?? []) {
        const { data: u } = await db.auth.admin.getUserById(w.user_id);
        const { data: p } = await db.from("profiles").select("username").eq("id", w.user_id).maybeSingle();
        rows.push({ ...w, email: u?.user?.email ?? "?", username: p?.username ?? null });
      }
      return json({ rows });
    }
    if (body.action === "transactions") {
      const groups = {
        deposits: ["deposit"],
        withdrawals: ["withdrawal_request", "withdrawal_refund"],
        matches: ["stake_lock", "stake_refund", "match_win", "match_loss", "platform_fee"],
        earnings: ["platform_payout"]
      };
      let q = db.from("ledger").select("id,user_id,kind,d_available,d_locked,created_at,ref").order("created_at", { ascending: false });
      if (groups[body.filter]) q = q.in("kind", groups[body.filter]);
      const { data } = await q.limit(100);
      const names = {};
      for (const r of data ?? []) {
        if (!r.user_id || names[r.user_id]) continue;
        const { data: u } = await db.auth.admin.getUserById(r.user_id);
        const { data: p } = await db.from("profiles").select("username").eq("id", r.user_id).maybeSingle();
        names[r.user_id] = p?.username || u?.user?.email || "?";
      }
      const ids = (data ?? []).filter((r) => r.kind === "withdrawal_request" && r.ref).map((r) => r.ref);
      const wd = {};
      if (ids.length) {
        const { data: ws } = await db.from("withdrawals").select("id,status,to_address,tx_hash,note").in("id", ids);
        for (const x of ws ?? []) wd[x.id] = x;
      }
      return json({ rows: (data ?? []).map((r) => ({ ...r, who: r.user_id ? names[r.user_id] : "Platform", withdrawal: r.ref ? wd[r.ref] ?? null : null })) });
    }
    if (["sent", "reject", "retry"].includes(body.action)) {
      const { data: w } = await db.from("withdrawals").select("id,amount,to_address,status").eq("id", body.id).maybeSingle();
      if (!w) return json({ error: "Withdrawal not found." }, 404);
      if (w.status !== "pending") return json({ error: w.status === "processing" ? "This one is already being sent automatically. Wait for the network to confirm it." : "This withdrawal is already finished." }, 400);
      if (body.action === "retry") return json({ ok: true, ...await tryPayout(db, w) });
      if (body.action === "reject") {
        const { error: error2 } = await db.rpc("reject_withdrawal", { p_id: w.id });
        return error2 ? json({ error: error2.message }, 400) : json({ ok: true });
      }
      const tx = String(body.tx ?? "").trim();
      if (!/^[0-9a-fA-F]{64}$/.test(tx)) return json({ error: "That does not look like a transaction id (64 letters and numbers)." }, 400);
      const seen = await txStatus(chainCfg(), tx).catch(() => "unknown");
      if (seen !== "success") return json({ error: "The network does not show this transaction as successful. Check the id (it is not the wallet address), or wait a minute after sending." }, 400);
      const { error } = await db.rpc("mark_withdrawal_sent", { p_id: w.id, p_tx: tx });
      return error ? json({ error: error.message }, 400) : json({ ok: true });
    }
    if (body.action === "move_earnings") {
      const amount = Number(body.amount);
      if (!(amount > 0)) return json({ error: "Enter an amount." }, 400);
      const { error } = await db.rpc("platform_payout", { p_admin: user.id, p_amount: amount.toFixed(6) });
      return error ? json({ error: error.message }, 400) : json({ ok: true });
    }
    return json({ error: "bad action" }, 400);
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
