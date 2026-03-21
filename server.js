const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const cors = require('cors');
require('dotenv').config();

const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
app.use(cors({ 
  origin: '*',
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// ── HEALTH ──
app.get('/', (req, res) => res.json({ status: 'CargoLink Backend a funcionar!', version: '2.0' }));

// ── AUTH ──
app.post('/auth/registar', async (req, res) => {
  const { nome, email, password, tipo, telefone, nif, veiculo_tipo, veiculo_matricula, iban, iban_titular } = req.body;
  if (!nome || !email || !password || !tipo) return res.status(400).json({ erro: 'Dados incompletos' });
  const { data, error } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { nome, tipo, telefone }
  });
  if (error) return res.status(400).json({ erro: error.message });
  const userData = { id: data.user.id, nome, email, tipo, telefone };
  if (tipo === 'operador') {
    if (nif) userData.nif = nif;
    if (veiculo_tipo) userData.veiculo_tipo = veiculo_tipo;
    if (veiculo_matricula) userData.veiculo_matricula = veiculo_matricula;
    if (iban) userData.iban = iban;
    if (iban_titular) userData.iban_titular = iban_titular;
  }
  await supabase.from('utilizadores').insert([userData]);
  res.json({ sucesso: true, utilizador: { id: data.user.id, nome, email, tipo } });
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ erro: 'Email e password obrigatórios' });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ erro: 'Email ou password incorretos' });
  const utilizador = {
    id: data.user.id,
    email: data.user.email,
    nome: data.user.user_metadata?.nome || email.split('@')[0],
    tipo: data.user.user_metadata?.tipo || 'cliente'
  };
  res.json({ sucesso: true, token: data.session.access_token, utilizador });
});

app.post('/auth/recuperar', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ erro: 'Email obrigatório' });
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: 'https://grupocargolink.com/entrar.html?reset=true'
  });
  res.json({ sucesso: true });
});

// ── PEDIDOS ──
app.post('/pedido/criar', async (req, res) => {
  const {
    cliente_id, origem, destino,
    tipo_veiculo, distancia_km, duracao_min,
    preco_total, preco_base, preco_km,
    extra_ajuda, extra_equip, extra_urgente, extra_seguro,
    fatura_tipo, fatura_nif, fatura_nome, fatura_morada,
    origem_coords, destino_coords
  } = req.body;

  if (!cliente_id || !origem || !destino || !tipo_veiculo) {
    return res.status(400).json({ erro: 'Dados incompletos' });
  }

  const { data, error } = await supabase.from('pedidos').insert([{
    cliente_id, origem, destino,
    tipo_veiculo, distancia_km, duracao_min,
    preco_total, preco_base, preco_km,
    extra_ajuda: extra_ajuda || 0,
    extra_equip: extra_equip || 0,
    extra_urgente: extra_urgente || false,
    extra_seguro: extra_seguro || false,
    fatura_tipo: fatura_tipo || 'consumidor',
    fatura_nif, fatura_nome, fatura_morada,
    origem_coords, destino_coords,
    estado: 'pendente'
  }]).select();

  if (error) return res.status(400).json({ erro: error.message });
  
  // Send email to all available operators
  try {
    const { data: operadores } = await supabase
      .from('utilizadores')
      .select('email, nome')
      .eq('tipo', 'operador')
      .eq('online', true);
    
    if (operadores && operadores.length > 0) {
      const pedido = data[0];
      const earn = (parseFloat(pedido.preco_total || 0) * 0.80).toFixed(2);
      
      await Promise.all(operadores.map(op => 
        resend.emails.send({
          from: 'CargoLink <noreply@grupocargolink.com>',
          to: op.email,
          subject: `🆕 Novo pedido disponível — €${earn}`,
          html: `
            <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px;">
              <div style="background:#22C55E;padding:20px;border-radius:12px 12px 0 0;text-align:center;">
                <h1 style="color:#fff;margin:0;font-size:24px;">🚛 CargoLink</h1>
                <p style="color:rgba(255,255,255,.8);margin:5px 0 0;">Novo pedido disponível</p>
              </div>
              <div style="background:#f0fdf4;padding:20px;border-radius:0 0 12px 12px;border:1px solid #bbf7d0;">
                <h2 style="color:#111;font-size:20px;margin:0 0 15px;">Olá ${op.nome}!</h2>
                <p style="color:#6B7280;">Tens um novo pedido disponível:</p>
                <div style="background:#fff;border-radius:10px;padding:15px;margin:15px 0;border:1px solid #e5e7eb;">
                  <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
                    <span style="color:#6B7280;font-size:14px;">Rota</span>
                    <strong style="color:#111;">${pedido.origem?.split(',')[0]} → ${pedido.destino?.split(',')[0]}</strong>
                  </div>
                  <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
                    <span style="color:#6B7280;font-size:14px;">Distância</span>
                    <strong style="color:#111;">${pedido.distancia_km} km</strong>
                  </div>
                  <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
                    <span style="color:#6B7280;font-size:14px;">Veículo</span>
                    <strong style="color:#111;">${pedido.tipo_veiculo}</strong>
                  </div>
                  <div style="display:flex;justify-content:space-between;border-top:1px solid #e5e7eb;padding-top:10px;margin-top:5px;">
                    <span style="color:#6B7280;font-size:14px;">Tu recebes</span>
                    <strong style="color:#16A34A;font-size:20px;">€${earn}</strong>
                  </div>
                </div>
                <a href="https://grupocargolink-droid.github.io/Site/entrar.html" 
                   style="display:block;background:#22C55E;color:#fff;text-align:center;padding:14px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;margin-top:10px;">
                  ✓ Ver e aceitar pedido
                </a>
                <p style="color:#9CA3AF;font-size:12px;text-align:center;margin-top:15px;">
                  CargoLink Grupo · Portugal · <a href="#" style="color:#9CA3AF;">Cancelar notificações</a>
                </p>
              </div>
            </div>
          `
        })
      ));
    }
  } catch (emailErr) {
    console.log('Email error (non-fatal):', emailErr.message);
  }

  res.json({ sucesso: true, pedido: data[0] });
});

