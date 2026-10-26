const BASE = "https://melhorenvio.com.br";
const CALLBACK = "https://rsmf-api.rsmfreire.workers.dev/melhor-envio/callback";
const USER_AGENT = "RSMF Ceramica (rsmfreire@gmail.com)";
const ORIGIN_CEP = "41810815";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...cors
    }
  });
}

function token(env) {
  return (env.MELHOR_ENVIO_TOKEN || "")
    .trim()
    .replace(/^Bearer\s+/i, "");
}

function headers(env) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    Authorization: `Bearer ${token(env)}`
  };
}

async function api(path, env, method = "GET", body = null) {
  const options = {
    method,
    headers: headers(env)
  };

  if (body) options.body = JSON.stringify(body);

  const r = await fetch(BASE + path, options);
  const text = await r.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return { status: r.status, data };
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: cors
        });
      }

      if (path === "/") {
        return json({
          ok: true,
          app: "RSMF API",
          ambiente: "producao",
          token_configurado: !!token(env)
        });
      }

      if (path === "/melhor-envio/autorizar") {
        if (!env.MELHOR_ENVIO_CLIENT_ID) {
          return json({
            ok: false,
            erro: "CLIENT_ID ausente"
          }, 500);
        }

        const auth = new URL(BASE + "/oauth/authorize");

        auth.searchParams.set(
          "client_id",
          env.MELHOR_ENVIO_CLIENT_ID
        );

        auth.searchParams.set(
          "redirect_uri",
          CALLBACK
        );

        auth.searchParams.set(
          "response_type",
          "code"
        );

        auth.searchParams.set(
          "scope",
          "shipping-calculate shipping-companies"
        );

        auth.searchParams.set(
          "state",
          "rsmf-ceramica"
        );

        return Response.redirect(auth.toString(), 302);
      }

      if (path === "/melhor-envio/callback") {
        const code = url.searchParams.get("code");

        if (!code) {
          return json({
            ok: false,
            erro: "Codigo OAuth ausente"
          }, 400);
        }

        const r = await fetch(BASE + "/oauth/token", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT
          },
          body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: env.MELHOR_ENVIO_CLIENT_ID,
            client_secret: env.MELHOR_ENVIO_CLIENT_SECRET,
            redirect_uri: CALLBACK,
            code
          })
        });

        if (!r.ok) {
          return json({
            ok: false,
            erro: "Falha na troca OAuth",
            status: r.status
          }, r.status);
        }

        return json({
          ok: true,
          mensagem: "OAuth de producao autorizado.",
          proxima_etapa:
            "Configurar armazenamento seguro do token."
        });
      }

      if (path === "/servicos") {
        if (!token(env)) {
          return json({
            ok: false,
            erro: "MELHOR_ENVIO_TOKEN nao configurado"
          }, 401);
        }

        const r = await api(
          "/api/v2/me/shipment/services",
          env
        );

        return json(r.data, r.status);
      }

      if (path === "/frete") {
        if (!token(env)) {
          return json({
            ok: false,
            erro: "MELHOR_ENVIO_TOKEN nao configurado"
          }, 401);
        }

        const cep = (url.searchParams.get("cep") || "")
          .replace(/\D/g, "");

        if (cep.length !== 8) {
          return json({
            ok: false,
            erro: "CEP invalido"
          }, 400);
        }

        const body = {
          from: {
            postal_code: ORIGIN_CEP
          },
          to: {
            postal_code: cep
          },
          products: [{
            id: "001",
            width: 20,
            height: 20,
            length: 20,
            weight: 2,
            insurance_value: 100,
            quantity: 1
          }],
          options: {
            receipt: false,
            own_hand: false,
            collect: false
          }
        };

        const r = await api(
          "/api/v2/me/shipment/calculate",
          env,
          "POST",
          body
        );

        return json(r.data, r.status);
      }

      return json({
        ok: false,
        erro: "Rota nao encontrada"
      }, 404);

    } catch (e) {
      return json({
        ok: false,
        erro: String(e.message || e)
      }, 500);
    }
  }
};
