const PAGBANK_API = "https://sandbox.api.pagseguro.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      ...corsHeaders,
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return json({
        ok: true,
        service: "RSMF PagBank API",
        environment: "sandbox",
      });
    }

    if (url.pathname === "/pix" && request.method === "POST") {
      try {
        if (!env.PAGBANK_TOKEN) {
          return json(
            { error: "PAGBANK_TOKEN não configurado." },
            500
          );
        }

        const body = await request.json();
        const total = Number(body.total);

        if (!Number.isFinite(total) || total <= 0) {
          return json(
            { error: "Valor total inválido." },
            400
          );
        }

        const amountInCents = Math.round(total * 100);

        const expiration = new Date(
          Date.now() + 30 * 60 * 1000
        ).toISOString();

        const reference =
          "RSMF-" +
          Date.now() +
          "-" +
          Math.random()
            .toString(36)
            .slice(2, 8)
            .toUpperCase();

        const order = {
          reference_id: reference,

          customer: {
            name: "Jose da Silva",
            email: "jose.silva@example.com",
            tax_id: "12345678909",
            phones: [
              {
                country: "55",
                area: "11",
                number: "999999999",
                type: "MOBILE",
              },
            ],
          },

          items: [
            {
              reference_id: "001",
              name: "Vaso RSMF Ceramica",
              quantity: 1,
              unit_amount: amountInCents,
            },
          ],

          qr_codes: [
            {
              amount: {
                value: amountInCents,
              },
              expiration_date: expiration,
            },
          ],
        };

        const response = await fetch(
          PAGBANK_API + "/orders",
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${env.PAGBANK_TOKEN}`,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(order),
          }
        );

        const data = await response.json();

        if (!response.ok) {
          return json(
            {
              error:
                "Erro ao criar cobrança Pix no PagBank.",
              status: response.status,
              details: data,
            },
            response.status
          );
        }

        const qrCode = data.qr_codes?.[0];

        if (!qrCode) {
          return json(
            {
              error:
                "PagBank não retornou o QR Code Pix.",
              details: data,
            },
            502
          );
        }

        const qrCodeImage =
          qrCode.links?.find(
            (link) => link.rel === "QRCODE.PNG"
          )?.href || null;

        return json({
          ok: true,
          order_id: data.id,
          reference_id:
            data.reference_id || reference,
          created_at: data.created_at,
          pix: {
            id: qrCode.id,
            text: qrCode.text || null,
            image: qrCodeImage,
            expiration_date:
              qrCode.expiration_date || expiration,
            amount: qrCode.amount?.value,
          },
        });
      } catch (error) {
        return json(
          {
            error: "Erro interno ao gerar Pix.",
            message: error.message,
          },
          500
        );
      }
    }

    return json(
      { error: "Rota não encontrada." },
      404
    );
  },
};