app.get('/pedidos/pendentes', async (req, res) => {
  const { data, error } = await supabase
    .from('pedidos')
    .select('*, utilizadores!cliente_id(nome, email)')
    .eq('estado', 'pendente')
    .order('criado_em', { ascending: false });
  if (error) return res.status(400).json({ erro: error.message });
  res.json(data);
});

app.get('/pedidos/cliente/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('pedidos')
    .select('*')
    .eq('cliente_id', req.params.id)
    .order('criado_em', { ascending: false });
  if (error) return res.status(400).json({ erro: error.message });
  res.json(data);
});

app.get('/pedidos/operador/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('pedidos')
    .select('*, utilizadores!cliente_id(nome, email)')
    .eq('operador_id', req.params.id)
    .order('criado_em', { ascending: false });
  if (error) return res.status(400).json({ erro: error.message });
  res.json(data);
});

app.post('/pedido/aceitar', async (req, res) => {
  const { pedido_id, operador_id } = req.body;
  if (!pedido_id || !operador_id) return res.status(400).json({ erro: 'Dados incompletos' });
  const { data, error } = await supabase
    .from('pedidos')
    .update({ operador_id, estado: 'aceite', aceite_em: new Date().toISOString() })
    .eq('id', pedido_id)
    .eq('estado', 'pendente')
    .select();
  if (error) return res.status(400).json({ erro: error.message });
  if (!data.length) return res.status(400).json({ erro: 'Pedido já foi aceite ou não existe' });
  
  // Notify client by email
  try {
    const pedido = data[0];
    const { data: cliente } = await supabase
      .from('utilizadores').select('email, nome').eq('id', pedido.cliente_id).single();
    const { data: operador } = await supabase
      .from('utilizadores').select('nome').eq('id', operador_id).single();
    
    if (cliente) {
      await resend.emails.send({
        from: 'CargoLink <noreply@grupocargolink.com>',
        to: cliente.email,
        subject: '✅ Pedido aceite — Operador a caminho!',
        html: `
          <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px;">
            <div style="background:#22C55E;padding:20px;border-radius:12px 12px 0 0;text-align:center;">
              <h1 style="color:#fff;margin:0;">🚛 CargoLink</h1>
            </div>
            <div style="background:#f0fdf4;padding:20px;border-radius:0 0 12px 12px;border:1px solid #bbf7d0;">
              <h2 style="color:#111;">Olá ${cliente.nome}!</h2>
              <p style="color:#16A34A;font-size:18px;font-weight:bold;">✅ O teu pedido foi aceite!</p>
              <p style="color:#6B7280;">O operador <strong>${operador?.nome || 'CargoLink'}</strong> está a caminho da recolha.</p>
              <a href="https://grupocargolink-droid.github.io/Site/entrar.html" 
                 style="display:block;background:#22C55E;color:#fff;text-align:center;padding:14px;border-radius:10px;text-decoration:none;font-weight:700;margin-top:15px;">
                📍 Acompanhar entrega
              </a>
            </div>
          </div>
        `
      });
    }
  } catch (emailErr) {
    console.log('Email error (non-fatal):', emailErr.message);
  }

  res.json({ sucesso: true, pedido: data[0] });
});

