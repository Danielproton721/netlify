/**
 * Netlify Function: pix-backend-function
 * 
 * Este é o código de BACKEND SEGURO.
 * Ele usa as Variáveis de Ambiente do Netlify para autenticar na Instapay
 * e criar a cobrança PIX, retornando o QR Code e o código PIX.
 * 
 * ⚠️ Este arquivo DEVE ser colocado em 'netlify/functions/pix-backend-function.js'
 */

const fetch = require('node-fetch');

// Credenciais lidas de forma segura das Variáveis de Ambiente do Netlify
const CLIENT_ID = process.env.INSTAPAY_CLIENT_ID;
const CLIENT_SECRET = process.env.INSTAPAY_CLIENT_SECRET;
const API_URL = 'https://api.instapaybr.com';

// Variável para armazenar o token JWT e evitar autenticação repetida
let cachedToken = null;
let tokenExpiry = null;

/**
 * Função auxiliar para autenticar na Instapay e obter o token JWT.
 */
async function authenticate() {
    // 1. Verificar se o token em cache ainda é válido
    if (cachedToken && tokenExpiry && new Date() < tokenExpiry) {
        return cachedToken;
    }

    // 2. Verificar se as credenciais estão configuradas
    if (!CLIENT_ID || !CLIENT_SECRET) {
        throw new Error("Credenciais da Instapay (INSTAPAY_CLIENT_ID ou INSTAPAY_CLIENT_SECRET) não configuradas nas Variáveis de Ambiente do Netlify.");
    }

    // 3. Fazer a requisição de autenticação
    const response = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET
        })
    });

    // 4. Tratar a resposta
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Falha na autenticação (Status ${response.status}): ${errorText}`);
    }

    const data = await response.json();
    
    // O token pode vir como 'token' ou 'access_token' dependendo da API
    const token = data.token || data.access_token;

    if (!token) {
        throw new Error("Resposta de autenticação não contém token JWT.");
    }

    // 5. Armazenar o token em cache (expira em 55 minutos, por exemplo)
    cachedToken = token;
    tokenExpiry = new Date(Date.now() + 55 * 60 * 1000); 

    return cachedToken;
}

/**
 * Função principal da Netlify Function.
 */
exports.handler = async (event, context) => {
    // A função só deve responder a requisições POST
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: "Método não permitido. Use POST." })
        };
    }

    // Adicionar cabeçalhos CORS para permitir acesso do frontend
    const headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    };

    // Tratar requisições OPTIONS (pré-voo CORS)
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: headers,
            body: ''
        };
    }

    try {
        // 1. Obter os dados do corpo da requisição (enviados pelo frontend)
        const { amount, external_id, payer } = JSON.parse(event.body);

        if (!amount || !external_id || !payer) {
            return {
                statusCode: 400,
                headers: headers,
                body: JSON.stringify({ error: "Dados incompletos. Requer: amount, external_id e payer." })
            };
        }

        // 2. Autenticar e obter o token JWT
        const token = await authenticate();

        // 3. Criar a cobrança PIX (Deposit)
        const depositResponse = await fetch(`${API_URL}/api/payments/deposit`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                amount: amount,
                external_id: external_id,
                // ⚠️ clientCallbackUrl deve ser um endpoint de backend/webhook real
                clientCallbackUrl: `https://${event.headers.host}/.netlify/functions/pix-webhook`, 
                payer: payer
            })
        });

        // 4. Tratar a resposta da criação do depósito
        let depositData;
        try {
            depositData = await depositResponse.json();
        } catch (e) {
            // Se a resposta não for JSON, isso é um erro grave
            const errorText = await depositResponse.text();
            throw new Error(`Resposta da API de Depósito não é JSON. Status: ${depositResponse.status}. Resposta: ${errorText}`);
        }

        if (!depositResponse.ok) {
            // Retorna o erro da API da Instapay
            return {
                statusCode: depositResponse.status,
                headers: headers,
                body: JSON.stringify({ 
                    error: depositData.error || depositData.message || "Erro desconhecido ao criar depósito na Instapay.",
                    details: depositData
                })
            };
        }

        // 5. Retornar os dados do PIX para o frontend
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({
                transaction_id: depositData.transaction_id,
                qr_code_image: depositData.qr_code_image,
                pix_code: depositData.pix_code,
                // Outros dados úteis
                status: depositData.status
            })
        };

    } catch (error) {
        console.error("Erro na Netlify Function:", error.message);
        
        // Garante que a função sempre retorne um JSON válido em caso de falha.
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({ 
                error: "Erro interno do servidor ao processar PIX.",
                details: error.message 
            })
        };
    }
};
