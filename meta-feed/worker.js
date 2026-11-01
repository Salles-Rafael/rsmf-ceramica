
const EXISTENTES = {
  "004-004":"19i00plr5i",
  "003-003":"nvelctms6u",
  "001-001":"fcy5nfnzgu",
  "002-002":"ipa8c5zk5c"
};

const NOMES = {
  "004-004":"Vaso pequeno",
  "003-003":"Vaso pequeno",
  "001-001":"Vaso médio",
  "002-002":"Vaso médio"
};

function csv(v) {
  const s = String(v ?? "").replace(/\s+/g," ").trim();
  return '"' + s.replace(/"/g,'""') + '"';
}

export default {
  async fetch(request, env) {
    const u = new URL(request.url);

    if (u.pathname !== "/catalogo.csv" &&
        u.pathname !== "/") {
      return new Response("Não encontrado",{status:404});
    }

    const endpoint =
      env.SUPABASE_URL +
      "/rest/v1/products?select=id,slug,name,description,price,stock,status,cover_image_url&limit=1000";

    let resposta;
    try {
      resposta = await fetch(endpoint,{
        headers:{
          apikey:env.SUPABASE_KEY,
          Authorization:"Bearer "+env.SUPABASE_KEY
        }
      });
    } catch(e) {
      return new Response("Falha ao consultar catálogo",{
        status:502
      });
    }

    if (!resposta.ok) {
      return new Response("Falha ao consultar produtos",{
        status:502
      });
    }

    const produtos = await resposta.json();

    const cabecalho = [
      "id","title","description","availability",
      "condition","price","link","image_link","brand"
    ];

    const linhas = [cabecalho.join(",")];

    for (const p of produtos) {
      if (p.status === "draft") continue;
      if (!p.slug || !p.id || !p.cover_image_url) continue;

      const preco = Number(p.price);
      if (!Number.isFinite(preco) || preco < 0) continue;

      const id = EXISTENTES[p.slug] || "rsmf_" + p.id;

      const disponivel =
        p.status === "available" &&
        Number(p.stock) > 0;

      const dados = [
        id,
        NOMES[p.slug] || p.name,
        p.description || "Peça artesanal RSMF Cerâmica",
        disponivel ? "in stock" : "out of stock",
        "new",
        preco.toFixed(2) + " BRL",
        "https://rsmfceramica.com.br/produto/?slug=" +
          encodeURIComponent(p.slug),
        p.cover_image_url,
        "RSMF Cerâmica"
      ];

      linhas.push(dados.map(csv).join(","));
    }

    return new Response(linhas.join("\r\n")+"\r\n",{
      headers:{
        "Content-Type":"text/csv; charset=utf-8",
        "Cache-Control":"no-store"
      }
    });
  }
};