app.post('/pedido/recolhido', async (req, res) => {
  const { pedido_id, operador_id } = req.body;
  const { data, error } = await supabase
    .from('pedidos')
    .update({ estado: 'em_transito', recolhido_em: new Date().toISOString() })
    .eq('id', pedido_id).eq('operador_id', operador_id).select();
  if (error) return res.status(400).json({ erro: error.message });
  res.json({ sucesso: true, pedido: data[0] });
});

app.post('/pedido/entregue', async (req, res) => {
  const { pedido_id, operador_id } = req.body;
  const { data, error } = await supabase
    .from('pedidos')
    .update({ estado: 'entregue', entregue_em: new Date().toISOString() })
    .eq('id', pedido_id).eq('operador_id', operador_id).select();
  if (error) return res.status(400).json({ erro: error.message });
  res.json({ sucesso: true, pedido: data[0] });
});

app.post('/pedido/cancelar', async (req, res) => {
  const { pedido_id, cliente_id } = req.body;
  const { data, error } = await supabase
    .from('pedidos')
    .update({ estado: 'cancelado' })
    .eq('id', pedido_id).eq('cliente_id', cliente_id).eq('estado', 'pendente').select();
  if (error) return res.status(400).json({ erro: error.message });
  res.json({ sucesso: true });
});

// ── TRACKING GPS ──
app.post('/tracking/update', async (req, res) => {
  const { pedido_id, operador_id, lat, lng } = req.body;
  const { error } = await supabase
    .from('pedidos')
    .update({ operador_lat: lat, operador_lng: lng, tracking_updated: new Date().toISOString() })
    .eq('id', pedido_id).eq('operador_id', operador_id);
  if (error) return res.status(400).json({ erro: error.message });
  res.json({ sucesso: true });
});

app.get('/tracking/:pedido_id', async (req, res) => {
  const { data, error } = await supabase
    .from('pedidos')
    .select('operador_lat, operador_lng, estado, tracking_updated')
    .eq('id', req.params.pedido_id).single();
  if (error) return res.status(400).json({ erro: error.message });
  res.json(data);
});

// ── AVALIAÇÕES ──
app.post('/avaliacao/criar', async (req, res) => {
  const { pedido_id, cliente_id, operador_id, estrelas, comentario } = req.body;
  if (!pedido_id || !estrelas) return res.status(400).json({ erro: 'Dados incompletos' });
  const { error } = await supabase.from('avaliacoes').insert([{
    pedido_id, cliente_id, operador_id, estrelas, comentario
  }]);
  if (error) return res.status(400).json({ erro: error.message });
  // Update operator average rating
  const { data: avals } = await supabase
    .from('avaliacoes').select('estrelas').eq('operador_id', operador_id);
  if (avals?.length) {
    const media = avals.reduce((s, a) => s + a.estrelas, 0) / avals.length;
    await supabase.from('utilizadores').update({ avaliacao: media.toFixed(2) }).eq('id', operador_id);
  }
  res.json({ sucesso: true });
});

