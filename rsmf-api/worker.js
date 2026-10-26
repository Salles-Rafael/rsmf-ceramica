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
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Authorization: `Bearer ${await obterTokenOAuth(env)}`
    }
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
      const chave = request.headers.get("X-RSMF-Admin-Key");

      if (
        !env.RSMF_ADMIN_KEY ||
        !chave ||
        chave !== env.RSMF_ADMIN_KEY
      ) {
        return json({
          ok: false,
          erro: "Acesso administrativo nao autorizado"
        }, 403);
      }

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

        const estado = gerarEstadoOAuth();
        await env.RSMF_OAUTH.put(
          "oauth_state:" + estado,
          "pendente",
          { expirationTtl: 600 }
        );
        auth.searchParams.set("state", estado);

        return Response.redirect(auth.toString(), 302);
      }

      if (path === "/melhor-envio/callback") {
        const estado = url.searchParams.get("state");

      if (!env.RSMF_OAUTH || !estado) {
        return json({ ok: false, erro: "Estado OAuth ausente" }, 403);
      }

      const chaveEstado = "oauth_state:" + estado;
      const estadoSalvo = await env.RSMF_OAUTH.get(chaveEstado);

      if (estadoSalvo !== "pendente") {
        return json({ ok: false, erro: "Estado OAuth invalido" }, 403);
      }

      await env.RSMF_OAUTH.delete(chaveEstado);

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


const dadosOAuth = await r.json();
if (!dadosOAuth.access_token || !dadosOAuth.refresh_token) {
  return json({ ok: false, erro: "Tokens OAuth ausentes" }, 502);
}
await salvarOAuth(env, dadosOAuth);

return json({
          ok: true,
          mensagem: "OAuth de producao autorizado.",
          proxima_etapa:
            "Configurar armazenamento seguro do token."
        });
      }

      if (path === "/servicos") {
        if (!(await obterTokenOAuth(env))) {
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
        if (!(await obterTokenOAuth(env))) {
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
          },
  services: "1,2,3,4"
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

async function salvarOAuth(env, dados) {
  if (!env.RSMF_OAUTH) {
    throw new Error("Armazenamento OAuth indisponivel");
  }

  await env.RSMF_OAUTH.put(
    "melhor_envio_tokens",
    JSON.stringify({
      access_token: dados.access_token,
      refresh_token: dados.refresh_token,
      expires_at: Date.now() + (dados.expires_in || 2592000) * 1000
    })
  );
}

async function obterTokenOAuth(env) {
  if (env.RSMF_OAUTH) {
    const dados = await env.RSMF_OAUTH.get(
      "melhor_envio_tokens",
      "json"
    );

    if (dados?.access_token) {
      if (dados.expires_at > Date.now() + 60000) {
        return dados.access_token;
      }

      return await renovarOAuth(env, dados);
    }
  }

  return token(env);
}

async function renovarOAuth(env, dados) {
  if (!dados?.refresh_token) return null;

  const resposta = await fetch(BASE + "/oauth/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: dados.refresh_token,
      client_id: env.MELHOR_ENVIO_CLIENT_ID,
      client_secret: env.MELHOR_ENVIO_CLIENT_SECRET
    })
  });

  if (!resposta.ok) {
    throw new Error("Falha ao renovar OAuth");
  }

  const novosDados = await resposta.json();

  if (!novosDados.access_token) {
    throw new Error("Novo token OAuth ausente");
  }

  await salvarOAuth(env, {
    ...novosDados,
    refresh_token:
      novosDados.refresh_token || dados.refresh_token
  });

  return novosDados.access_token;
}

function gerarEstadoOAuth() {
  return crypto.randomUUID();
}
