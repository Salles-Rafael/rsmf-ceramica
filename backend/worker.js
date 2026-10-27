const PAGBANK_API = "https://sandbox.api.pagseguro.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=UTF-8", ...corsHeaders } });
}
function digits(value) { return String(value || "").replace(/\D/g, ""); }
function safeText(value, max = 255) { return String(value || "").trim().slice(0, max); }
function sbHeaders(env, extra = {}) { return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", ...extra }; }
function requireSupabase(env) { if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase não configurado no Worker."); }

async function sbFetch(env, path, options = {}) {
  requireSupabase(env);
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { ...options, headers: sbHeaders(env, options.headers || {}) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function saveOrder(env, order) {
  const data = await sbFetch(env, "orders", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(order) });
  return Array.isArray(data) ? data[0] || null : data;
}

async function loadProducts(env, cart) {
  const ids = [...new Set(cart.map(x => String(x?.id ?? "")).filter(Boolean))];
  if (!ids.length || ids.length !== cart.length && cart.some(x => !x?.id)) throw new Error("Há item sem identificador de produto.");
  const filter = ids.map(encodeURIComponent).join(",");
  const data = await sbFetch(env, `products?select=id,name,price,stock,status&or=(id.in.(${filter}))`);
  const map = new Map((data || []).map(p => [String(p.id), p]));
  const items = [];
  let subtotalCents = 0;
  for (const raw of cart) {
    const p = map.get(String(raw.id));
    if (!p) throw new Error("Um produto do carrinho não existe mais.");
    const quantity = Math.max(1, Math.floor(Number(raw.quantity) || 1));
    const stock = Math.max(0, Number(p.stock || 0));
    if (p.status !== "available" || stock < quantity) throw new Error(`Estoque insuficiente para ${p.name}. Disponível: ${stock}.`);
    const unitAmount = Math.round(Number(p.price || 0) * 100);
    if (!Number.isFinite(unitAmount) || unitAmount <= 0) throw new Error(`Preço inválido para ${p.name}.`);
    subtotalCents += unitAmount * quantity;
    items.push({ product_id: String(p.id), reference_id: String(p.id), name: safeText(p.name, 100), quantity, unit_amount: unitAmount });
  }
  return { items, subtotalCents };
}

function getQrData(charge) {
  const links = Array.isArray(charge?.links) ? charge.links : [];
  return { text: charge?.qr_code?.text || null, image: links.find(link => link?.rel === "QRCODE.PNG")?.href || null };
}

function base64Bytes(value) {
  const bin = atob(String(value || "").trim());
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
function pemToSpki(value) {
  return base64Bytes(String(value || "").replace(/-----[^-]+-----/g, "").replace(/\s/g, ""));
}
function derToRawEcdsa(sig, size = 32) {
  const b = sig instanceof Uint8Array ? sig : new Uint8Array(sig);
  if (b[0] !== 0x30) return b;
  let i = 2; if (b[1] & 0x80) i = 2 + (b[1] & 0x7f);
  if (b[i++] !== 0x02) return b; let rl = b[i++]; if (rl & 0x80) { let n=rl&0x7f; rl=0; while(n--) rl=(rl<<8)|b[i++]; }
  let r=b.slice(i,i+rl); i+=rl; if (b[i++] !== 0x02) return b; let sl=b[i++]; if(sl&0x80){let n=sl&0x7f;sl=0;while(n--)sl=(sl<<8)|b[i++];}
  let s=b.slice(i,i+sl); while(r.length>size&&r[0]===0)r=r.slice(1); while(s.length>size&&s[0]===0)s=s.slice(1);
  const out=new Uint8Array(size*2); out.set(r.slice(-size),size-Math.min(size,r.length)); out.set(s.slice(-size),size*2-Math.min(size,s.length)); return out;
}
async function verifyPagBankWebhook(rawBody, request, env) {
  if (!env.PAGBANK_TOKEN) return false;
  const header = request.headers.get("x-payload-signature");
  if (!header) return false;
  const keyResponse = await fetch(`${PAGBANK_API}/public-keys?type=webhook`, { headers: { Authorization: `Bearer ${env.PAGBANK_TOKEN}`, Accept: "application/json" } });
  if (!keyResponse.ok) return false;
  const keyData = await keyResponse.json();
  if (!keyData.public_key) return false;
  const key = await crypto.subtle.importKey("spki", pemToSpki(keyData.public_key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const bytes = new TextEncoder().encode(rawBody);
  const signatures = header.split(",").map(x => x.trim()).filter(Boolean);
  for (const encoded of signatures) {
    try {
      const sig = base64Bytes(encoded);
      if (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, bytes)) return true;
      const raw = derToRawEcdsa(sig);
      if (raw !== sig && await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, bytes)) return true;
    } catch (_) {}
  }
  return false;
}

async function findOrder(env, payload) {
  const orderId = safeText(payload?.id, 80);
  const reference = safeText(payload?.reference_id, 100);
  const chargeId = safeText(payload?.charges?.[0]?.id, 80);
  let query = "orders?select=*&limit=1";
  if (orderId) query += `&pagbank_order_id=eq.${encodeURIComponent(orderId)}`;
  else if (chargeId) query += `&pagbank_charge_id=eq.${encodeURIComponent(chargeId)}`;
  else if (reference) query += `&reference_id=eq.${encodeURIComponent(reference)}`;
  else return null;
  const rows = await sbFetch(env, query);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function processPaidOrder(env, order, charge) {
  return sbFetch(env, "rpc/rsmf_confirm_paid_order", { method: "POST", body: JSON.stringify({ p_order_id: order.id, p_charge_id: charge?.id || order.pagbank_charge_id || null, p_paid_at: charge?.paid_at || new Date().toISOString() }) });
}

async function updateNonPaidStatus(env, order, charge) {
  const status = safeText(charge?.status || "WAITING", 30).toUpperCase();
  const terminal = ["CANCELED", "DECLINED"].includes(status);
  await sbFetch(env, `orders?id=eq.${encodeURIComponent(order.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ payment_status: status, order_status: terminal ? "cancelado" : "aguardando_pagamento" }) });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") return json({ ok: true, service: "RSMF PagBank API", environment: "sandbox", supabase: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY), webhook: "/webhook/pagbank" });

    if (url.pathname === "/webhook/pagbank" && request.method === "POST") {
      try {
        const rawBody = await request.text();
        if (!await verifyPagBankWebhook(rawBody, request, env)) return json({ error: "Notificação PagBank sem assinatura válida." }, 401);
        const payload = JSON.parse(rawBody);
        const order = await findOrder(env, payload);
        if (!order) return json({ ok: true, ignored: "Pedido não localizado." });
        const charge = Array.isArray(payload.charges) ? payload.charges.find(c => c?.id === order.pagbank_charge_id) || payload.charges[0] : null;
        if (!charge) return json({ ok: true, ignored: "Cobrança ausente." });
        if (String(charge.status || "").toUpperCase() === "PAID") await processPaidOrder(env, order, charge); else await updateNonPaidStatus(env, order, charge);
        return json({ ok: true });
      } catch (error) { return json({ error: "Falha ao processar webhook.", message: error.message }, 500); }
    }

    if (url.pathname === "/pix" && request.method === "POST") {
      try {
        if (!env.PAGBANK_TOKEN) return json({ error: "PAGBANK_TOKEN não configurado." }, 500);
        const body = await request.json();
        const checkout = body.checkout || {}, customer = checkout.customer || {}, address = checkout.address || {}, shipping = checkout.shipping || {};
        const cart = Array.isArray(body.cart) ? body.cart : [];
        if (!cart.length) return json({ error: "Carrinho vazio." }, 400);

        const customerName = safeText(customer.name, 80), customerEmail = safeText(customer.email, 120), customerTaxId = digits(customer.tax_id);
        if (!customerName || !customerEmail || customerTaxId.length !== 11) return json({ error: "Preencha nome, e-mail e CPF válidos antes de gerar o Pix." }, 400);
        if (digits(address.cep).length !== 8 || !safeText(address.street) || !safeText(address.number) || !safeText(address.city) || safeText(address.state,2).length !== 2) return json({ error: "Endereço de entrega incompleto." }, 400);

        const { items, subtotalCents } = await loadProducts(env, cart);
        const shippingCents = Math.max(0, Math.round(Number(shipping.price || 0) * 100));
        if (!Number.isFinite(shippingCents)) return json({ error: "Frete inválido." }, 400);
        const amountInCents = subtotalCents + shippingCents;
        const total = amountInCents / 100, subtotal = subtotalCents / 100, shippingPrice = shippingCents / 100;
        const expiration = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        const reference = `RSMF-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        const pagbankItems = items.map(({ product_id, ...item }) => item);

        const pagbankOrder = {
          reference_id: reference,
          customer: { name: customerName, email: customerEmail, tax_id: customerTaxId },
          items: pagbankItems,
          shipping: { address: { street: safeText(address.street,160), number: safeText(address.number,20), complement: safeText(address.complement,60) || "Sem complemento", locality: safeText(address.district,80), city: safeText(address.city,80), region_code: safeText(address.state,2).toUpperCase(), country: "BRA", postal_code: digits(address.cep) } },
          notification_urls: [`${url.origin}/webhook/pagbank`],
          charges: [{ reference_id: `${reference}-PIX`, description: "Pedido RSMF Ceramica", amount: { value: amountInCents, currency: "BRL" }, payment_method: { type: "PIX", pix: { expiration_date: expiration } } }],
        };

        const response = await fetch(`${PAGBANK_API}/orders`, { method: "POST", headers: { Authorization: `Bearer ${env.PAGBANK_TOKEN}`, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(pagbankOrder) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
              console.error("PAGBANK_ERRO_REAL", JSON.stringify({
                status: response.status,
                resposta: data
              }));
              return json({
                error: "Erro ao criar cobrança Pix no PagBank.",
                status: response.status,
                details: data
              }, response.status);
            }
        const charge = data.charges?.[0]; if (!charge) return json({ error: "PagBank não retornou a cobrança Pix.", details: data }, 502);
        const qr = getQrData(charge); if (!qr.text) return json({ error: "A cobrança foi criada, mas o PagBank não retornou o código Pix.", status: charge.status || null }, 502);

        const orderRecord = {
          reference_id: data.reference_id || reference, pagbank_order_id: data.id || null, pagbank_charge_id: charge.id || null, customer_name: customerName, customer_email: customerEmail,
          subtotal, shipping_price: shippingPrice, total, shipping_service: safeText(shipping.name || shipping.service,80)||null, shipping_company: safeText(shipping.company,80)||null,
          shipping_delivery_time: shipping.delivery_time || null, address_cep: safeText(address.cep,10)||null, address_street: safeText(address.street,160)||null,
          address_number: safeText(address.number,20)||null, address_complement: safeText(address.complement,60) || "Sem complemento"||null, address_district: safeText(address.district,80)||null,
          address_city: safeText(address.city,80)||null, address_state: safeText(address.state,2).toUpperCase()||null, payment_method: "PIX", payment_status: charge.status || "WAITING",
          order_status: "aguardando_pagamento", pix_expiration: charge.payment_method?.pix?.expiration_date || expiration,
          items: items.map(i => ({ product_id: i.product_id, name: i.name, quantity: i.quantity, unit_amount: i.unit_amount }))
        };
        const savedOrder = await saveOrder(env, orderRecord);
        return json({ ok:true, order_id:data.id||null, reference_id:data.reference_id||reference, charge_id:charge.id||null, status:charge.status||null, amount:charge.amount?.value||amountInCents, expiration_date:charge.payment_method?.pix?.expiration_date||expiration, database_order_id:savedOrder?.id||null, pix:qr });
      } catch (error) { return json({ error: "Erro interno ao gerar Pix.", message: error.message }, 500); }
    }
    return json({ error: "Rota não encontrada." }, 404);
  },
};
