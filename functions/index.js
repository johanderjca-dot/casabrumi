const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

// Se configura una sola vez con: firebase functions:secrets:set SHOPIFY_WEBHOOK_SECRET
// Nunca vive en el código — Firebase lo inyecta como variable de entorno en tiempo de ejecución.
const SHOPIFY_WEBHOOK_SECRET = defineSecret('SHOPIFY_WEBHOOK_SECRET');

function verificarHmac(req, secret) {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    if (!hmacHeader || !req.rawBody) return false;
    const hash = crypto.createHmac('sha256', secret).update(req.rawBody).digest('base64');
    try {
        return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
    } catch {
        return false; // largos distintos -> no es válido
    }
}

// Recibe orders/create y orders/updated de Shopify y guarda/actualiza el pedido en Firestore.
// El mismo endpoint sirve para ambos topics: siempre refleja el estado ACTUAL del pedido
// (pago, preparación, cancelación, etc.), sin importar qué evento disparó el envío.
exports.shopifyWebhook = onRequest({ secrets: [SHOPIFY_WEBHOOK_SECRET], region: 'us-central1', cors: false, invoker: 'public' }, async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).send('Method not allowed');
        return;
    }

    if (!verificarHmac(req, SHOPIFY_WEBHOOK_SECRET.value())) {
        console.error('HMAC inválido — request rechazado');
        res.status(401).send('Invalid signature');
        return;
    }

    const topic = req.get('X-Shopify-Topic') || '';
    const shopDomain = req.get('X-Shopify-Shop-Domain') || '';
    const order = req.body;

    if (!order || !order.id) {
        res.status(400).send('Payload sin order.id');
        return;
    }

    try {
        const nombreCliente = order.customer
            ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim()
            : (order.email || '—');

        const doc = {
            shopifyId: String(order.id),
            shopDomain,
            numero: order.name || (order.order_number ? `#${order.order_number}` : String(order.id)),
            fechaShopify: order.created_at || null,
            cliente: nombreCliente || '—',
            total: parseFloat(order.total_price || 0),
            moneda: order.currency || 'USD',
            canal: order.source_name || '—',
            estadoPago: order.financial_status || '—',
            estadoPreparacion: order.fulfillment_status || 'unfulfilled',
            formaEntrega: (order.shipping_lines && order.shipping_lines[0] && order.shipping_lines[0].title) || '—',
            etiquetas: order.tags || '',
            articulos: (order.line_items || []).length,
            productos: (order.line_items || []).map(li => ({
                nombre: li.title || li.name || '—',
                cantidad: li.quantity || 1,
                sku: li.sku || '',
            })),
            cancelado: !!order.cancelled_at,
            ultimoTopic: topic,
            actualizadoEn: admin.firestore.FieldValue.serverTimestamp(),
        };

        await db.collection('pedidos_shopify').doc(String(order.id)).set(doc, { merge: true });
        res.status(200).send('OK');
    } catch (err) {
        console.error('Error guardando pedido de Shopify:', err);
        res.status(500).send('Error interno');
    }
});
