const PAGBANK_API = "https://sandbox.api.pagseguro.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8", ...corsHeaders },
  });
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function safeText(value, max = 255) {
  return String(value || "").trim().slice(0, max);
}

async function saveOrder(env, order) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase não configurado no Worker.");
  }

  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/orders`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(order),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Erro ao salvar pedido no Supabase: ${JSON.stringify(data)}`);
  }
  return Array.isArray(data) ? data[0] || null : data;
}

function getQrData(charge) {
  const links = Array.isArray(charge?.links) ? charge.links : [];
  return {
    text: charge?.qr_code?.text || null,
    image: links.find(link => link?.rel === "QRCODE.PNG")?.href || null,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return json({
        ok: true,
        service: "RSMF PagBank API",
        environment: "sandbox",
        supabase: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
      });
    }

    if (url.pathname === "/pix" && request.method === "POST") {
      try {
        if (!env.PAGBANK_TOKEN) {
          return json({ error: "PAGBANK_TOKEN não configurado." }, 500);
        }

        const body = await request.json();
        const checkout = body.checkout || {};
        const customer = checkout.customer || {};
        const address = checkout.address || {};
        const shipping = checkout.shipping || {};
        const cart = Array.isArray(body.cart) ? body.cart : [];

        const total = Number(checkout.total ?? body.total);
        const subtotal = Number(checkout.subtotal || 0);
        const shippingPrice = Number(shipping.price || 0);

        if (!Number.isFinite(total) || total <= 0) {
          return json({ error: "Valor total inválido." }, 400);
        }
        if (!cart.length) {
          return json({ error: "Carrinho vazio." }, 400);
        }

        const customerName = safeText(customer.name, 80);
        const customerEmail = safeText(customer.email, 120);
        const customerTaxId = digits(customer.tax_id);

        if (!customerName || !customerEmail || customerTaxId.length !== 11) {
          return json({ error: "Preencha nome, e-mail e CPF válidos antes de gerar o Pix." }, 400);
        }

        const amountInCents = Math.round(total * 100);
        const expiration = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        const reference = `RSMF-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

        const items = cart.map((item, index) => ({
          reference_id: safeText(item.id || item.reference_id || `ITEM-${index + 1}`, 64),
          name: safeText(item.name || item.title || `Produto ${index + 1}`, 100),
          quantity: Math.max(1, Math.floor(Number(item.quantity) || 1)),
          unit_amount: Math.max(1, Math.round(Number(item.price || 0) * 100)),
        }));

        if (items.some(item => !Number.isFinite(item.unit_amount) || item.unit_amount <= 0)) {
          return json({ error: "Há produto com preço inválido no carrinho." }, 400);
        }

        const pagbankOrder = {
          reference_id: reference,
          customer: {
            name: customerName,
            email: customerEmail,
            tax_id: customerTaxId,
          },
          items,
          shipping: {
            address: {
              street: safeText(address.street, 160),
              number: safeText(address.number, 20),
              complement: safeText(address.complement, 60),
              locality: safeText(address.district, 80),
              city: safeText(address.city, 80),
              region_code: safeText(address.state, 2).toUpperCase(),
              country: "BRA",
              postal_code: digits(address.cep),
            },
          },
          charges: [{
            reference_id: `${reference}-PIX`,
            description: "Pedido RSMF Ceramica",
            amount: { value: amountInCents, currency: "BRL" },
            payment_method: {
              type: "PIX",
              pix: { expiration_date: expiration },
            },
          }],
        };

        const response = await fetch(`${PAGBANK_API}/orders`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.PAGBANK_TOKEN}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(pagbankOrder),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          return json({
            error: "Erro ao criar cobrança Pix no PagBank.",
            status: response.status,
            details: data,
          }, response.status);
        }

        const charge = data.charges?.[0];
        if (!charge) {
          return json({ error: "PagBank não retornou a cobrança Pix.", details: data }, 502);
        }

        const qr = getQrData(charge);
        if (!qr.text) {
          return json({
            error: "A cobrança foi criada, mas o PagBank não retornou o código Pix.",
            status: charge.status || null,
            order_id: data.id || null,
            charge_id: charge.id || null,
          }, 502);
        }

        const orderRecord = {
          reference_id: data.reference_id || reference,
          pagbank_order_id: data.id || null,
          pagbank_charge_id: charge.id || null,
          customer_name: customerName,
          subtotal: Number.isFinite(subtotal) ? subtotal : 0,
          shipping_price: Number.isFinite(shippingPrice) ? shippingPrice : 0,
          total,
          shipping_service: safeText(shipping.name || shipping.service, 80) || null,
          shipping_company: safeText(shipping.company, 80) || null,
          shipping_delivery_time: shipping.delivery_time || null,
          address_cep: safeText(address.cep, 10) || null,
          address_street: safeText(address.street, 160) || null,
          address_number: safeText(address.number, 20) || null,
          address_complement: safeText(address.complement, 60) || null,
          address_district: safeText(address.district, 80) || null,
          address_city: safeText(address.city, 80) || null,
          address_state: safeText(address.state, 2).toUpperCase() || null,
          payment_method: "PIX",
          payment_status: charge.status || "WAITING",
          order_status: "aguardando_pagamento",
          pix_expiration: charge.payment_method?.pix?.expiration_date || expiration,
        };

        const savedOrder = await saveOrder(env, orderRecord);

        return json({
          ok: true,
          order_id: data.id || null,
          reference_id: data.reference_id || reference,
          charge_id: charge.id || null,
          status: charge.status || null,
          amount: charge.amount?.value || amountInCents,
          expiration_date: charge.payment_method?.pix?.expiration_date || expiration,
          database_order_id: savedOrder?.id || null,
          pix: qr,
        });
      } catch (error) {
        return json({ error: "Erro interno ao gerar Pix.", message: error.message }, 500);
      }
    }

    return json({ error: "Rota não encontrada." }, 404);
  },
};