// ── OPERADORES ──
app.get('/operadores/disponiveis', async (req, res) => {
  const { data, error } = await supabase
    .from('utilizadores')
    .select('id, nome, avaliacao, veiculo_tipo, online')
    .eq('tipo', 'operador')
    .eq('online', true);
  if (error) return res.status(400).json({ erro: error.message });
  res.json(data);
});

app.post('/operador/online', async (req, res) => {
  const { operador_id, online } = req.body;
  const { error } = await supabase
    .from('utilizadores').update({ online }).eq('id', operador_id);
  if (error) return res.status(400).json({ erro: error.message });
  res.json({ sucesso: true });
});

// ── PAGAMENTOS ──
app.post('/operador/veiculo', async (req, res) => {
  const { operador_id, tipo, matricula, modelo, ano } = req.body;
  if (!operador_id) return res.status(400).json({ erro: 'Dados incompletos' });
  const { error } = await supabase
    .from('utilizadores')
    .update({ veiculo_tipo: tipo, veiculo_matricula: matricula })
    .eq('id', operador_id);
  if (error) return res.status(400).json({ erro: error.message });
  res.json({ sucesso: true });
});

app.post('/operador/guardar-iban', async (req, res) => {
  const { operador_id, iban, titular } = req.body;
  if (!operador_id || !iban) return res.status(400).json({ erro: 'Dados incompletos' });
  const { error } = await supabase
    .from('utilizadores')
    .update({ iban, iban_titular: titular })
    .eq('id', operador_id);
  if (error) return res.status(400).json({ erro: error.message });
  res.json({ sucesso: true });
});

app.post('/operador/criar-conta', async (req, res) => {
  const { email, nome, utilizador_id } = req.body;
  try {
    const account = await stripe.accounts.create({
      type: 'express', country: 'PT', email,
      capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
      metadata: { nome }
    });
    await supabase.from('utilizadores').update({ stripe_account_id: account.id }).eq('id', utilizador_id);
    res.json({ accountId: account.id });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.post('/pagamento/criar', async (req, res) => {
  const { pedido_id, valor, operador_id } = req.body;
  // Get operator rating for dynamic commission
  const { data: op } = await supabase.from('utilizadores').select('avaliacao, stripe_account_id').eq('id', operador_id).single();
  const avaliacao = parseFloat(op?.avaliacao || 4.5);
  let comissaoPercent = 23;
  if (avaliacao >= 4.9) comissaoPercent = 15;
  else if (avaliacao >= 4.8) comissaoPercent = 20;
  const valorCentimos = Math.round(valor * 100);
  const comissaoCentimos = Math.round(valorCentimos * comissaoPercent / 100);
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: valorCentimos, currency: 'eur',
      application_fee_amount: comissaoCentimos,
      transfer_data: { destination: op.stripe_account_id },
      metadata: { pedido_id }
    });
    await supabase.from('pedidos').update({ payment_intent_id: paymentIntent.id }).eq('id', pedido_id);
    res.json({
      clientSecret: paymentIntent.client_secret,
      comissaoPercent,
      operadorRecebe: (valorCentimos - comissaoCentimos) / 100
    });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// ── MAPBOX PROXY (evita CORS no browser) ──
const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const MAPBOX_TOKEN = 'pk.eyJ1IjoiZ3J1cG9jYXJnb2xpbmsiLCJhIjoiY21tcm8xOWcyMHYzMTJwcjJzZzR3bnl4dyJ9.qTPo14zk0sMUXlw7lj67Vg';

app.get('/geo/autocomplete', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ erro: 'Query obrigatória' });
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${MAPBOX_TOKEN}&autocomplete=true&language=pt&country=pt,es,fr,de,gb,nl,be&types=address,place,poi&limit=5`;
    const d = await httpsGet(url);
    res.json(d);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get('/geo/route', async (req, res) => {
  const { oLng, oLat, dLng, dLat } = req.query;
  if (!oLng || !oLat || !dLng || !dLat) return res.status(400).json({ erro: 'Coordenadas obrigatórias' });
  try {
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${oLng},${oLat};${dLng},${dLat}?access_token=${MAPBOX_TOKEN}&geometries=geojson&overview=full&language=pt`;
    const d = await httpsGet(url);
    res.json(d);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CargoLink Backend v2.0 na porta ${PORT}`));
